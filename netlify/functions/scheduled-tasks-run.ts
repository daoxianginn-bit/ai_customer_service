import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import { parseCsvKeywords } from '../../src/lib/messageVariables';
import { computeNextRunAt, ScheduleConfig } from '../../src/lib/scheduleRecurrence';
import { OCCUPYING_STATUSES } from '../../src/lib/bookingStatus';

// ========================================================================
// 排程執行器（ticker）
//
// Netlify 排程函式的時間是部署時寫死在 netlify.toml，後台無法動態改，所以這支函式
// 固定每 15 分鐘跑一次，檢查「排程管理」頁設定的 scheduled_tasks 裡有哪些到期了、
// 依 task_type 執行對應邏輯，執行完再用 computeNextRunAt() 算下一次時間寫回去。
//
// 新增排程類型：在 TASK_EXECUTORS 裡加一個 key，回傳 { ok, summary } 即可，
// 不需要改這支函式的其他部分或資料表結構（各類型專屬參數放在 scheduled_tasks.config）。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

type TaskExecutor = (config: Record<string, any>, settings: any) => Promise<{ ok: boolean; summary: string }>;

// 客戶用官方帳號的憑證。客服的 agent_user_ids 是這個帳號底下的 user ID，
// 推播給客服一律要用它（LINE user ID 跨官方帳號不通用）。
async function fetchCustomerChannel(): Promise<any | null> {
  const { data } = await supabase
    .from('line_channels')
    .select('*')
    .eq('role', 'customer')
    .eq('is_active', true)
    .order('display_order')
    .limit(1)
    .maybeSingle();
  return data || null;
}

// 取消逾期未匯款的訂單：status='awaiting_deposit' 且 payment_deadline_at 已過的訂單改成 cancelled。
// 罐頭訊息裡寫「系統將自動取消訂房，不另行通知」是指不通知顧客本人，但客服還是要知道發生了什麼事，
// 所以會推播給 agent_user_ids。
async function cancelUnpaidBookings(_config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const nowIso = new Date().toISOString();
  const { data: overdue, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname')
    .eq('status', 'awaiting_deposit')
    .lt('payment_deadline_at', nowIso);

  if (error) return { ok: false, summary: `查詢逾期訂單失敗：${error.message}` };
  if (!overdue || !overdue.length) return { ok: true, summary: '沒有逾期未匯款的訂單' };

  let cancelled = 0;
  const cancelledList: string[] = [];
  for (const booking of overdue) {
    const { error: updateError } = await supabase
      .from('bookings')
      .update({ status: 'cancelled', updated_at: nowIso })
      .eq('id', booking.id);
    if (updateError) continue;
    cancelled++;
    cancelledList.push(`${booking.order_number || booking.id}（${booking.name || booking.nickname || '未知'}）`);
  }

  if (cancelled > 0) {
    // agent_user_ids 是客服在「客戶用官方帳號」底下的 user ID，一定要用該帳號的憑證推播
    const customerChannel = await fetchCustomerChannel();
    if (customerChannel?.channel_access_token) {
      try {
        const lineClient = new Client({
          channelAccessToken: customerChannel.channel_access_token,
          channelSecret: customerChannel.channel_secret,
        });
        const text = `⏰ 排程自動取消 ${cancelled} 筆逾期未匯款訂單：\n${cancelledList.join('\n')}`;
        for (const id of parseCsvKeywords(settings.agent_user_ids)) {
          try { await lineClient.pushMessage(id, { type: 'text', text }); } catch {}
        }
      } catch (e: any) {
        console.error('[ScheduledTasks] agent notify failed:', e.message);
      }
    }
  }

  return { ok: true, summary: `取消了 ${cancelled} 筆逾期未匯款訂單` };
}

// 訂單完成（退房後）統計推播：把已經退房的訂單整理成一份統計，推給「廠商用」與「團隊內部用」
// 官方帳號的所有聯絡人。
//
// 為什麼以退房日為準而不是「已確認」：已確認只代表款項收齊，客人還沒真的住完；
// 中途取消或改期都還可能發生，那時候發出去的統計就是錯的。退房日過了才算真正完成。
//
// 每筆訂單只推一次，靠 bookings.completion_notified_at 記錄。沒有這個欄位的話，
// 這支排程每 15 分鐘跑一次就會重複轟炸廠商。
async function notifyCheckoutCompleted(_config: Record<string, any>): Promise<{ ok: boolean; summary: string }> {
  const today = new Date();
  const todayIso = new Date(today.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); // 台灣日期

  const { data: completed, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, headcount, room_type_label, room_amount, total_amount, status')
    .lt('checkout_date', todayIso)
    .is('completion_notified_at', null)
    .in('status', OCCUPYING_STATUSES)
    .order('checkout_date');

  if (error) return { ok: false, summary: `查詢已退房訂單失敗：${error.message}` };
  if (!completed?.length) return { ok: true, summary: '沒有新的已退房訂單需要推播' };

  const { data: channels } = await supabase
    .from('line_channels')
    .select('*')
    .eq('is_active', true)
    .in('role', ['vendor', 'internal']);

  if (!channels?.length) {
    // 沒有設定接收帳號時不要標記成已推播，否則之後補設定了也收不到這批。
    return { ok: true, summary: `有 ${completed.length} 筆已退房訂單，但尚未設定廠商／內部官方帳號，暫不推播` };
  }

  const totalRoomAmount = completed.reduce((sum, b) => sum + Number(b.room_amount ?? 0), 0);
  const totalHeadcount = completed.reduce((sum, b) => sum + Number(b.headcount ?? 0), 0);
  const lines = completed.map(
    (b) =>
      `・${b.order_number || b.id.slice(0, 8)}　${b.name || b.nickname || '未知'}　` +
      `${b.checkin_date}~${b.checkout_date}　${b.headcount ?? '?'}人　${b.room_type_label || ''}`
  );
  const text =
    `📋 訂單完成統計（截至 ${todayIso}）\n` +
    `共 ${completed.length} 筆已退房訂單、合計 ${totalHeadcount} 人次、房價合計 NT$${totalRoomAmount.toLocaleString()}\n\n` +
    lines.join('\n');

  let pushed = 0;
  for (const channel of channels) {
    if (!channel.channel_access_token) continue;
    const client = new Client({
      channelAccessToken: channel.channel_access_token,
      channelSecret: channel.channel_secret,
    });
    // 推給這個官方帳號底下所有聯絡人（LINE user ID 是各帳號獨立的，一定要照 channel 撈）
    const { data: contacts } = await supabase
      .from('user_states')
      .select('line_user_id')
      .eq('channel_id', channel.id);
    for (const c of contacts || []) {
      try {
        await client.pushMessage(c.line_user_id, { type: 'text', text });
        pushed++;
      } catch (e: any) {
        console.error(`[Completion] push failed (${channel.name}):`, e.message);
      }
    }
  }

  // 推播成功過才標記，避免完全推不出去卻被當成已完成。
  if (pushed > 0) {
    const nowIso = new Date().toISOString();
    await supabase
      .from('bookings')
      .update({ completion_notified_at: nowIso })
      .in('id', completed.map((b) => b.id));
  }

  return { ok: true, summary: `推播 ${completed.length} 筆已退房訂單統計給 ${pushed} 位收件人` };
}

const TASK_EXECUTORS: Record<string, TaskExecutor> = {
  cancel_unpaid_bookings: cancelUnpaidBookings,
  notify_checkout_completed: notifyCheckoutCompleted,
};

function toScheduleConfig(task: any): ScheduleConfig {
  return {
    recurrence: task.recurrence,
    runAtTime: task.run_at_time,
    runAtDate: task.run_at_date,
    weekday: task.weekday,
    dayOfMonth: task.day_of_month,
  };
}

export const handler: Handler = async () => {
  const { data: settings } = await supabase.from('settings').select('*').single();
  if (!settings) return { statusCode: 200, body: 'settings not found, skipped' };

  const nowIso = new Date().toISOString();
  const { data: dueTasks, error } = await supabase
    .from('scheduled_tasks')
    .select('*')
    .eq('is_active', true)
    .lte('next_run_at', nowIso);

  if (error) {
    console.error('[ScheduledTasks] query due tasks failed:', error.message);
    return { statusCode: 500, body: error.message };
  }
  if (!dueTasks || !dueTasks.length) return { statusCode: 200, body: 'no due tasks' };

  for (const task of dueTasks) {
    const executor = TASK_EXECUTORS[task.task_type];
    let result: { ok: boolean; summary: string };
    if (!executor) {
      result = { ok: false, summary: `未知的排程類型：${task.task_type}` };
    } else {
      try {
        result = await executor(task.config || {}, settings);
      } catch (e: any) {
        result = { ok: false, summary: `執行失敗：${e.message}` };
      }
    }

    const runFinishedMs = Date.now();
    const nextRunAt = task.recurrence === 'once' ? null : computeNextRunAt(toScheduleConfig(task), runFinishedMs);

    await supabase
      .from('scheduled_tasks')
      .update({
        last_run_at: nowIso,
        last_run_status: result.ok ? 'success' : 'failed',
        last_run_summary: result.summary,
        next_run_at: nextRunAt ? nextRunAt.toISOString() : null,
        is_active: task.recurrence === 'once' ? false : task.is_active,
        updated_at: nowIso,
      })
      .eq('id', task.id);

    console.log(`[ScheduledTasks] ${task.name} (${task.task_type}): ${result.summary}`);
  }

  return { statusCode: 200, body: `processed ${dueTasks.length} task(s)` };
};

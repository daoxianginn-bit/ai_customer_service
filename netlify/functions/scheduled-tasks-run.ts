import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import { parseCsvKeywords } from '../../src/lib/messageVariables';
import { computeNextRunAt, ScheduleConfig } from '../../src/lib/scheduleRecurrence';

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

// 取消逾期未匯款的訂單：status='awaiting_deposit' 且 payment_deadline_at 已過的訂單改成 cancelled。
// 罐頭訊息裡寫「系統將自動取消訂房，不另行通知」是指不通知顧客本人，但客服還是要知道發生了什麼事，
// 所以會推播給 agent_user_ids；沒有另外鏡射寫入 Google 試算表（那份邏輯整包在 line-webhook.ts，
// 這裡不重複維護一份，試算表本來就是「盡力而為」的備份，下次該訂單被其他流程碰到時仍會補鏡射一次）。
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

  if (cancelled > 0 && settings.line_channel_access_token) {
    try {
      const lineClient = new Client({ channelAccessToken: settings.line_channel_access_token, channelSecret: settings.line_channel_secret });
      const text = `⏰ 排程自動取消 ${cancelled} 筆逾期未匯款訂單：\n${cancelledList.join('\n')}`;
      for (const id of parseCsvKeywords(settings.agent_user_ids)) {
        try { await lineClient.pushMessage(id, { type: 'text', text }); } catch {}
      }
    } catch (e: any) {
      console.error('[ScheduledTasks] agent notify failed:', e.message);
    }
  }

  return { ok: true, summary: `取消了 ${cancelled} 筆逾期未匯款訂單` };
}

const TASK_EXECUTORS: Record<string, TaskExecutor> = {
  cancel_unpaid_bookings: cancelUnpaidBookings,
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

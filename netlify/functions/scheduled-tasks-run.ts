import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import { randomUUID, createSign } from 'crypto';
import { parseCsvKeywords, buildMergeFields, MessageVariable } from '../../src/lib/messageVariables';
import { computeNextRunAt, ScheduleConfig } from '../../src/lib/scheduleRecurrence';
import { OCCUPYING_STATUSES, BALANCE_PAID_STATUSES } from '../../src/lib/bookingStatus';
import { parseIcsEvents } from '../../src/lib/icsParser';
import { otaPlatformLabel } from '../../src/lib/otaChannels';
import { classifyOtaEvent } from '../../src/lib/otaEventFilter';
import { processWaitlist } from './line-webhook';

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

// 取消逾期未匯款的訂單：status='awaiting_confirmation' 且 payment_deadline_at 已過的訂單改成 cancelled。
// 2026-08 改版後，payment_deadline_at 是客人回「是」的當下才寫入（見 handleBookingConfirmation()），
// 那個時間點狀態已經是「待確認」不是「待預定」——「待預定」現在代表「報價已送出、還在等客人回是否要訂」，
// 客人根本還沒確認要訂，沒有匯款期限可言，不該被這個排程碰到。
// 罐頭訊息裡寫「系統將自動取消訂房，不另行通知」是指不通知顧客本人，但客服還是要知道發生了什麼事，
// 所以會推播給 agent_user_ids。
async function cancelUnpaidBookings(_config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const nowIso = new Date().toISOString();
  const { data: overdue, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname')
    .eq('status', 'awaiting_confirmation')
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

// ========================================================================
// 訂單狀態自動轉換排程（三個時間點各自獨立，各自對應一種狀態轉換）
// ========================================================================

function taiwanTodayIso(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// 已預定(reserved) → 待收尾款(awaiting_balance)：今天 = 入住日 - 3 天。00:00 執行。
async function advanceToAwaitingBalance(): Promise<{ ok: boolean; summary: string }> {
  const targetCheckin = addDaysIso(taiwanTodayIso(), 3);
  const { data, error } = await supabase.from('bookings').select('id').eq('status', 'reserved').eq('checkin_date', targetCheckin);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有需要轉為待收尾款的訂單' };
  const { error: updateError } = await supabase.from('bookings').update({ status: 'awaiting_balance', updated_at: new Date().toISOString() }).in('id', data.map((b) => b.id));
  if (updateError) return { ok: false, summary: `更新失敗：${updateError.message}` };
  return { ok: true, summary: `${data.length} 筆訂單已轉為待收尾款` };
}

// 待入住(awaiting_checkin) → 入住中(checked_in)：今天 = 入住日。下午 1 點執行。
async function advanceToCheckedIn(): Promise<{ ok: boolean; summary: string }> {
  const today = taiwanTodayIso();
  const { data, error } = await supabase.from('bookings').select('id').eq('status', 'awaiting_checkin').eq('checkin_date', today);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有今日入住、需要轉為入住中的訂單' };
  const { error: updateError } = await supabase.from('bookings').update({ status: 'checked_in', updated_at: new Date().toISOString() }).in('id', data.map((b) => b.id));
  if (updateError) return { ok: false, summary: `更新失敗：${updateError.message}` };
  return { ok: true, summary: `${data.length} 筆訂單已轉為入住中` };
}

// 入住中(checked_in) → 押金處理(deposit_processing)：今天 = 退房日。中午 12 點執行。
async function advanceToDepositProcessing(): Promise<{ ok: boolean; summary: string }> {
  const today = taiwanTodayIso();
  const { data, error } = await supabase.from('bookings').select('id').eq('status', 'checked_in').eq('checkout_date', today);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有今日退房、需要轉為押金處理的訂單' };
  const { error: updateError } = await supabase.from('bookings').update({ status: 'deposit_processing', updated_at: new Date().toISOString() }).in('id', data.map((b) => b.id));
  if (updateError) return { ok: false, summary: `更新失敗：${updateError.message}` };
  return { ok: true, summary: `${data.length} 筆訂單已轉為押金處理` };
}

// ========================================================================
// 通知排程共用小工具
// ========================================================================

function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) result = result.split(`[${key}]`).join(value ?? '');
  return result;
}

async function fetchTemplateBody(templateId?: string): Promise<string | null> {
  if (!templateId) return null;
  const { data } = await supabase.from('custom_message_templates').select('body').eq('id', templateId).maybeSingle();
  return data?.body ?? null;
}

async function fetchMessageVariablesList(): Promise<MessageVariable[]> {
  const { data } = await supabase.from('message_variables').select('variable_name, source, field_key').order('display_order');
  return (data || []) as MessageVariable[];
}

async function fetchNotificationGroup(groupId?: string): Promise<any | null> {
  if (!groupId) return null;
  const { data } = await supabase.from('notification_recipient_groups').select('*').eq('id', groupId).maybeSingle();
  return data || null;
}

// 直接推播給訂單本人（客戶用帳號），依「訊息變數資料維護」的設定把範本裡的 [變數] 換成這張訂單的資料——
// 跟 LINE 自動訂房流程的報價/確認訊息用同一套合併欄位系統，管理員在別處學過的變數在這裡一樣能用。
// 沒設定範本就整批略過，不用猜一份預設文字硬發給客人。
async function pushToCustomersWithTemplate(
  bookings: any[],
  templateId: string | undefined,
  settings: any,
  extraFields?: (b: any) => Record<string, string>
): Promise<{ pushed: number; failed: number; skippedNoTemplate: boolean }> {
  const templateBody = await fetchTemplateBody(templateId);
  if (!templateBody) return { pushed: 0, failed: 0, skippedNoTemplate: true };

  const [variables, customerChannel] = await Promise.all([fetchMessageVariablesList(), fetchCustomerChannel()]);
  if (!customerChannel?.channel_access_token) return { pushed: 0, failed: bookings.length, skippedNoTemplate: false };

  const client = new Client({ channelAccessToken: customerChannel.channel_access_token, channelSecret: customerChannel.channel_secret });
  let pushed = 0;
  let failed = 0;
  for (const b of bookings) {
    if (!b.line_user_id) { failed++; continue; }
    const fields = {
      ...buildMergeFields(variables, { booking: b, customer: { nickname: b.nickname, line_user_id: b.line_user_id }, settings }),
      ...(extraFields ? extraFields(b) : {}),
    };
    const text = mergeTemplate(templateBody, fields);
    try {
      await client.pushMessage(b.line_user_id, { type: 'text', text });
      pushed++;
    } catch (e: any) {
      console.error('[ScheduledTasks] customer push failed:', e.message);
      failed++;
    }
  }
  return { pushed, failed, skippedNoTemplate: false };
}

// 推播一份彙整清單給某個通知名單（不是單一客人）——格式固定（標題＋筆數＋逐行清單），
// 比照既有的 notify_checkout_completed 寫法，不走 buildMergeFields：這些訊息本來就是「這批訂單的
// 狀態報告」，不是針對單一顧客資料客製化的訊息，用固定格式反而比硬套變數系統更清楚好維護。
async function pushSummaryToGroup(
  bookings: any[],
  groupId: string | undefined,
  title: string,
  lineFormatter: (b: any) => string
): Promise<{ pushed: number; skipped: string | null }> {
  if (!groupId) return { pushed: 0, skipped: '尚未設定通知名單' };
  const group = await fetchNotificationGroup(groupId);
  if (!group) return { pushed: 0, skipped: '通知名單不存在或已被刪除' };
  if (!group.line_user_ids?.length) return { pushed: 0, skipped: '通知名單裡沒有任何聯絡人' };

  const { data: channel } = await supabase.from('line_channels').select('*').eq('id', group.channel_id).maybeSingle();
  if (!channel?.channel_access_token) return { pushed: 0, skipped: '通知名單所屬官方帳號憑證未設定' };

  const text = `${title}\n共 ${bookings.length} 筆\n\n${bookings.map(lineFormatter).join('\n')}`;
  const client = new Client({ channelAccessToken: channel.channel_access_token, channelSecret: channel.channel_secret });
  let pushed = 0;
  for (const id of group.line_user_ids) {
    try {
      await client.pushMessage(id, { type: 'text', text });
      pushed++;
    } catch (e: any) {
      console.error('[ScheduledTasks] group push failed:', e.message);
    }
  }
  return { pushed, skipped: null };
}

// ========================================================================
// 通知排程（六種）
// config.template_id：直接通知客人用的「客製訊息範本」（custom_message_templates.id）。
// config.notification_group_id：彙整通知用的「通知名單」（notification_recipient_groups.id）。
// ========================================================================

// 尾款排程：入住日在「今天～今天+2天」內、狀態仍是待收尾款的訂單。
// 同時做兩件事：(1) 直接提醒客人本人繳尾款 (2) 把整批清單彙整通知給通知名單，方便客服追。
async function balanceReminder(config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const today = taiwanTodayIso();
  const until = addDaysIso(today, 2);
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, line_user_id, checkin_date, checkout_date, headcount, room_type_label, total_amount, deposit, status')
    .eq('status', 'awaiting_balance')
    .gte('checkin_date', today)
    .lte('checkin_date', until);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有 3 天內入住、尚未收尾款的訂單' };

  const direct = await pushToCustomersWithTemplate(data, config.template_id, settings);
  const group = await pushSummaryToGroup(
    data,
    config.notification_group_id,
    '💰 尾款提醒：以下訂單即將入住，尚未收到尾款',
    (b) => `・${b.order_number || b.id.slice(0, 8)}　${b.name || b.nickname || '未知'}　${b.checkin_date}~${b.checkout_date}`
  );

  const parts = [`${data.length} 筆符合條件`];
  parts.push(direct.skippedNoTemplate ? '未設定客人提醒範本，略過直接通知' : `直接通知客人 ${direct.pushed} 位成功、${direct.failed} 位失敗`);
  parts.push(group.skipped ? group.skipped : `名單通知 ${group.pushed} 位`);
  return { ok: true, summary: parts.join('；') };
}

// 待預定回覆提醒：客戶用帳號底下，狀態仍是待預定（報價已送出、客人還沒回是否要訂）、
// 且是「昨天」建立的訂單——提醒客人記得回覆是否要訂房，不是提醒匯款（匯款期限是回「是」之後才開始算，
// 見 line-webhook.ts 的 handleBookingConfirmation()）。這裡沿用 deposit_awaiting_notice 這個
// task_type 值不改名，避免已經設定好的排程失效；管理員如果之前用「提醒匯款」的措辭寫過訊息範本，
// 這次改版後要記得把範本內容改成「提醒回覆」的措辭。
async function depositAwaitingNotice(config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const yesterday = addDaysIso(taiwanTodayIso(), -1);
  const today = taiwanTodayIso();
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, line_user_id, checkin_date, checkout_date, total_amount, deposit, status, created_at')
    .eq('status', 'awaiting_deposit')
    .gte('created_at', `${yesterday}T00:00:00+08:00`)
    .lt('created_at', `${today}T00:00:00+08:00`);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有昨天建立、仍待預定的訂單' };

  const result = await pushToCustomersWithTemplate(data, config.template_id, settings);
  if (result.skippedNoTemplate) return { ok: true, summary: `${data.length} 筆符合條件，但尚未設定訊息範本，略過發送` };
  return { ok: true, summary: `${data.length} 筆符合條件，通知客人 ${result.pushed} 位成功、${result.failed} 位失敗` };
}

// 待確認訂單通知：客戶用帳號底下，客人已回覆確認要訂房、待客服核對匯款的訂單，彙整通知給通知名單。
// 客人不一定已經回報匯款末五碼（那是選填的後續動作，見 handleRemittanceReport()），
// 沒提供的話下面的推播訊息會顯示「未提供」，客服要自己去對帳戶核對有沒有收到這筆款項。
//
// 訂單建立時間為昨天、狀態仍是待確認的，另外直接推播提醒客人本人記得完成匯款。這件事原本是
// 「待預定匯款通知」（deposit_awaiting_notice）在做，但 2026-08 那次改版把「待預定」的意思
// 改成「客人還沒確認要不要訂」，已經不適合拿來提醒匯款；「待確認」才是「客人已經確認、
// 等核對到帳」，所以直接提醒客人這個動作搬到這裡——待預定回覆提醒維持原本的用途不變
// （提醒客人記得回覆是否要訂房），兩者分工不同、不是互相取代。
async function awaitingConfirmationNotice(config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, remit_last5')
    .eq('status', 'awaiting_confirmation')
    .order('updated_at');
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };

  const parts: string[] = [];
  if (!data?.length) {
    parts.push('沒有待確認的訂單');
  } else {
    const result = await pushSummaryToGroup(
      data,
      config.notification_group_id,
      '📋 待確認訂單通知：以下訂單客人已確認要訂房，待核對匯款到帳',
      (b) => `・${b.order_number || b.id.slice(0, 8)}　${b.name || b.nickname || '未知'}　末五碼:${b.remit_last5 || '未提供'}`
    );
    parts.push(result.skipped ? `${data.length} 筆待確認訂單，${result.skipped}` : `${data.length} 筆待確認訂單，通知 ${result.pushed} 位`);
  }

  const yesterday = addDaysIso(taiwanTodayIso(), -1);
  const today = taiwanTodayIso();
  const { data: createdYesterday, error: cyError } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, line_user_id, checkin_date, checkout_date, total_amount, deposit, status, created_at')
    .eq('status', 'awaiting_confirmation')
    .gte('created_at', `${yesterday}T00:00:00+08:00`)
    .lt('created_at', `${today}T00:00:00+08:00`);

  if (cyError) {
    parts.push(`查詢昨天建立的待確認訂單失敗：${cyError.message}`);
  } else if (createdYesterday?.length) {
    const direct = await pushToCustomersWithTemplate(createdYesterday, config.template_id, settings);
    parts.push(
      direct.skippedNoTemplate
        ? `${createdYesterday.length} 筆昨天建立、仍待確認，但尚未設定客人提醒範本，略過發送`
        : `${createdYesterday.length} 筆昨天建立、仍待確認，提醒客人 ${direct.pushed} 位成功、${direct.failed} 位失敗`
    );
  }

  return { ok: true, summary: parts.join('；') };
}

// 入住排程：狀態為待入住、且入住日就是今天的訂單，通知客人本人（含入住密碼——這是唯一會把
// check_in_password 帶進訊息的地方，走 [入住密碼] 這個特殊變數，不透過一般的欄位白名單機制，
// 見 messageVariables.ts 的 ALWAYS_AVAILABLE_VARIABLES 說明）。
async function checkinNotice(config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const today = taiwanTodayIso();
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, line_user_id, checkin_date, checkout_date, room_type_label, check_in_password')
    .eq('status', 'awaiting_checkin')
    .eq('checkin_date', today);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有今日入住的訂單' };

  const result = await pushToCustomersWithTemplate(data, config.template_id, settings, (b) => ({ 入住密碼: b.check_in_password || '（尚未設定，請聯繫客服）' }));
  if (result.skippedNoTemplate) return { ok: true, summary: `${data.length} 筆今日入住，但尚未設定訊息範本，略過發送` };
  return { ok: true, summary: `${data.length} 筆今日入住，通知客人 ${result.pushed} 位成功、${result.failed} 位失敗` };
}

// 押金處理通知：客戶用帳號底下，狀態為押金處理中的訂單，彙整通知給通知名單去核對退還。
async function depositProcessingNotice(config: Record<string, any>): Promise<{ ok: boolean; summary: string }> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, security_deposit')
    .eq('status', 'deposit_processing')
    .order('checkout_date');
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有押金處理中的訂單' };

  const result = await pushSummaryToGroup(
    data,
    config.notification_group_id,
    '💵 押金處理通知：以下訂單已退房，待核對退還押金',
    (b) => `・${b.order_number || b.id.slice(0, 8)}　${b.name || b.nickname || '未知'}　押金:NT$${Number(b.security_deposit ?? 0).toLocaleString()}`
  );
  return { ok: true, summary: result.skipped ? `${data.length} 筆押金處理中，${result.skipped}` : `${data.length} 筆押金處理中，通知 ${result.pushed} 位` };
}

// 洗滌排程：狀態為押金處理、且退房日就是今天的訂單（跟「入住中→押金處理」排程同一天觸發），
// 通知布巾洗滌相關人員安排送洗。
async function laundryNotice(config: Record<string, any>): Promise<{ ok: boolean; summary: string }> {
  const today = taiwanTodayIso();
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, room_type_label, linen_change_count')
    .eq('status', 'deposit_processing')
    .eq('checkout_date', today);
  if (error) return { ok: false, summary: `查詢失敗：${error.message}` };
  if (!data?.length) return { ok: true, summary: '沒有今日退房、需要洗滌的訂單' };

  const result = await pushSummaryToGroup(
    data,
    config.notification_group_id,
    '🧺 洗滌排程：以下訂單今日退房，請安排布巾洗滌',
    (b) => `・${b.order_number || b.id.slice(0, 8)}　${b.name || b.nickname || '未知'}　${b.room_type_label || ''}　換洗${b.linen_change_count ?? 1}次`
  );
  return { ok: true, summary: result.skipped ? `${data.length} 筆今日退房需洗滌，${result.skipped}` : `${data.length} 筆今日退房需洗滌，通知 ${result.pushed} 位` };
}

// ========================================================================
// OTA 平台 iCal 匯入排程（sync_ota_calendars）
//
// 抓取所有啟用中、有設定 import_ics_url 的 ota_channels，解析後跟 bookings 做 upsert：
//   - external_channel_id + external_uid 是這筆外部事件在本系統的穩定識別鍵（見 schema 的
//     partial unique index：idx_bookings_external_uid），同一個 UID 再次匯入只更新日期，
//     不會重複建立。
//   - 來源事件消失（平台那邊取消了）時，把對應的 bookings 列改成 cancelled——沿用一般
//     「取消」語意，不整批刪除，保留歷史紀錄可查。
//   - 匯入的日期跟其他現有訂單（不分來源，含其他 OTA 頻道）重疊時，只推播提醒
//     agent_user_ids，不自動處理——雙重預訂的實際狀況需要人工核實是哪一邊要改，
//     系統不擅自取消任何一方。只在「新建立」或「日期變動」時檢查一次，避免同一筆
//     沒有變化的既有衝突每次排程執行都重複轟炸客服。
// ========================================================================

// 跟 line-webhook.ts 的 checkBookingConflict 同一套邏輯（日期重疊 + whole_house/booking_rooms
// 房型比對），這裡另外排除自己這筆（更新既有匯入事件時，不該把自己算成衝突對象）。
// 回傳撞到的那一筆訂單 id（沒撞到就是 null）——要記進 bookings.ota_conflict_with 供人工查核，
// 所以不能只回傳 true/false。
async function checkOtaConflict(channel: any, ev: { startIso: string; endIso: string }, selfBookingId: string | null): Promise<string | null> {
  let query = supabase
    .from('bookings')
    .select('id, whole_house')
    .in('status', OCCUPYING_STATUSES)
    .lt('checkin_date', ev.endIso)
    .gt('checkout_date', ev.startIso);
  if (selfBookingId) query = query.neq('id', selfBookingId);
  const { data: overlapping } = await query;
  if (!overlapping?.length) return null;

  if (!channel.room_type_id) return overlapping[0].id; // 整棟頻道：任何日期重疊都算衝突
  const wholeHouseHit = overlapping.find((b: any) => b.whole_house);
  if (wholeHouseHit) return wholeHouseHit.id;

  const individualIds = overlapping.filter((b: any) => !b.whole_house).map((b: any) => b.id);
  if (!individualIds.length) return null;
  const { data: roomLinks } = await supabase
    .from('booking_rooms')
    .select('booking_id')
    .eq('room_type_id', channel.room_type_id)
    .in('booking_id', individualIds);
  return roomLinks?.length ? roomLinks[0].booking_id : null;
}

async function syncOneOtaChannel(channel: any): Promise<{ summary: string; conflictLines: string[] }> {
  const nowIso = new Date().toISOString();
  let icsText: string;
  try {
    const res = await fetch(channel.import_ics_url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    icsText = await res.text();
  } catch (e: any) {
    const msg = `抓取失敗：${e.message}`;
    await supabase.from('ota_channels').update({ last_imported_at: nowIso, last_import_status: 'failed', last_import_summary: msg }).eq('id', channel.id);
    return { summary: `${channel.name}：${msg}`, conflictLines: [] };
  }

  const allEvents = parseIcsEvents(icsText);

  // 只收「該平台真正成立的訂單」，關房事件一律忽略（見 src/lib/otaEventFilter.ts）。
  // 關房的來源可能是房東手動封房、平台的可預訂範圍上限，也可能是我們自己匯出過去的本地訂單
  // 被平台轉成 Not available 又吐回來；照收會讓同一段日期變成兩筆，也會被那種長達數個月的
  // 「超出可預訂範圍」封鎖整段鎖死房況。
  const extraBlockKeywords = parseCsvKeywords(channel.extra_block_keywords);
  const reservations: { ev: (typeof allEvents)[number]; info: ReturnType<typeof classifyOtaEvent> }[] = [];
  const blockedUids = new Set<string>();
  for (const ev of allEvents) {
    const info = classifyOtaEvent(channel.platform, ev, extraBlockKeywords);
    if (info.kind === 'reservation') reservations.push({ ev, info });
    else blockedUids.add(ev.uid);
  }

  // 「這次抓到的 UID」要包含被過濾掉的關房事件——下面判斷「來源已移除」時用的是這一份。
  // 如果只放真訂單，那些被規則擋下的 UID 會被誤判成「平台那邊刪掉了」而把對應訂單自動取消；
  // 一旦平台改措辭導致真訂單被誤判成關房，就會反過來把已收的真訂單取消掉、房間被釋出，
  // 靜悄悄超賣。分開兩份之後，規則寫錯最多是「漏收新訂單」，不會取消既有訂單。
  const seenUids = new Set(allEvents.map((e) => e.uid));

  const { data: existingRows } = await supabase
    .from('bookings')
    .select('id, external_uid, checkin_date, checkout_date, order_number, status')
    .eq('external_channel_id', channel.id);
  const existingByUid = new Map((existingRows || []).map((r: any) => [r.external_uid, r]));

  // 過濾規則上線前就已經被當成訂單匯入的關房事件（例如平台那筆長達數個月的「超出可預訂範圍」
  // 封鎖），現在依規則判定成關房，但刻意不自動取消——那跟「規則誤判真訂單」在資料上長得一樣，
  // 自動取消等於把保護機制繞過去。改成列出來讓人工到「訂單管理」確認後自行取消。
  const staleBlocks = (existingRows || []).filter(
    (r: any) => r.external_uid && blockedUids.has(r.external_uid) && r.status !== 'cancelled'
  );

  let created = 0;
  let updated = 0;
  const conflictLines: string[] = [];

  // 撞期只在「旗標從無到有」時才推播，否則每 15 分鐘跑一次排程就會把同一筆重複轟炸客服。
  const notifyConflict = async (bookingId: string, conflictWith: string, ev: { startIso: string; endIso: string }) => {
    const { data: before } = await supabase.from('bookings').select('ota_conflict_detected_at').eq('id', bookingId).maybeSingle();
    await supabase.from('bookings').update({ ota_conflict_with: conflictWith, ota_conflict_detected_at: nowIso }).eq('id', bookingId);
    if (!before?.ota_conflict_detected_at) conflictLines.push(`・${channel.name}　${ev.startIso}~${ev.endIso}`);
  };

  for (const { ev, info } of reservations) {
    const existing = existingByUid.get(ev.uid);

    if (existing) {
      const changed = existing.checkin_date !== ev.startIso || existing.checkout_date !== ev.endIso;
      if (changed) {
        await supabase.from('bookings').update({
          checkin_date: ev.startIso,
          checkout_date: ev.endIso,
          status: 'external_synced',
          external_confirmation_code: info.confirmationCode,
          external_raw_payload: ev.raw,
          updated_at: nowIso,
        }).eq('id', existing.id);
        updated++;
      }
      // 日期沒變也要重驗衝突：擋住它的那筆本地訂單可能是這次同步之後才被取消或新增的。
      const conflictWith = await checkOtaConflict(channel, ev, existing.id);
      if (conflictWith) await notifyConflict(existing.id, conflictWith, ev);
      else await supabase.from('bookings').update({ ota_conflict_with: null, ota_conflict_detected_at: null }).eq('id', existing.id);
      continue;
    }

    const conflictWith = await checkOtaConflict(channel, ev, null);

    // 訂單編號用「頻道名稱-短碼」，讓後台列表跟 Google 行事曆上都能一眼看出這筆是從哪個
    // 平台/頻道匯入的（頻道名稱本來就是管理員在「第三方平台 iCal 同步」自訂的，例如
    // 「Airbnb 整棟」「Booking - 2樓雅房」）。短碼用預先產生的 UUID 前 8 碼確保不重複
    // （order_number 有 UNIQUE 限制），同一顆 UUID 順便當這筆訂單的主鍵，insert 完不用再多查一次。
    const newId = randomUUID();
    const { error: insertError } = await supabase
      .from('bookings')
      .insert({
        id: newId,
        line_user_id: '', // 外部匯入沒有 LINE 身分，比照「訂單管理」人工建單的空字串慣例
        checkin_date: ev.startIso,
        checkout_date: ev.endIso,
        whole_house: !channel.room_type_id,
        status: 'external_synced',
        booking_source: channel.platform,
        external_channel_id: channel.id,
        external_uid: ev.uid,
        external_confirmation_code: info.confirmationCode,
        external_raw_payload: ev.raw,
        order_number: `${channel.name}-${newId.slice(0, 8)}`,
        name: `${otaPlatformLabel(channel.platform)} 訂單`,
        room_type_label: channel.room_type_id ? channel.name : null,
        // 平台不給客人姓名，只給得到電話末 4 碼（Airbnb）。寫進備註讓客服到平台後台查真實姓名時
        // 有東西可以核對，確認撈到的是同一筆。
        notes: info.phoneLast4 ? `電話末4碼：${info.phoneLast4}` : null,
        ...(conflictWith ? { ota_conflict_with: conflictWith, ota_conflict_detected_at: nowIso } : {}),
      });
    if (insertError) continue;
    created++;
    if (conflictWith) conflictLines.push(`・${channel.name}　${ev.startIso}~${ev.endIso}`);

    // 綁定特定房型的頻道：連動寫進 booking_rooms，讓房型層級的檔期衝突檢查（fetchOccupiedRoomIds
    // 等既有邏輯）看得到這筆外部訂單佔用了哪個房型，跟人工建單（OrderManagement.tsx）同一套機制。
    if (channel.room_type_id) {
      await supabase.from('booking_rooms').insert({ booking_id: newId, room_type_id: channel.room_type_id });
    }
  }

  // 來源已消失的事件（平台那邊取消/刪除了）：標記為取消，不整批刪除。
  // 注意這裡比對的是 seenUids（含被過濾掉的關房事件），不是只有真訂單，理由見上面的說明。
  const disappeared = (existingRows || []).filter((r: any) => r.external_uid && !seenUids.has(r.external_uid));
  if (disappeared.length) {
    await supabase.from('bookings').update({ status: 'cancelled', updated_at: nowIso }).in('id', disappeared.map((r: any) => r.id));
  }

  const parts = [`新增 ${created} 筆`, `更新 ${updated} 筆`];
  if (blockedUids.size) parts.push(`略過關房 ${blockedUids.size} 筆`);
  if (disappeared.length) parts.push(`來源移除 ${disappeared.length} 筆（已標記取消）`);
  if (conflictLines.length) parts.push(`⚠️ ${conflictLines.length} 筆疑似撞期`);
  if (staleBlocks.length) {
    parts.push(`⚠️ ${staleBlocks.length} 筆既有訂單依現行規則應為關房，請人工確認後取消（${staleBlocks.slice(0, 5).map((r: any) => `${r.order_number || r.id} ${r.checkin_date}~${r.checkout_date}`).join('、')}${staleBlocks.length > 5 ? ' 等' : ''}）`);
  }
  const summary = parts.join('、');

  await supabase.from('ota_channels').update({ last_imported_at: nowIso, last_import_status: 'success', last_import_summary: summary }).eq('id', channel.id);

  return { summary: `${channel.name}：${summary}`, conflictLines };
}

// ========================================================================
// Google 行事曆同步：把目前所有「佔用中」的訂單（不分來源，直接訂房＋各 OTA 頻道匯入的都算）
// 直接寫入管理員指定的 Google 行事曆，取代舊版「產生一個 .ics 訂閱網址、讓 Google/TimeTree/
// Apple 自己來拉」的做法——這裡改成主動 push，管理員不用手動訂閱，資料改變後幾乎即時反映。
//
// 用服務帳號（settings.google_service_account_json）走 JWT Bearer flow 換 access token，
// 不引入 googleapis / google-auth-library 這類套件：只需要「簽一個 JWT、換 token、打三支
// events API」，Node 內建的 crypto 就做得到 RS256 簽章，跟這個專案一貫「小範圍需求手刻，
// 不為了一兩個功能多背一個大套件」的原則一致（ICS 解析器、iCal 產生器都是同樣的考量）。
//
// 服務帳號要先被管理員手動「分享」到目標 Google 行事曆（在金鑰的 client_email 那組信箱，
// 權限設「可以變更活動」），這是一次性的設定步驟，沒辦法用程式自動做，需要在後台文案裡說清楚。
// ========================================================================

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(serviceAccountJson: string): Promise<string> {
  const creds = JSON.parse(serviceAccountJson);
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })
  )}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(creds.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Google 回應裡沒有 access_token');
  return data.access_token;
}

interface GoogleEventInput {
  summary: string;
  description: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD，不含這一天（跟本系統的 checkout_date 語意一致）
}

async function googleCalendarRequest(accessToken: string, calendarId: string, method: string, eventId: string | null, body?: any): Promise<any> {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const url = eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err: any = new Error(`HTTP ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function insertGoogleEvent(accessToken: string, calendarId: string, ev: GoogleEventInput): Promise<string> {
  const data = await googleCalendarRequest(accessToken, calendarId, 'POST', null, {
    summary: ev.summary, description: ev.description, start: { date: ev.start }, end: { date: ev.end },
  });
  return data.id;
}

async function patchGoogleEvent(accessToken: string, calendarId: string, eventId: string, ev: GoogleEventInput): Promise<void> {
  await googleCalendarRequest(accessToken, calendarId, 'PATCH', eventId, {
    summary: ev.summary, description: ev.description, start: { date: ev.start }, end: { date: ev.end },
  });
}

async function deleteGoogleEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  try {
    await googleCalendarRequest(accessToken, calendarId, 'DELETE', eventId);
  } catch (e: any) {
    if (e.status !== 404 && e.status !== 410) throw e; // 404/410＝Google 那邊已經沒有這個事件，當作成功
  }
}

function formatAdultsKidsGCal(adults: number | null, kids: number | null, infants: number | null): string {
  const a = adults ?? 0; const k = kids ?? 0; const i = infants ?? 0;
  return `${a}大${k}小${i > 0 ? `${i}幼` : ''}`;
}

async function pushBookingsToGoogleCalendar(settings: any): Promise<string> {
  const calendarId = settings.google_calendar_id;
  const serviceAccountJson = settings.google_service_account_json;
  if (!calendarId || !serviceAccountJson) return 'Google 行事曆尚未設定，略過推送';

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(serviceAccountJson);
  } catch (e: any) {
    const msg = `Google 授權失敗：${e.message}`;
    await supabase.from('settings').update({ google_calendar_last_synced_at: new Date().toISOString(), google_calendar_last_sync_status: 'failed', google_calendar_last_sync_summary: msg }).eq('id', settings.id);
    return msg;
  }

  const nowIso = new Date().toISOString();
  // 跟 calendar-feed.ts 的 PAST_WINDOW_DAYS 同一個考量：只處理近期與未來的訂單，避免查詢範圍無限成長。
  const pastWindowIso = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);

  const { data: bookings, error: bookingsError } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, headcount, adults, kids, infants, whole_house, room_type_label, status, notes, booking_source, external_channel_id, external_confirmation_code, ota_conflict_detected_at, google_event_id, google_synced_at, updated_at')
    .in('status', OCCUPYING_STATUSES)
    .not('checkin_date', 'is', null)
    .not('checkout_date', 'is', null)
    .gte('checkout_date', pastWindowIso);
  if (bookingsError) return `查詢訂單失敗：${bookingsError.message}`;

  // PostgREST 沒辦法在查詢條件裡比較兩個欄位（updated_at > google_synced_at），改成整批抓回來後
  // 在這裡用 JS 過濾——這個專案的訂單量不大，這樣做比另外寫一個資料庫函式簡單很多。
  const toPush = (bookings || []).filter(
    (b: any) => !b.google_synced_at || new Date(b.updated_at).getTime() > new Date(b.google_synced_at).getTime()
  );

  let created = 0;
  let updated = 0;
  let removed = 0;
  let failed = 0;

  for (const b of toPush) {
    const isExternal = b.booking_source !== 'direct';
    const platformLabel = otaPlatformLabel(b.booking_source);
    // 事件標題一律帶來源前綴，一眼看得出這個檔期是誰來的：
    //   本地（LINE 自動成立與後台人工建單都算）：【Line】王先生 4人
    //   第三方：【Airbnb】張小姐 9人 (HMYSQ5EZ8R)
    // 第三方剛匯入時沒有真實姓名/人數——OTA 的 iCal 不給房客身份資料，匯入當下 name 一律是
    // 通用預留字串「Airbnb 訂單」（見 syncOneOtaChannel）。客服到平台後台查到真實姓名、
    // 在「訂單管理」補上去之後才會顯示姓名人數；還沒補之前顯示「已預訂」，不要秀空欄位。
    // 確認碼撈得到才加括號那一段（Airbnb 有，其他平台的規則還沒建立時會是 null）。
    const sourcePrefix = isExternal ? `【${platformLabel}】` : '【Line】';
    const hasRealName = isExternal && b.name && b.name !== `${platformLabel} 訂單`;
    const code = b.external_confirmation_code ? ` (${b.external_confirmation_code})` : '';
    const summaryParts = isExternal
      ? [`${sourcePrefix}${hasRealName ? `${b.name}${b.headcount ? ` ${b.headcount}人` : ''}` : '已預訂'}${code}`]
      : [`${sourcePrefix}${`${b.name || b.nickname || '未填姓名'} ${b.headcount ?? ''}人`.trim()}`];
    if ((!isExternal || hasRealName) && b.whole_house) summaryParts.push('·包棟');
    if (!isExternal && !BALANCE_PAID_STATUSES.includes(b.status)) summaryParts.push(' ⚠️尾款未收');
    if (b.ota_conflict_detected_at) summaryParts.push(' ⚠️疑似撞期');
    const summary = summaryParts.join('');

    const descParts = [`訂單編號: ${b.order_number || ''}`];
    if (isExternal) {
      descParts.push(`來源平台: ${otaPlatformLabel(b.booking_source)}`);
      if (b.external_confirmation_code) descParts.push(`平台訂單編號: ${b.external_confirmation_code}`);
      if (b.notes) descParts.push(`備註: ${b.notes}`); // 平台只給得到電話末 4 碼，匯入時寫在這裡
    } else {
      descParts.push(`大人小孩: ${formatAdultsKidsGCal(b.adults, b.kids, b.infants)}`);
      if (b.room_type_label) descParts.push(`房型: ${b.room_type_label}`);
      if (b.notes) descParts.push(`備註: ${b.notes}`);
    }

    const eventInput: GoogleEventInput = {
      summary, description: descParts.join('\n'),
      start: String(b.checkin_date).slice(0, 10), end: String(b.checkout_date).slice(0, 10),
    };

    try {
      let eventId: string | null = b.google_event_id;
      let isNew = false;
      if (eventId) {
        try {
          await patchGoogleEvent(accessToken, calendarId, eventId, eventInput);
        } catch (e: any) {
          if (e.status !== 404 && e.status !== 410) throw e;
          eventId = await insertGoogleEvent(accessToken, calendarId, eventInput); // Google 那邊的事件被手動刪掉了，補建一筆
          isNew = true;
        }
      } else {
        eventId = await insertGoogleEvent(accessToken, calendarId, eventInput);
        isNew = true;
      }
      if (isNew) created++; else updated++;
      await supabase.from('bookings').update({ google_event_id: eventId, google_synced_at: nowIso }).eq('id', b.id);
    } catch (e: any) {
      failed++;
      console.error(`[GoogleCalendar] push failed for booking ${b.id}:`, e.message);
    }
  }

  // 先前同步過、但後來離開佔用狀態的訂單（取消/退款等）：把對應的 Google 事件刪掉。
  const { data: toRemove } = await supabase
    .from('bookings')
    .select('id, google_event_id')
    .not('google_event_id', 'is', null)
    .not('status', 'in', `(${OCCUPYING_STATUSES.join(',')})`);
  for (const b of toRemove || []) {
    try {
      await deleteGoogleEvent(accessToken, calendarId, b.google_event_id);
      await supabase.from('bookings').update({ google_event_id: null, google_synced_at: null }).eq('id', b.id);
      removed++;
    } catch (e: any) {
      failed++;
      console.error(`[GoogleCalendar] delete failed for booking ${b.id}:`, e.message);
    }
  }

  const parts = [`新增 ${created} 筆`, `更新 ${updated} 筆`];
  if (removed) parts.push(`移除 ${removed} 筆`);
  if (failed) parts.push(`⚠️ ${failed} 筆失敗`);
  const summary = parts.join('、');
  const anySuccess = created + updated + removed > 0;
  await supabase.from('settings').update({
    google_calendar_last_synced_at: nowIso,
    google_calendar_last_sync_status: failed > 0 && !anySuccess ? 'failed' : 'success',
    google_calendar_last_sync_summary: summary,
  }).eq('id', settings.id);

  return summary;
}

// 排程管理頁的「第三方平台 iCal 同步」排程：先把各 OTA 頻道的最新資料匯入，整合完
// （不分來源的完整佔用狀態）再一次推送到 Google 行事曆。兩步驟包在同一個排程類型裡，
// 管理員只要設定一筆排程（建議每 15~30 分鐘）就能同時涵蓋「匯入」跟「同步到 Google」，
// 不用自己再另外排一個順序、猜兩個排程誰先跑。
async function syncCalendars(_config: Record<string, any>, settings: any): Promise<{ ok: boolean; summary: string }> {
  const { data: channels, error } = await supabase
    .from('ota_channels')
    .select('*')
    .eq('is_active', true)
    .not('import_ics_url', 'is', null);
  if (error) return { ok: false, summary: `查詢頻道失敗：${error.message}` };

  const results: string[] = [];
  const conflictAlerts: string[] = [];
  if (channels?.length) {
    for (const channel of channels) {
      const { summary, conflictLines } = await syncOneOtaChannel(channel);
      results.push(summary);
      conflictAlerts.push(...conflictLines);
    }
  } else {
    results.push('沒有設定匯入網址的啟用中頻道');
  }

  if (conflictAlerts.length) {
    const customerChannel = await fetchCustomerChannel();
    if (customerChannel?.channel_access_token) {
      try {
        const lineClient = new Client({ channelAccessToken: customerChannel.channel_access_token, channelSecret: customerChannel.channel_secret });
        const text = `⚠️ 第三方平台同步偵測到 ${conflictAlerts.length} 筆疑似撞期，請人工核實：\n${conflictAlerts.join('\n')}`;
        for (const id of parseCsvKeywords(settings.agent_user_ids)) {
          try { await lineClient.pushMessage(id, { type: 'text', text }); } catch {}
        }
      } catch (e: any) {
        console.error('[ScheduledTasks] OTA conflict notify failed:', e.message);
      }
    }
  }

  const googleSummary = await pushBookingsToGoogleCalendar(settings);
  results.push(`Google 行事曆：${googleSummary}`);

  return { ok: true, summary: results.join('；') };
}

const TASK_EXECUTORS: Record<string, TaskExecutor> = {
  cancel_unpaid_bookings: cancelUnpaidBookings,
  notify_checkout_completed: notifyCheckoutCompleted,
  advance_to_awaiting_balance: advanceToAwaitingBalance,
  advance_to_checked_in: advanceToCheckedIn,
  advance_to_deposit_processing: advanceToDepositProcessing,
  balance_reminder: balanceReminder,
  deposit_awaiting_notice: depositAwaitingNotice,
  awaiting_confirmation_notice: awaitingConfirmationNotice,
  checkin_notice: checkinNotice,
  deposit_processing_notice: depositProcessingNotice,
  laundry_notice: laundryNotice,
  sync_calendars: syncCalendars,
  process_waitlist: () => processWaitlist(),
};

function toScheduleConfig(task: any): ScheduleConfig {
  return {
    recurrence: task.recurrence,
    runAtTime: task.run_at_time,
    runAtDate: task.run_at_date,
    weekday: task.weekday,
    dayOfMonth: task.day_of_month,
    intervalMinutes: task.interval_minutes,
  };
}

// 「立即執行」（排程管理頁的測試按鈕）：手動觸發單一任務，不管 next_run_at 是否已到期，
// 也不影響原本的排程節奏——只更新 last_run_*，刻意不動 next_run_at/is_active，
// 這樣測試完不會打亂使用者原本設定好的排程時間。
// 這支函式本來是給 Netlify 排程器打的公開端點（cron 觸發沒有登入權杖），但手動觸發是新增的
// 攻擊面，而且有些任務會實際取消訂單、發 LINE 訊息給客人，所以這條路徑額外要求 Supabase 登入權杖，
// 跟 custom-messages.ts 同一套作法。
async function runTaskNow(event: any, taskId: string) {
  const authHeader = event.headers?.['authorization'] || event.headers?.['Authorization'];
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return { statusCode: 401, body: JSON.stringify({ error: '登入已過期，請重新整理頁面' }) };

  const { data: task, error: taskError } = await supabase.from('scheduled_tasks').select('*').eq('id', taskId).maybeSingle();
  if (taskError) return { statusCode: 500, body: JSON.stringify({ error: taskError.message }) };
  if (!task) return { statusCode: 404, body: JSON.stringify({ error: '找不到這個排程' }) };

  const { data: settings } = await supabase.from('settings').select('*').single();
  if (!settings) return { statusCode: 500, body: JSON.stringify({ error: '讀取系統設定失敗' }) };

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

  await supabase
    .from('scheduled_tasks')
    .update({
      last_run_at: new Date().toISOString(),
      last_run_status: result.ok ? 'success' : 'failed',
      last_run_summary: `[手動測試] ${result.summary}`,
    })
    .eq('id', task.id);

  return { statusCode: 200, body: JSON.stringify(result) };
}

export const handler: Handler = async (event) => {
  if (event?.httpMethod === 'POST' && event.body) {
    let body: any = null;
    try { body = JSON.parse(event.body); } catch { body = null; }
    if (body?.taskId) return runTaskNow(event, body.taskId);
  }

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

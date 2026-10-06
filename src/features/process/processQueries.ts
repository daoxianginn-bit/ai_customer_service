import { supabase } from '../../lib/supabase';
import { logOperation, logUiError } from '../../lib/logOperation';
import { LOG_FEATURES, diffRecords } from '../../lib/operationLog';
import type { BookingRow } from '../booking/bookingQueries';
import { BALANCE_PAID_STATUSES, OCCUPYING_STATUSES } from '../../lib/bookingStatus';

// ========================================================================
// 訂單處理（人工關卡工作台）的資料層。
//
// 五個關卡，每關對應訂單狀態機裡「排程不會自己往前推、要人動手」的那幾個狀態：
//   待確認 → 核對訂金到帳（確認＝直接推進到已預定，否則「訂單自動取消」排程會把已付款的單取消掉）
//   待收尾款 → 收到尾款
//   押金處理 → 退房後核對／退還押金
//   待退款 → 取消後把款退回
//   待入住／入住中 → 設定入住密碼、調整洗物數量（狀態由排程當天自動轉，這一關不推進）
// 每一關「誰按了確認、發了哪個範本」記在 booking_stage_actions（一筆訂單一關一列）。
// ========================================================================

import { STAGES, type StageKey, type MessageTemplate } from './processStages';

export * from './processStages';

export interface StageAction {
  booking_id: string;
  stage: StageKey;
  confirmed_at: string | null;
  confirmed_by: string | null;
  notified_at: string | null;
  notified_by: string | null;
  template_title: string | null;
  message: string | null;
}

export interface QueueData {
  bookings: BookingRow[];
  actions: StageAction[];
  /** 最近 7 天按過確認的（含已推進到別關的訂單），給「最近處理」補發通知用 */
  recent: { action: StageAction; booking: BookingRow }[];
}

const RECENT_DAYS = 7;

/**
 * 把「一點布巾數量都沒有、而且這一關還沒按過確認」的訂單併進來，並在每一列掛上
 * needs_linen_backfill 旗標給關卡的 appliesTo 用。
 *
 * 兩個條件缺一不可：
 *   沒有數量   —— 有數量就表示有人處理過了
 *   沒按過確認 —— 不然「這筆真的不用布巾」會因為數量永遠是 0 而每次都重新冒出來
 */
async function attachLinenBackfill(rows: BookingRow[]): Promise<BookingRow[]> {
  // 先只拿 id 判斷誰需要補。這個查詢沒有日期範圍（住完的訂單一樣要補成本），訂單累積久了
  // 會是整頁最大的一筆——拿整列回來只為了算一個布林值，代價差很多。
  const { data: candidates, error } = await supabase
    .from('bookings')
    .select('id')
    .in('status', OCCUPYING_STATUSES);
  // 查不到就當作沒有這一關，不要讓整個工作台開不起來
  if (error || !candidates?.length) return rows;

  const candidateIds = candidates.map((b: any) => b.id);
  const [{ data: usage }, { data: done }] = await Promise.all([
    supabase.from('booking_linen_usage').select('booking_id, quantity').in('booking_id', candidateIds),
    supabase.from('booking_stage_actions').select('booking_id').eq('stage', 'linen_backfill').in('booking_id', candidateIds),
  ]);

  const hasQty = new Set((usage || []).filter((u: any) => Number(u.quantity) > 0).map((u: any) => u.booking_id));
  const confirmed = new Set((done || []).map((a: any) => a.booking_id));
  const needs = candidateIds.filter((id: string) => !hasQty.has(id) && !confirmed.has(id));
  if (!needs.length) return rows;

  const byId = new Map(rows.map((b) => [b.id, b]));
  // 已經在佇列裡的（款項／入住準備那些關卡撈過的）直接掛旗標，只有不在的才需要再查整列。
  const missing = needs.filter((id: string) => !byId.has(id));
  for (const id of needs) {
    const existing = byId.get(id);
    if (existing) existing.needs_linen_backfill = true;
  }
  if (missing.length) {
    const { data: extra } = await supabase
      .from('bookings')
      .select('*')
      .in('id', missing)
      .order('checkin_date', { ascending: false });
    for (const b of (extra || []) as BookingRow[]) byId.set(b.id, { ...b, needs_linen_backfill: true });
  }
  return [...byId.values()];
}

/**
 * @param withLinenBackfill 看得到「待補布巾數量」那一關的人才要算。會計、客服看不到那一關，
 *   算了也沒有地方顯示——而那是這一頁最大的一組查詢，每 30 秒輪詢一次更不該白跑。
 */
export async function fetchQueues(withLinenBackfill = false): Promise<QueueData> {
  const statuses = STAGES.flatMap((s) => s.statuses);
  const since = new Date(Date.now() - RECENT_DAYS * 86400e3).toISOString();
  const [{ data: bookings, error }, { data: recentActions }, { data: withExtras }] = await Promise.all([
    supabase.from('bookings').select('*').in('status', statuses).order('checkin_date'),
    supabase.from('booking_stage_actions').select('*').gte('confirmed_at', since).order('confirmed_at', { ascending: false }).limit(200),
    // 追加款收款不看狀態：尾款已收、還有未付追加款的訂單（含已結案的），另外撈。
    // 欄位還沒建立（schema 尚未執行）時這個查詢會失敗，當作沒有，不擋整頁。
    supabase.from('bookings').select('*').in('status', BALANCE_PAID_STATUSES).gt('extra_unpaid_total', 0),
  ]);
  if (error) throw error;
  const baseRows = (bookings || []) as BookingRow[];
  const baseIds = new Set(baseRows.map((b) => b.id));
  let rows = [...baseRows, ...((withExtras || []) as BookingRow[]).filter((b) => !baseIds.has(b.id))];

  // 「待補布巾數量」的佇列。另外撈的原因跟追加款那一關一樣：上面那個查詢只收「關卡狀態的聯集」，
  // 而第三方平台匯入的訂單是 external_synced，從來不在任何關卡的狀態清單裡——不另外撈就永遠看不到。
  // 不限日期（已經住完的也要補，否則那幾晚的洗滌成本永遠少一塊），靠裡面兩個條件收斂。
  if (withLinenBackfill) rows = await attachLinenBackfill(rows);

  const ids = rows.map((b) => b.id);
  const { data: actions } = ids.length ? await supabase.from('booking_stage_actions').select('*').in('booking_id', ids) : { data: [] };

  // 最近處理：把已經不在佇列裡的訂單也撈回來
  const recentRows = (recentActions || []) as StageAction[];
  const missing = [...new Set(recentRows.map((a) => a.booking_id).filter((id) => !ids.includes(id)))];
  const { data: extra } = missing.length ? await supabase.from('bookings').select('*').in('id', missing) : { data: [] };
  const byId = new Map<string, BookingRow>([...rows, ...((extra || []) as BookingRow[])].map((b) => [b.id, b]));
  const recent = recentRows.map((a) => ({ action: a, booking: byId.get(a.booking_id)! })).filter((r) => r.booking);

  return { bookings: rows, actions: (actions || []) as StageAction[], recent };
}

// ---------------- 寫入 ----------------

/** 存這一關可編輯的欄位（備註／密碼／末五碼），只寫有變的欄位並留操作紀錄。 */
export interface StageEditPatch {
  notes?: string | null;
  check_in_password?: string | null;
  remit_last5?: string | null;
  balance_remit_last5?: string | null;
  refund_amount?: number | null;
  refund_note?: string | null;
  damage_found?: boolean | null;
  damage_deduction?: number | null;
  damage_note?: string | null;
}

export async function saveStageEdits(order: BookingRow, patch: StageEditPatch) {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if ((order as any)[k] !== v && !((order as any)[k] == null && !v)) payload[k] = v;
  if (!Object.keys(payload).length) return;
  payload.updated_at = new Date().toISOString();
  try {
    const { error } = await supabase.from('bookings').update(payload).eq('id', order.id);
    if (error) throw error;
    const diff = diffRecords(order, payload, Object.keys(payload).filter((k) => k !== 'updated_at'));
    if (diff.changed) await logOperation({ feature: LOG_FEATURES.order, action: '修改', target: order.order_number || order.id, before: diff.before, after: diff.after });
  } catch (err) {
    await logUiError({ feature: LOG_FEATURES.order, action: '修改失敗', target: order.order_number || null, error: err });
    throw err;
  }
}

export async function markStageConfirmed(bookingId: string, stage: StageKey, actorEmail: string) {
  const now = new Date().toISOString();
  const { error } = await supabase.from('booking_stage_actions').upsert(
    { booking_id: bookingId, stage, confirmed_at: now, confirmed_by: actorEmail, updated_at: now },
    { onConflict: 'booking_id,stage' },
  );
  if (error) throw error;
}

// ---------------- 通知（走 booking-process function） ----------------

export async function callProcess(action: string, payload: Record<string, unknown> = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch('/.netlify/functions/booking-process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
  if (!res.ok) throw new Error(parsed.error || parsed.message || text || '操作失敗');
  return parsed;
}

export interface NotifyContext {
  fields: Record<string, string>;
  hasLine: boolean;
  channelName: string | null;
  nickname: string | null;
  quota: { limit: number | null; used: number; remaining: number | null } | null;
}
export const fetchNotifyContext = (bookingId: string): Promise<NotifyContext> => callProcess('context', { bookingId });
export const sendStageNotice = (bookingId: string, stage: StageKey, template: string, templateTitle: string | null): Promise<{ ok: true; sentAt: string; text: string }> =>
  callProcess('notify', { bookingId, stage, template, templateTitle });
export const saveStageTemplates = (stageTemplates: Record<string, string>) => callProcess('set_stage_templates', { stageTemplates });
export const resendLaundry = (date: string): Promise<{ ok: true; summary: string }> => callProcess('resend_laundry', { date });

export async function fetchTemplates(): Promise<MessageTemplate[]> {
  const { data } = await supabase.from('custom_message_templates').select('id, title, body').order('created_at');
  return (data || []) as MessageTemplate[];
}
export async function fetchStageTemplates(): Promise<Record<string, string>> {
  // 讀 operational_settings 不是 settings：settings 整列含金鑰，只有系統管理權限讀得到，
  // 會計、房務讀 settings 會拿到空值，通知對話框就帶不出這一關的預設範本。
  const { data } = await supabase.from('operational_settings').select('stage_templates').limit(1).maybeSingle();
  return (data?.stage_templates as Record<string, string>) || {};
}


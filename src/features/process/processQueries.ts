import { supabase } from '../../lib/supabase';
import { logOperation, logUiError } from '../../lib/logOperation';
import { LOG_FEATURES, diffRecords } from '../../lib/operationLog';
import type { BookingRow } from '../booking/bookingQueries';

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

export async function fetchQueues(): Promise<QueueData> {
  const statuses = STAGES.flatMap((s) => s.statuses);
  const since = new Date(Date.now() - RECENT_DAYS * 86400e3).toISOString();
  const [{ data: bookings, error }, { data: recentActions }] = await Promise.all([
    supabase.from('bookings').select('*').in('status', statuses).order('checkin_date'),
    supabase.from('booking_stage_actions').select('*').gte('confirmed_at', since).order('confirmed_at', { ascending: false }).limit(200),
  ]);
  if (error) throw error;
  const rows = (bookings || []) as BookingRow[];
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
export async function saveStageEdits(order: BookingRow, patch: { notes?: string | null; check_in_password?: string | null; remit_last5?: string | null }) {
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

async function callProcess(action: string, payload: Record<string, unknown> = {}) {
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
  const { data } = await supabase.from('settings').select('stage_templates').limit(1).maybeSingle();
  return (data?.stage_templates as Record<string, string>) || {};
}


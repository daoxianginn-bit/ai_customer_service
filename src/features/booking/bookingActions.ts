import { supabase } from '../../lib/supabase';
import { REQUIRES_REMIT_LAST5_STATUS } from '../../lib/bookingStatus';
import { generateOrderNumber } from '../../lib/orderNumber';
import { logOperation, logUiError } from '../../lib/logOperation';
import { LOG_FEATURES, diffRecords, labelRecord } from '../../lib/operationLog';
import type { LinenUsageRow } from '../../lib/linenCost';
import type { BookingRow } from './bookingQueries';

// ========================================================================
// 訂房模組的寫入動作（V2 §98）。每個動作＝寫資料庫＋寫操作紀錄，成功／失敗都在這裡處理，
// 列表頁、詳情頁、編輯對話框共用同一份，不會出現「詳情頁推進狀態有寫紀錄、列表頁沒有」。
//
// 邏輯從舊的 OrderManagement.tsx 搬過來，狀態機規則（匯款末5碼、入住密碼）沒有變。
// ========================================================================

export class BookingActionError extends Error {}

/**
 * 推進到下一關（或任何指定狀態）。推到「已預定」時必須帶匯款末5碼——那一關代表訂金已核對入帳。
 */
export async function advanceBookingStatus(order: BookingRow, nextStatus: string, opts: { remitLast5?: string } = {}) {
  const needsRemit = nextStatus === REQUIRES_REMIT_LAST5_STATUS;
  const remit = (opts.remitLast5 || '').trim();
  if (needsRemit && !remit) throw new BookingActionError('請先填寫匯款末5碼再推進到「已預定」。');

  try {
    const payload: Record<string, any> = { status: nextStatus, updated_at: new Date().toISOString() };
    if (needsRemit) payload.remit_last5 = remit;
    const { error } = await supabase.from('bookings').update(payload).eq('id', order.id);
    if (error) throw error;

    const diff = diffRecords(order, payload, Object.keys(payload));
    await logOperation({
      feature: LOG_FEATURES.order,
      action: '狀態變更',
      target: order.order_number || order.id,
      before: diff.before,
      after: diff.after,
    });
  } catch (err: any) {
    await logUiError({ feature: LOG_FEATURES.order, action: '狀態變更失敗', target: order.order_number || null, error: err });
    throw err;
  }
}

/** 取消訂單走狀態機（status → cancelled），不是刪除；客服也能做。 */
export function cancelBooking(order: BookingRow) {
  return advanceBookingStatus(order, 'cancelled');
}

/** 刪除是唯一救不回來的操作，異動前的內容一定要留下來，之後才查得到「被刪掉的是什麼」。 */
export async function deleteBooking(order: BookingRow) {
  try {
    const { error } = await supabase.from('bookings').delete().eq('id', order.id);
    if (error) throw error;
    await logOperation({
      feature: LOG_FEATURES.order,
      action: '刪除',
      target: order.order_number || order.id,
      before: labelRecord(order, ['order_number', 'name', 'phone', 'checkin_date', 'checkout_date', 'headcount', 'room_type_label', 'total_amount', 'deposit', 'status']),
      after: null,
    });
  } catch (err: any) {
    await logUiError({ feature: LOG_FEATURES.order, action: '刪除失敗', target: order.order_number || null, error: err });
    throw err;
  }
}

/**
 * 批次刪除一次寫一筆紀錄、列出被刪掉的訂單編號。拆成每張單一筆的話，一次刪 20 張
 * 就會在紀錄裡刷掉整頁，反而看不出「這是同一次批次操作」。
 */
export async function deleteBookings(rows: BookingRow[]) {
  const ids = rows.map((r) => r.id);
  try {
    const { error } = await supabase.from('bookings').delete().in('id', ids);
    if (error) throw error;
    await logOperation({
      feature: LOG_FEATURES.order,
      action: '批次刪除',
      target: `共 ${rows.length} 筆`,
      before: { 訂單編號: rows.map((r) => r.order_number || r.id).join('、') },
      after: null,
    });
  } catch (err: any) {
    await logUiError({ feature: LOG_FEATURES.order, action: '批次刪除失敗', target: `共 ${ids.length} 筆`, error: err });
    throw err;
  }
}

/**
 * 新增或更新訂單本體。新增時訂單編號由前端產生，撞到唯一鍵就換一組重試（最多 3 次）。
 * 回傳訂單 id 與（新增時）產生的訂單編號。
 */
export async function upsertBooking(editingId: string | null, payload: Record<string, unknown>): Promise<{ id: string; orderNumber: string }> {
  if (editingId) {
    const { error } = await supabase.from('bookings').update(payload).eq('id', editingId);
    if (error) throw error;
    return { id: editingId, orderNumber: '' };
  }
  let lastError: any = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderNumber = generateOrderNumber();
    const { data, error } = await supabase
      .from('bookings')
      .insert({ ...payload, order_number: orderNumber })
      .select('id')
      .single();
    if (!error) return { id: data.id, orderNumber };
    lastError = error;
    if (!String(error.message || '').includes('order_number')) break;
  }
  throw lastError;
}

/** 房間與布巾用量整批重寫（先刪後插）。布巾功能沒啟用時靜靜跳過，不擋訂單儲存。 */
export async function saveBookingLinen(bookingId: string, roomIds: string[], usage: LinenUsageRow[], enabled: boolean) {
  if (!enabled) return;
  try {
    await supabase.from('booking_rooms').delete().eq('booking_id', bookingId);
    if (roomIds.length) {
      await supabase.from('booking_rooms').insert(roomIds.map((room_type_id) => ({ booking_id: bookingId, room_type_id })));
    }
    await supabase.from('booking_linen_usage').delete().eq('booking_id', bookingId);
    const rows = usage.filter((r) => r.quantity > 0);
    if (rows.length) {
      await supabase.from('booking_linen_usage').insert(rows.map((r) => ({ booking_id: bookingId, ...r })));
    }
  } catch (e: any) {
    console.error('[Linen] save failed:', e.message);
  }
}

/** 存檔成功後的操作紀錄：只在訂單本身真的存成功之後才寫，寫失敗也不影響這次存檔。 */
export async function logBookingSaved(args: {
  editingId: string | null;
  original: BookingRow | null;
  payload: Record<string, unknown>;
  orderNumber: string;
}) {
  const { editingId, original, payload, orderNumber } = args;
  if (editingId) {
    const diff = diffRecords(original, payload, Object.keys(payload));
    if (!diff.changed) return;
    await logOperation({
      feature: LOG_FEATURES.order,
      // 狀態有變就標成「狀態變更」，查紀錄時最常找的就是「這張單什麼時候被推到下一關」。
      action: diff.after['訂單狀態'] !== undefined ? '狀態變更' : '修改',
      target: orderNumber || editingId,
      before: diff.before,
      after: diff.after,
    });
  } else {
    await logOperation({
      feature: LOG_FEATURES.order,
      action: '新增',
      target: orderNumber,
      before: null,
      after: labelRecord(payload, ['name', 'phone', 'checkin_date', 'checkout_date', 'headcount', 'whole_house', 'room_amount', 'security_deposit', 'total_amount', 'deposit', 'status']),
    });
  }
}

export async function logBookingSaveFailed(editingId: string | null, orderNumber: string | null, err: unknown) {
  await logUiError({ feature: LOG_FEATURES.order, action: editingId ? '修改失敗' : '新增失敗', target: orderNumber || null, error: err });
}

/**
 * 人工清除 OTA 撞期旗標（§4.2 候補／衝突）。旗標是 OTA 同步排程標上去的，下次同步若已不撞期
 * 也會自動清掉；這裡給人工查核完「其實沒問題」時用，不動 status。
 */
export async function resolveOtaConflict(order: BookingRow) {
  try {
    const payload = { ota_conflict_with: null, ota_conflict_detected_at: null, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('bookings').update(payload).eq('id', order.id);
    if (error) throw error;
    await logOperation({
      feature: LOG_FEATURES.order,
      action: '清除撞期旗標',
      target: order.order_number || order.id,
      before: { OTA撞期對象: order.ota_conflict_with },
      after: { OTA撞期對象: null },
    });
  } catch (err: any) {
    await logUiError({ feature: LOG_FEATURES.order, action: '清除撞期旗標失敗', target: order.order_number || null, error: err });
    throw err;
  }
}

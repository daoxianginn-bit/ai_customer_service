import { supabase } from '../../lib/supabase';
import type { ExtraCharge, ExtraChargeInput } from '../../lib/extraCharges';
import { callProcess } from '../process/processQueries';

// ========================================================================
// 追加款的資料存取。讀取直接查資料表（RLS：booking.view）；寫入一律走 booking-process function，
// 字母配發、權限（勾已付只限款項核對）、「已付的不能改」都在那裡檢查，前端不能繞過。
// ========================================================================

export async function fetchExtraCharges(bookingId: string): Promise<ExtraCharge[]> {
  const { data, error } = await supabase.from('booking_extra_charges').select('*').eq('booking_id', bookingId).order('seq');
  // 資料表還沒建立（schema 尚未執行）時當作沒有追加款，不擋訂單頁
  if (error) return [];
  return ((data || []) as any[]).map((r) => ({ ...r, amount: Number(r.amount) })) as ExtraCharge[];
}

export const addExtraCharges = (bookingId: string, items: ExtraChargeInput[]): Promise<{ ok: true; rows: ExtraCharge[]; notice: string | null }> =>
  callProcess('extra_add', { bookingId, items });

export const updateExtraCharge = (id: string, patch: { title: string; amount: number | string; internal_note?: string | null }) =>
  callProcess('extra_update', { id, ...patch });

export const voidExtraCharge = (id: string) => callProcess('extra_void', { id });

/** ids 不帶＝這筆訂單所有未付的（尾款確認時用） */
export const setExtraChargesPaid = (bookingId: string, ids: string[] | null, paid = true): Promise<{ ok: true; changed: number }> =>
  callProcess('extra_set_paid', { bookingId, ...(ids ? { ids } : {}), paid });

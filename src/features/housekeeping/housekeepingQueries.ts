import { supabase } from '../../lib/supabase';
import { OCCUPYING_STATUSES } from '../../lib/bookingStatus';
import { laundryItemFullName, laundryItemName } from '../../lib/messageVariables';
import { todayIso } from '../../lib/format';
import type { BookingRow } from '../booking/bookingQueries';

// ========================================================================
// 房務（V2 §45–48）的資料。沒有清潔管理表，所以「今日待清潔」＝今日退房的訂單；
// 「待洗布巾」＝今日入住訂單的布巾用量（跟排程「入住日轉入住中」發洗滌單的口徑一致）。
// ========================================================================

export interface LaundryItemTotal {
  id: string;
  name: string;      // 洗滌單簡稱（沒填就用完整名稱）
  fullName: string;
  quantity: number;
  unitPrice: number | null;
}

export interface LaundryBooking extends BookingRow {
  rooms: string[];
  pieces: number;
}

export interface LaundrySheet {
  date: string;
  bookings: LaundryBooking[];
  items: LaundryItemTotal[];
  totalPieces: number;
  totalCost: number;
  /** 直接可貼給洗滌廠的文字 */
  text: string;
}

/** 指定入住日的洗滌單：這天入住的訂單用到的布巾加總（依品項顯示順序）。 */
export async function fetchLaundrySheet(date: string): Promise<LaundrySheet> {
  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, nights, headcount, status, whole_house, room_type_label')
    .eq('checkin_date', date)
    .in('status', OCCUPYING_STATUSES)
    .order('created_at');
  if (error) throw error;
  const rows = (bookings || []) as BookingRow[];
  const ids = rows.map((b) => b.id);

  const [usageRes, itemRes, roomRes, roomTypeRes] = await Promise.all([
    ids.length ? supabase.from('booking_linen_usage').select('booking_id, linen_item_id, quantity, unit_price').in('booking_id', ids) : Promise.resolve({ data: [] as any[] }),
    supabase.from('linen_items').select('id, category, spec, short_name, unit_price, display_order').order('display_order'),
    ids.length ? supabase.from('booking_rooms').select('booking_id, room_type_id').in('booking_id', ids) : Promise.resolve({ data: [] as any[] }),
    supabase.from('room_types').select('id, name, floor'),
  ]);
  const usage = (usageRes.data || []) as { booking_id: string; linen_item_id: string; quantity: number; unit_price: number }[];
  const items = (itemRes.data || []) as any[];
  const roomName = new Map((roomTypeRes.data || []).map((r: any) => [r.id, r.floor ? `${r.floor}_${r.name}` : r.name]));
  const roomsByBooking = new Map<string, string[]>();
  for (const r of (roomRes.data || []) as any[]) roomsByBooking.set(r.booking_id, [...(roomsByBooking.get(r.booking_id) || []), roomName.get(r.room_type_id) || '?']);

  const totals = new Map<string, number>();
  const piecesByBooking = new Map<string, number>();
  let totalCost = 0;
  for (const u of usage) {
    totals.set(u.linen_item_id, (totals.get(u.linen_item_id) || 0) + Number(u.quantity));
    piecesByBooking.set(u.booking_id, (piecesByBooking.get(u.booking_id) || 0) + Number(u.quantity));
    totalCost += Number(u.quantity) * Number(u.unit_price || 0);
  }
  const itemTotals: LaundryItemTotal[] = items
    .filter((it) => (totals.get(it.id) || 0) > 0)
    .map((it) => ({ id: it.id, name: laundryItemName(it), fullName: laundryItemFullName(it), quantity: totals.get(it.id) || 0, unitPrice: it.unit_price }));

  const laundryBookings: LaundryBooking[] = rows.map((b) => ({ ...b, rooms: roomsByBooking.get(b.id) || [], pieces: piecesByBooking.get(b.id) || 0 }));
  const totalPieces = itemTotals.reduce((s, it) => s + it.quantity, 0);
  const text = [`${date.replace(/-/g, '/')} 洗滌單`, ...itemTotals.map((it) => `${it.name}：${it.quantity}`), `合計 ${totalPieces} 件`].join('\n');
  return { date, bookings: laundryBookings, items: itemTotals, totalPieces, totalCost, text };
}

export interface HousekeepingKpis {
  checkoutsToday: number;
  checkinsToday: number;
  laundryPiecesToday: number;
  lowStock: { id: string; name: string; unit: string; stock_quantity: number; restock_threshold: number }[];
  checkoutsList: BookingRow[];
}

export async function fetchHousekeepingKpis(): Promise<HousekeepingKpis> {
  const today = todayIso();
  const [checkoutRes, checkinRes, consumRes, sheet] = await Promise.all([
    supabase.from('bookings').select('id, order_number, name, nickname, checkin_date, checkout_date, nights, headcount, status, whole_house, room_type_label').eq('checkout_date', today).in('status', OCCUPYING_STATUSES).order('created_at'),
    supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('checkin_date', today).in('status', OCCUPYING_STATUSES),
    supabase.from('consumables').select('id, name, unit, stock_quantity, restock_threshold').order('name'),
    fetchLaundrySheet(today),
  ]);
  const consumables = (consumRes.data || []) as HousekeepingKpis['lowStock'];
  return {
    checkoutsToday: (checkoutRes.data || []).length,
    checkinsToday: checkinRes.count ?? 0,
    laundryPiecesToday: sheet.totalPieces,
    lowStock: consumables.filter((c) => (c.restock_threshold ?? 0) > 0 && (c.stock_quantity ?? 0) <= c.restock_threshold),
    checkoutsList: (checkoutRes.data || []) as BookingRow[],
  };
}

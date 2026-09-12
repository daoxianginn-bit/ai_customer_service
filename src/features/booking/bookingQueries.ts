import { supabase } from '../../lib/supabase';
import { MANUAL_ACTION_STATUSES, OCCUPYING_STATUSES } from '../../lib/bookingStatus';
import type { LinenItem, LinenUsageRow, RoomLinenDefault } from '../../lib/linenCost';
import type { RoomOption } from '../../lib/rooms';
import { addDaysIso, todayIso } from '../../lib/format';

// ========================================================================
// 訂房模組的資料存取層（V2 §98）。頁面只組畫面，不直接寫 supabase 查詢；
// 列表、詳情、編輯對話框、工作台都從這裡取資料，同一個篩選條件在各頁的解讀才會一致。
//
// 查詢邏輯從舊的 OrderManagement.tsx 原封不動搬過來（含註解裡的取捨），只是換了個地方住。
// ========================================================================

export const BOOKING_PAGE_SIZE = 15;

/** bookings 一列。欄位很多且會隨 schema 增加，這裡只宣告畫面會用到的，其餘走 index signature。 */
export interface BookingRow {
  id: string;
  order_number?: string | null;
  line_user_id?: string | null;
  name?: string | null;
  nickname?: string | null;
  phone?: string | null;
  checkin_date?: string | null;
  checkout_date?: string | null;
  nights?: number | null;
  headcount?: number | null;
  adults?: number | null;
  kids?: number | null;
  infants?: number | null;
  whole_house?: boolean | null;
  room_type_label?: string | null;
  room_amount?: number | null;
  security_deposit?: number | null;
  total_amount?: number | null;
  deposit?: number | null;
  remit_last5?: string | null;
  check_in_password?: string | null;
  status: string;
  guest_notes?: string | null;
  notes?: string | null;
  linen_change_count?: number | null;
  booking_source?: string | null;
  external_confirmation_code?: string | null;
  payment_deadline_at?: string | null;
  ota_conflict_with?: string | null;
  waitlist_blocked_by?: string | null;
  supersedes_booking_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  [key: string]: unknown;
}

/** 快速篩選（V2 §20）：一鍵切到客服最常看的幾種檢視，跟細部篩選互斥。 */
export type BookingQuickView = 'all' | 'manual' | 'upcoming' | 'staying' | 'completed' | 'cancelled' | 'ota';

export const QUICK_VIEW_OPTIONS: { value: BookingQuickView; label: string; hint: string }[] = [
  { value: 'all', label: '全部', hint: '不含已取消' },
  { value: 'manual', label: '待處理', hint: '卡在人工關卡的訂單：待確認、待收尾款、押金處理、待人工確認、待退款' },
  { value: 'upcoming', label: '即將入住', hint: '未來 7 天內入住、且已鎖房的訂單' },
  { value: 'staying', label: '住宿中', hint: '目前入住中' },
  { value: 'completed', label: '已完成', hint: '押金已處理、結案' },
  { value: 'cancelled', label: '已取消', hint: '含待退款、已退款' },
  { value: 'ota', label: 'OTA', hint: '從 Airbnb／Booking 等平台同步進來的訂單' },
];

export interface BookingFilters {
  keyword: string;
  startDate: string;
  endDate: string;
  status: string;
  roomType: string;
  view: BookingQuickView;
}

export const EMPTY_FILTERS: BookingFilters = { keyword: '', startDate: '', endDate: '', status: '', roomType: '', view: 'all' };

/**
 * 訂單清單（分頁）。
 *
 * 「全部」預設不含已取消——第三方平台同步偵測到客戶在 Airbnb/Booking 等平台取消訂單時，
 * 對應的本地訂單只會被標記成 cancelled（保留紀錄供查核），不會整筆刪除；如果預設清單還是
 * 照樣顯示，訂單管理看起來就會跟平台實際的訂房狀況對不起來。要看已取消的訂單，
 * 從快速篩選「已取消」或狀態下拉明確篩選即可。
 */
export async function listBookings(pageIndex: number, f: BookingFilters, pageSize = BOOKING_PAGE_SIZE) {
  let query = supabase
    .from('bookings')
    .select('*')
    .order('created_at', { ascending: false })
    .range(pageIndex * pageSize, pageIndex * pageSize + pageSize - 1);

  if (f.startDate) query = query.gte('checkin_date', f.startDate);
  if (f.endDate) query = query.lte('checkin_date', f.endDate);

  // 快速檢視是跨多個狀態的組合，優先於單一狀態篩選（點它就是想一次看完那一類的單）。
  switch (f.view) {
    case 'manual':
      query = query.in('status', MANUAL_ACTION_STATUSES);
      break;
    case 'upcoming':
      query = query.in('status', OCCUPYING_STATUSES).gte('checkin_date', todayIso()).lte('checkin_date', addDaysIso(todayIso(), 7));
      break;
    case 'staying':
      query = query.eq('status', 'checked_in');
      break;
    case 'completed':
      query = query.eq('status', 'completed');
      break;
    case 'cancelled':
      query = query.in('status', ['cancelled', 'awaiting_refund', 'refunded']);
      break;
    case 'ota':
      query = query.eq('status', 'external_synced');
      break;
    default:
      if (f.status) query = query.eq('status', f.status);
      else query = query.neq('status', 'cancelled');
  }

  if (f.roomType === '包棟') query = query.eq('whole_house', true);
  else if (f.roomType) query = query.ilike('room_type_label', `%${f.roomType}%`);
  if (f.keyword.trim()) {
    const kw = f.keyword.trim().replace(/[%,()]/g, '');
    query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data || []) as BookingRow[];
  return { rows, hasMore: rows.length === pageSize };
}

/** 各狀態的即時筆數：輕量查詢（只抓 status 欄位），前端算每個狀態幾筆。 */
export async function fetchStatusCounts(): Promise<Record<string, number>> {
  const { data } = await supabase.from('bookings').select('status');
  const counts: Record<string, number> = {};
  for (const row of data || []) counts[row.status] = (counts[row.status] || 0) + 1;
  return counts;
}

export async function fetchBooking(id: string): Promise<BookingRow | null> {
  const { data, error } = await supabase.from('bookings').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as BookingRow) || null;
}

/** 房間選項：只有「房間」類型會被拿來開房、算布巾；公共空間不在此列。 */
export async function fetchRooms(): Promise<RoomOption[]> {
  const { data } = await supabase.from('room_types').select('id, name, floor, capacity, security_deposit').eq('type', '房間').order('display_order');
  return (data || []) as RoomOption[];
}

/** 押金與訂金比例的預設值來自「訂房規則」，人工建單按「重算」會套用同一套算法，跟 LINE 自動報價一致。 */
export async function fetchMoneyDefaults(): Promise<{ wholeHouseSecurity: number; percent: number }> {
  const { data } = await supabase.from('operational_settings').select('whole_house_security_deposit, deposit_percent').single();
  if (!data) return { wholeHouseSecurity: 3000, percent: 30 };
  return {
    wholeHouseSecurity: Number(data.whole_house_security_deposit ?? 3000),
    percent: Number(data.deposit_percent ?? 30),
  };
}

/** 布巾資料表可能還沒建立（schema 尚未執行），查不到就當作沒啟用這個功能，不擋訂單頁。 */
export async function fetchLinenSetup(): Promise<{ items: LinenItem[]; defaults: RoomLinenDefault[] }> {
  const [itemRes, defRes] = await Promise.all([
    supabase.from('linen_items').select('*').eq('is_active', true).order('display_order'),
    supabase.from('room_type_linen_defaults').select('*'),
  ]);
  if (itemRes.error || defRes.error) return { items: [], defaults: [] };
  return { items: (itemRes.data || []) as LinenItem[], defaults: (defRes.data || []) as RoomLinenDefault[] };
}

export async function fetchBookingLinen(bookingId: string): Promise<{ roomIds: string[]; usage: LinenUsageRow[] }> {
  const [roomRes, usageRes] = await Promise.all([
    supabase.from('booking_rooms').select('room_type_id').eq('booking_id', bookingId),
    supabase.from('booking_linen_usage').select('linen_item_id, quantity, unit_price, is_manual').eq('booking_id', bookingId),
  ]);
  return {
    roomIds: (roomRes.data || []).map((r: any) => r.room_type_id),
    usage: (usageRes.data || []) as LinenUsageRow[],
  };
}

export interface BookingLogRow {
  id: string;
  action: string;
  actor_type: 'user' | 'system';
  actor_name: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  level: 'info' | 'error';
  error_message?: string | null;
  created_at: string;
}

/**
 * 這張訂單的操作紀錄（狀態時間軸用）。operation_logs 只有管理員讀得到（RLS admin_only），
 * 呼叫端要先確認 audit.view 權限，沒權限時不要打這支、也不要當成錯誤。
 */
export async function fetchBookingLogs(orderNumber: string): Promise<BookingLogRow[]> {
  const { data, error } = await supabase
    .from('operation_logs')
    .select('id, action, actor_type, actor_name, before, after, level, error_message, created_at')
    .eq('target', orderNumber)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []) as BookingLogRow[];
}

/** 訂單來源標籤：OTA 平台名 ／ LINE ／ 手動建單。 */
export function bookingSourceLabel(row: Pick<BookingRow, 'booking_source' | 'line_user_id' | 'status'>): string {
  const source = row.booking_source || 'direct';
  if (source !== 'direct' || row.status === 'external_synced') {
    const names: Record<string, string> = { airbnb: 'Airbnb', booking: 'Booking.com', agoda: 'Agoda', trip: 'Trip.com' };
    return names[source] || 'OTA';
  }
  return row.line_user_id ? 'LINE' : '手動';
}

/** 尾款＝總額－訂金；沒有總額就算不出來。 */
export function bookingBalance(row: Pick<BookingRow, 'total_amount' | 'deposit'>): number | null {
  return row.total_amount != null ? Number(row.total_amount) - Number(row.deposit || 0) : null;
}

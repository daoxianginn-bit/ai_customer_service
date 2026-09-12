import { supabase } from '../../lib/supabase';
import { DEPOSIT_OR_LATER_STATUSES } from '../../lib/bookingStatus';
import type { BookingRow } from '../booking/bookingQueries';
import type { ConversationMessage } from '../service/serviceQueries';

// ========================================================================
// 客戶資料（V2 §41–42）。客戶＝LINE 官方帳號的聯絡人（user_states），沒有獨立的 customers 表；
// 訂單數、消費、最近入住全部即時從 bookings 算，不另外複製一份（§42）。
// ========================================================================

export interface CustomerRow {
  line_user_id: string;
  channel_id: string;
  nickname: string | null;
  avatar_url: string | null;
  last_message_at: string | null;
  first_message_at: string | null;
  marketing_opt_out: boolean;
  is_human_mode?: boolean;
  /** 從 bookings 即時算 */
  bookingCount: number;
  paidCount: number;
  totalSpend: number;
  lastCheckin: string | null;
  hasAnyBooking: boolean;
  hasConfirmed: boolean;
}

export type CustomerStatus = 'missing_nickname' | 'ordered' | 'inquiry_only' | 'interacted';

export const CUSTOMER_STATUS_META: Record<CustomerStatus, { label: string; tone: 'warning' | 'success' | 'info' | 'neutral' }> = {
  missing_nickname: { label: '未取得暱稱', tone: 'warning' },
  ordered: { label: '已下訂', tone: 'success' },
  inquiry_only: { label: '僅諮詢', tone: 'info' },
  interacted: { label: '已互動', tone: 'neutral' },
};

export function customerStatus(c: Pick<CustomerRow, 'nickname' | 'hasConfirmed' | 'hasAnyBooking'>): CustomerStatus {
  if (!c.nickname) return 'missing_nickname';
  if (c.hasConfirmed) return 'ordered';
  if (c.hasAnyBooking) return 'inquiry_only';
  return 'interacted';
}

export type CustomerQuickView = 'all' | 'today' | '7days' | 'missing' | 'ordered';

export const CUSTOMER_QUICK_VIEWS: { value: CustomerQuickView; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今日互動' },
  { value: '7days', label: '近 7 天' },
  { value: 'ordered', label: '已下訂' },
  { value: 'missing', label: '未取得暱稱' },
];

export interface CustomerFilters {
  channelId: string;
  keyword: string;
  from: string;
  to: string;
  view: CustomerQuickView;
}

export interface LineChannelOption { id: string; name: string; role: string }

/** 目前檢視哪個官方帳號的聯絡人。LINE 的 user ID 是各官方帳號獨立的，一次只看一個帳號。 */
export async function fetchChannelOptions(): Promise<LineChannelOption[]> {
  const { data } = await supabase.from('line_channels').select('id, name, role').eq('is_active', true).order('display_order');
  return (data || []) as LineChannelOption[];
}

/** 把 bookings 統計併進聯絡人列。 */
function summarise(states: any[], bookings: any[]): CustomerRow[] {
  const byUser: Record<string, any[]> = {};
  for (const b of bookings) (byUser[b.line_user_id] ||= []).push(b);
  return states.map((s) => {
    const list = byUser[s.line_user_id] || [];
    const paid = list.filter((b) => DEPOSIT_OR_LATER_STATUSES.includes(b.status));
    return {
      line_user_id: s.line_user_id,
      channel_id: s.channel_id,
      nickname: s.nickname,
      avatar_url: s.avatar_url,
      last_message_at: s.last_message_at,
      first_message_at: s.first_message_at,
      marketing_opt_out: !!s.marketing_opt_out,
      is_human_mode: !!s.is_human_mode,
      bookingCount: list.length,
      paidCount: paid.length,
      totalSpend: paid.reduce((sum, b) => sum + Number(b.total_amount || 0), 0),
      lastCheckin: paid.map((b) => b.checkin_date).filter(Boolean).sort().pop() || null,
      hasAnyBooking: list.length > 0,
      hasConfirmed: paid.length > 0,
    };
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export async function listCustomers(f: CustomerFilters, page: number, pageSize: number): Promise<{ rows: CustomerRow[]; hasMore: boolean }> {
  let query = supabase
    .from('user_states')
    .select('line_user_id, channel_id, nickname, avatar_url, last_message_at, first_message_at, marketing_opt_out, is_human_mode')
    .eq('channel_id', f.channelId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);

  if (f.keyword.trim()) {
    const kw = f.keyword.trim().replace(/[%,()]/g, '');
    query = query.or(`nickname.ilike.%${kw}%,line_user_id.ilike.%${kw}%`);
  }
  const today = isoDate(new Date());
  const weekAgo = isoDate(new Date(Date.now() - 6 * 86400e3));
  let from = f.from, to = f.to;
  if (f.view === 'today') { from = today; to = today; }
  if (f.view === '7days') { from = weekAgo; to = today; }
  if (from) query = query.gte('last_message_at', `${from}T00:00:00`);
  if (to) query = query.lte('last_message_at', `${to}T23:59:59`);
  if (f.view === 'missing') query = query.is('nickname', null);

  const { data: states, error } = await query;
  if (error) throw error;
  const ids = (states || []).map((s: any) => s.line_user_id);
  let bookings: any[] = [];
  if (ids.length) {
    const { data } = await supabase.from('bookings').select('line_user_id, status, checkin_date, total_amount').in('line_user_id', ids);
    bookings = data || [];
  }
  let rows = summarise(states || [], bookings);
  // 「已下訂」要看 bookings，資料庫端篩不了，這一頁先撈回來再過濾（頁數會少於 pageSize，屬可接受）
  if (f.view === 'ordered') rows = rows.filter((r) => r.hasConfirmed);
  return { rows, hasMore: (states || []).length === pageSize };
}

export interface CustomerDetail {
  customer: CustomerRow;
  bookings: BookingRow[];
  conversations: ConversationMessage[];
}

export async function fetchCustomerDetail(lineUserId: string): Promise<CustomerDetail | null> {
  const { data: state, error } = await supabase
    .from('user_states')
    .select('line_user_id, channel_id, nickname, avatar_url, last_message_at, first_message_at, marketing_opt_out, is_human_mode')
    .eq('line_user_id', lineUserId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!state) return null;
  const [bRes, cRes] = await Promise.all([
    supabase.from('bookings').select('*').eq('line_user_id', lineUserId).order('created_at', { ascending: false }),
    supabase.from('conversations').select('*').eq('line_user_id', lineUserId).order('created_at', { ascending: false }).limit(20),
  ]);
  const bookings = (bRes.data || []) as BookingRow[];
  return {
    customer: summarise([state], bookings)[0],
    bookings,
    conversations: ((cRes.data || []) as ConversationMessage[]).reverse(),
  };
}

export async function fetchPrimaryAdminId(): Promise<string | null> {
  const { data } = await supabase.from('settings').select('primary_admin_id').limit(1).maybeSingle();
  return data?.primary_admin_id || null;
}

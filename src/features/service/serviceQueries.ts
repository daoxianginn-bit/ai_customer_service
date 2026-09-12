import { supabase } from '../../lib/supabase';
import type { BookingRow } from '../booking/bookingQueries';

// ========================================================================
// 客服工作台的資料（V2 §28–31）。三種來源：
//   user_states     每位 LINE 客人一列：暱稱、大頭貼、是否真人模式、最近互動、訂房 session
//   conversations   每則訊息（含客人訊息的處理過程 meta）
//   handover_logs   客人喊「找真人」的紀錄（open＝還沒有人處理）
// 沒有新資料表；「最後一句」是把這一頁客人的最近訊息一次撈回來在前端配對。
// ========================================================================

export type ConversationFilter = 'all' | 'handover' | 'human' | 'ai';

export const FILTER_OPTIONS: { value: ConversationFilter; label: string; hint: string }[] = [
  { value: 'handover', label: '待人工', hint: '客人喊了轉真人關鍵字、還沒有人回應（AI 仍會照常回覆）' },
  { value: 'human', label: '真人服務中', hint: '真人模式：AI 暫停回覆，由客服直接對話' },
  { value: 'ai', label: 'AI 服務中', hint: 'AI 正常回覆中' },
  { value: 'all', label: '全部', hint: '所有互動過的客人' },
];

export interface ConversationUser {
  line_user_id: string;
  channel_id: string | null;
  nickname: string | null;
  avatar_url: string | null;
  is_human_mode: boolean;
  last_human_interaction: string | null;
  last_message_at: string | null;
  booking_session: string | null;
  marketing_opt_out?: boolean;
  /** 尚未處理的轉真人請求（可能多筆，取最新） */
  openHandover?: HandoverLog | null;
  /** 最後一句（客人或系統／AI／真人） */
  lastMessage?: Pick<ConversationMessage, 'content' | 'direction' | 'source' | 'created_at'> | null;
}

export interface HandoverLog {
  id: string;
  line_user_id: string;
  nickname: string | null;
  triggered_keyword: string | null;
  started_at: string;
  ended_at: string | null;
  resolved_by: string | null;
  status: 'open' | 'closed';
}

// 客人訊息的處理過程診斷，由 line-webhook 寫在 inbound 那一列（見 supabase_schema.sql 的
// conversations.meta 說明）。steps／errors／elapsed_ms 一定有；其餘鍵值依走到哪條路而定。
export interface TurnMeta {
  elapsed_ms: number;
  steps: string[];
  errors: string[];
  [key: string]: unknown;
}

export interface ConversationMessage {
  id: string;
  line_user_id: string;
  nickname: string | null;
  direction: 'inbound' | 'outbound';
  content: string;
  source: 'user' | 'ai_gpt' | 'ai_gemini' | 'human_agent' | 'system' | string;
  created_at: string;
  meta?: TurnMeta | null;
}

export const SOURCE_LABEL: Record<string, string> = {
  user: '客人',
  ai_gpt: 'AI（GPT）',
  ai_gemini: 'AI（Gemini）',
  human_agent: '真人客服',
  system: '系統',
};

export const USERS_PAGE_SIZE = 30;

export async function fetchOpenHandovers(): Promise<HandoverLog[]> {
  const { data } = await supabase.from('handover_logs').select('*').eq('status', 'open').order('started_at', { ascending: false });
  return (data || []) as HandoverLog[];
}

/** 對話清單（一頁）。回傳時已附上 openHandover 與 lastMessage。 */
export async function listConversationUsers(opts: { filter: ConversationFilter; keyword: string; page: number }): Promise<{ users: ConversationUser[]; hasMore: boolean; openHandovers: HandoverLog[] }> {
  const openHandovers = await fetchOpenHandovers();
  const handoverIds = Array.from(new Set(openHandovers.map((h) => h.line_user_id)));

  let query = supabase
    .from('user_states')
    .select('line_user_id, channel_id, nickname, avatar_url, is_human_mode, last_human_interaction, last_message_at, booking_session, marketing_opt_out')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range(opts.page * USERS_PAGE_SIZE, opts.page * USERS_PAGE_SIZE + USERS_PAGE_SIZE - 1);

  if (opts.filter === 'human') query = query.eq('is_human_mode', true);
  else if (opts.filter === 'ai') query = query.eq('is_human_mode', false);
  else if (opts.filter === 'handover') {
    if (!handoverIds.length) return { users: [], hasMore: false, openHandovers };
    query = query.in('line_user_id', handoverIds);
  }
  if (opts.keyword.trim()) {
    const kw = opts.keyword.trim().replace(/[%,()]/g, '');
    query = query.or(`line_user_id.ilike.%${kw}%,nickname.ilike.%${kw}%`);
  }

  const { data, error } = await query;
  if (error) throw error;
  const users = (data || []) as ConversationUser[];

  // 最後一句：只撈這一頁客人的最近 300 則，前端取每人第一則。比每人各查一次省很多請求。
  if (users.length) {
    const { data: msgs } = await supabase
      .from('conversations')
      .select('line_user_id, content, direction, source, created_at')
      .in('line_user_id', users.map((u) => u.line_user_id))
      .order('created_at', { ascending: false })
      .limit(300);
    const lastByUser = new Map<string, ConversationUser['lastMessage']>();
    for (const m of (msgs || []) as any[]) if (!lastByUser.has(m.line_user_id)) lastByUser.set(m.line_user_id, m);
    for (const u of users) {
      u.lastMessage = lastByUser.get(u.line_user_id) || null;
      u.openHandover = openHandovers.find((h) => h.line_user_id === u.line_user_id) || null;
    }
  }
  return { users, hasMore: users.length === USERS_PAGE_SIZE, openHandovers };
}

export async function fetchConversationUser(lineUserId: string): Promise<ConversationUser | null> {
  const openRes = await supabase.from('handover_logs').select('*').eq('line_user_id', lineUserId).eq('status', 'open').order('started_at', { ascending: false }).limit(1).maybeSingle();
  const { data } = await supabase
    .from('user_states')
    .select('line_user_id, channel_id, nickname, avatar_url, is_human_mode, last_human_interaction, last_message_at, booking_session, marketing_opt_out')
    .eq('line_user_id', lineUserId)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { ...(data as ConversationUser), openHandover: (openRes.data as HandoverLog) || null };
}

export const MESSAGES_PAGE = 50;

/** 對話內容：預設最近 50 則，往上捲再載入更早的（lazy load，V2 §143）。回傳依時間由舊到新。 */
export async function fetchMessages(lineUserId: string, before?: string): Promise<{ messages: ConversationMessage[]; hasMore: boolean }> {
  let query = supabase
    .from('conversations')
    .select('*')
    .eq('line_user_id', lineUserId)
    .order('created_at', { ascending: false })
    .limit(MESSAGES_PAGE);
  if (before) query = query.lt('created_at', before);
  const { data, error } = await query;
  if (error) throw error;
  const rows = ((data || []) as ConversationMessage[]).reverse();
  return { messages: rows, hasMore: rows.length === MESSAGES_PAGE };
}

/** 這位客人的訂單（最近 5 筆），右側脈絡欄用。 */
export async function fetchUserBookings(lineUserId: string): Promise<BookingRow[]> {
  const { data } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, checkin_date, checkout_date, nights, headcount, status, total_amount, deposit, whole_house, room_type_label, created_at')
    .eq('line_user_id', lineUserId)
    .order('created_at', { ascending: false })
    .limit(5);
  return (data || []) as BookingRow[];
}

export async function fetchHandoverHistory(limit = 100): Promise<HandoverLog[]> {
  const { data, error } = await supabase.from('handover_logs').select('*').order('started_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data || []) as HandoverLog[];
}

/** booking_session 是 JSON 字串，解析失敗就當沒有。 */
export function parseBookingSession(raw: string | null | undefined): { phase: string; stepIndex: number; collected: Record<string, string>; bookingId: string | null; updatedAt: number } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

export const SESSION_PHASE_LABEL: Record<string, string> = {
  in_flow: '收集資料中',
  awaiting_confirmation: '已報價，等客人回「是／否」',
  awaiting_remittance: '已成立預訂，等客人回報匯款',
};

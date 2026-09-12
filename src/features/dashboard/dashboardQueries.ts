import { supabase } from '../../lib/supabase';
import { OCCUPYING_STATUSES } from '../../lib/bookingStatus';
import { addDaysIso, todayIso } from '../../lib/format';
import type { BookingRow } from '../booking/bookingQueries';

// ========================================================================
// 工作台（V2 §19、§110、§145）的資料。全部只讀現有表，不新增資料表。
// ========================================================================

export interface DashboardKpis {
  checkinsToday: number;
  checkoutsToday: number;
  paymentVerify: number;   // awaiting_confirmation
  handovers: number;       // user_states.is_human_mode
  balanceDue: number;      // awaiting_balance
  depositReturn: number;   // deposit_processing
  refund: number;          // awaiting_refund
  waitlist: number;        // pending_manual_conflict + waitlist_blocked_by
  manualConflict: number;  // pending_manual_conflict 無候補對象
  otaConflict: number;     // ota_conflict_with 有值
}

const head = (q: any) => q.then((r: any) => r.count ?? 0);

export async function fetchKpis(): Promise<DashboardKpis> {
  const today = todayIso();
  const [checkinsToday, checkoutsToday, paymentVerify, handovers, balanceDue, depositReturn, refund, waitlist, manualConflict, otaConflict] = await Promise.all([
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('checkin_date', today).in('status', OCCUPYING_STATUSES)),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('checkout_date', today).in('status', OCCUPYING_STATUSES)),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_confirmation')),
    head(supabase.from('user_states').select('line_user_id', { count: 'exact', head: true }).eq('is_human_mode', true)),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_balance')),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'deposit_processing')),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'awaiting_refund')),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'pending_manual_conflict').not('waitlist_blocked_by', 'is', null)),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).eq('status', 'pending_manual_conflict').is('waitlist_blocked_by', null)),
    head(supabase.from('bookings').select('id', { count: 'exact', head: true }).not('ota_conflict_with', 'is', null)),
  ]);
  return { checkinsToday, checkoutsToday, paymentVerify, handovers, balanceDue, depositReturn, refund, waitlist, manualConflict, otaConflict };
}

/** 未來 7 日（含今天）要入住、且已鎖房的訂單；依入住日排。 */
export async function fetchUpcomingCheckins(days = 7): Promise<BookingRow[]> {
  const today = todayIso();
  const { data, error } = await supabase
    .from('bookings')
    .select('id, order_number, name, nickname, headcount, checkin_date, checkout_date, nights, whole_house, room_type_label, status, booking_source, line_user_id')
    .gte('checkin_date', today)
    .lte('checkin_date', addDaysIso(today, days - 1))
    .in('status', OCCUPYING_STATUSES)
    .order('checkin_date', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as BookingRow[];
}

export type HealthLevel = 'ok' | 'warning' | 'error' | 'unset';
export interface HealthItem {
  key: 'line' | 'ai' | 'ota' | 'google' | 'automation';
  label: string;
  level: HealthLevel;
  /** 一句話說明；正常時可省略 */
  detail?: string;
  href: string;
}

/**
 * 系統健康（§19.4、§145）：只給 正常／警告／異常／未設定 四種，不放 HTTP code。
 * 要讀 settings／line_channels／scheduled_tasks，這些表只有管理員讀得到，呼叫端先判斷權限。
 */
export async function fetchSystemHealth(): Promise<HealthItem[]> {
  const [settingsRes, lineRes, otaRes, tasksRes] = await Promise.all([
    supabase.from('settings').select('is_ai_enabled, active_ai, gpt_api_key, gemini_api_key, google_calendar_id, google_service_account_json, google_calendar_last_sync_status, google_calendar_last_synced_at, google_calendar_last_sync_summary').limit(1).maybeSingle(),
    supabase.from('line_channels').select('id, name, role, is_active, channel_access_token'),
    supabase.from('ota_channels').select('id, name, is_active, import_ics_url, last_import_status, last_imported_at, last_import_summary'),
    supabase.from('scheduled_tasks').select('id, name, is_active, last_run_status, last_run_at, last_run_summary, next_run_at'),
  ]);
  const s: any = settingsRes.data || {};
  const lines: any[] = lineRes.data || [];
  const otas: any[] = otaRes.data || [];
  const tasks: any[] = tasksRes.data || [];

  const items: HealthItem[] = [];

  // LINE：至少一個啟用中、有 token 的客戶用官方帳號
  const activeLines = lines.filter((c) => c.is_active && c.channel_access_token);
  const customerLine = activeLines.find((c) => c.role === 'customer');
  items.push(!lines.length
    ? { key: 'line', label: 'LINE', level: 'unset', detail: '尚未新增官方帳號', href: '/integrations/line' }
    : !customerLine
      ? { key: 'line', label: 'LINE', level: 'error', detail: '沒有啟用中的「客戶用」官方帳號', href: '/integrations/line' }
      : { key: 'line', label: 'LINE', level: 'ok', detail: `${activeLines.length} 個帳號啟用中`, href: '/integrations/line' });

  // AI：開關＋目前引擎有沒有金鑰
  const key = s.active_ai === 'gemini' ? s.gemini_api_key : s.gpt_api_key;
  items.push(!settingsRes.data
    ? { key: 'ai', label: 'AI', level: 'unset', detail: '讀不到設定', href: '/admin/ai' }
    : !key
      ? { key: 'ai', label: 'AI', level: 'unset', detail: `${s.active_ai === 'gemini' ? 'Gemini' : 'OpenAI'} 金鑰未填`, href: '/admin/ai' }
      : !s.is_ai_enabled
        ? { key: 'ai', label: 'AI', level: 'warning', detail: 'AI 自動回覆已停用', href: '/admin/ai' }
        : { key: 'ai', label: 'AI', level: 'ok', detail: s.active_ai === 'gemini' ? 'Gemini' : 'OpenAI GPT', href: '/admin/ai' });

  // OTA：有匯入網址的啟用頻道，最近一次同步是否失敗
  const importing = otas.filter((c) => c.is_active && c.import_ics_url);
  const failed = importing.filter((c) => c.last_import_status === 'failed');
  items.push(!otas.length
    ? { key: 'ota', label: 'OTA', level: 'unset', detail: '尚未串接平台', href: '/integrations/ota' }
    : failed.length
      ? { key: 'ota', label: 'OTA', level: 'error', detail: `${failed.map((c) => c.name).join('、')} 同步失敗`, href: '/integrations/ota' }
      : { key: 'ota', label: 'OTA', level: 'ok', detail: importing.length ? `${importing.length} 個頻道同步中` : '僅匯出', href: '/integrations/ota' });

  // Google 行事曆
  items.push(!s.google_calendar_id || !s.google_service_account_json
    ? { key: 'google', label: 'Google 行事曆', level: 'unset', detail: '尚未填入行事曆 ID 與服務帳號', href: '/integrations/google-calendar' }
    : s.google_calendar_last_sync_status === 'failed'
      ? { key: 'google', label: 'Google 行事曆', level: 'error', detail: s.google_calendar_last_sync_summary || '最近一次同步失敗', href: '/integrations/google-calendar' }
      : { key: 'google', label: 'Google 行事曆', level: 'ok', href: '/integrations/google-calendar' });

  // 自動化排程
  const active = tasks.filter((t) => t.is_active);
  const failedTasks = active.filter((t) => t.last_run_status === 'failed');
  items.push(!tasks.length
    ? { key: 'automation', label: '自動化', level: 'unset', detail: '尚未建立排程', href: '/automation/rules' }
    : failedTasks.length
      ? { key: 'automation', label: '自動化', level: 'error', detail: `${failedTasks.map((t) => t.name).join('、')} 上次執行失敗`, href: '/automation/history' }
      : !active.length
        ? { key: 'automation', label: '自動化', level: 'warning', detail: '所有排程都已停用', href: '/automation/rules' }
        : { key: 'automation', label: '自動化', level: 'ok', detail: `${active.length} 個排程啟用中`, href: '/automation/rules' });

  return items;
}

/** 今日 AI 對話則數與轉接次數（工作台 KPI 補充）。 */
export async function fetchTodayConversationStats(): Promise<{ conversations: number; handovers: number }> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const [c, h] = await Promise.all([
    head(supabase.from('conversations').select('id', { count: 'exact', head: true }).gte('created_at', start.toISOString())),
    head(supabase.from('handover_logs').select('id', { count: 'exact', head: true }).gte('started_at', start.toISOString())),
  ]);
  return { conversations: c, handovers: h };
}

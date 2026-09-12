import { supabase } from '../../lib/supabase';
import { bookingStatusLabel } from '../../lib/bookingStatus';
import { formatDateRange, formatDateTime, formatShortDate } from '../../lib/format';
import type { BookingRow } from '../booking/bookingQueries';

// ========================================================================
// 待辦事項（V2 §19.2、§27）：系統沒有 tasks 資料表，待辦是「從現有資料推導」出來的——
// 卡在人工關卡的訂單、撞期、候補、真人轉接、系統錯誤。這裡把各來源整理成同一種 Task 形狀，
// 工作台的「今日待辦」與「待辦事項中心」共用同一份規則，兩邊看到的清單才會一致。
//
// 嚴重度：critical（撞期／逾期／系統錯誤，今天不處理會出事）、warning（等人動手的錢）、
// normal（例行收尾）。排序先看嚴重度，再看時間（越早到期越前面）。
// ========================================================================

export type TaskType =
  | 'OTA_CONFLICT' | 'MANUAL_CONFLICT' | 'WAITLIST'
  | 'PAYMENT_VERIFY' | 'BALANCE_DUE' | 'REFUND' | 'DEPOSIT_RETURN'
  | 'HANDOVER' | 'SYSTEM_ERROR';

export type TaskSeverity = 'critical' | 'warning' | 'normal';
export type TaskGroup = 'booking' | 'service' | 'system';

export interface Task {
  id: string;
  type: TaskType;
  group: TaskGroup;
  severity: TaskSeverity;
  title: string;
  /** 一行摘要：客戶、日期、金額 */
  detail: string;
  /** 次要資訊（末五碼、期限、來源） */
  meta?: string;
  /** 點「處理」要去哪 */
  href: string;
  actionLabel: string;
  /** 排序用：到期或發生時間 */
  dueAt?: string | null;
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  OTA_CONFLICT: 'OTA 房況衝突',
  MANUAL_CONFLICT: '待人工確認（撞期）',
  WAITLIST: '候補中',
  PAYMENT_VERIFY: '訂金待核對',
  BALANCE_DUE: '尾款未收',
  REFUND: '待退款',
  DEPOSIT_RETURN: '押金處理',
  HANDOVER: '真人客服待處理',
  SYSTEM_ERROR: '系統錯誤',
};

const SEVERITY_ORDER: Record<TaskSeverity, number> = { critical: 0, warning: 1, normal: 2 };

const who = (b: BookingRow) => b.name || b.nickname || '未取得';

function bookingTask(b: BookingRow, type: TaskType, severity: TaskSeverity, extra: Partial<Task> = {}): Task {
  return {
    id: `${type}:${b.id}`,
    type,
    group: 'booking',
    severity,
    title: TASK_TYPE_LABELS[type],
    detail: `${who(b)}・${formatDateRange(b.checkin_date, b.checkout_date) || '日期未定'}${b.headcount ? `・${b.headcount} 人` : ''}`,
    href: `/bookings/${b.id}`,
    actionLabel: '開啟訂單',
    dueAt: b.checkin_date || null,
    ...extra,
  };
}

/** 從一批訂單推導出待辦（純函式，工作台與待辦中心都用；測試也好寫）。 */
export function deriveBookingTasks(rows: BookingRow[], now = new Date()): Task[] {
  const tasks: Task[] = [];
  for (const b of rows) {
    if (b.ota_conflict_with) {
      tasks.push(bookingTask(b, 'OTA_CONFLICT', 'critical', {
        detail: `${b.booking_source && b.booking_source !== 'direct' ? b.booking_source : 'OTA'} ${formatDateRange(b.checkin_date, b.checkout_date)}`,
        meta: '與本地訂單日期重疊，需人工查核',
        actionLabel: '處理',
      }));
    }
    switch (b.status) {
      case 'pending_manual_conflict':
        tasks.push(b.waitlist_blocked_by
          ? bookingTask(b, 'WAITLIST', 'normal', { meta: '等被卡住的訂單有結果後，系統會自動重新報價' })
          : bookingTask(b, 'MANUAL_CONFLICT', 'critical', { meta: '系統偵測到撞期，請核實空房後改狀態', actionLabel: '處理' }));
        break;
      case 'awaiting_confirmation': {
        const overdue = !!b.payment_deadline_at && new Date(b.payment_deadline_at).getTime() < now.getTime();
        tasks.push(bookingTask(b, 'PAYMENT_VERIFY', overdue ? 'critical' : 'warning', {
          meta: [b.remit_last5 ? `末五碼 ${b.remit_last5}` : '客人尚未回報末五碼', b.payment_deadline_at ? `${overdue ? '已逾期' : '期限'} ${formatDateTime(b.payment_deadline_at)}` : ''].filter(Boolean).join('・'),
          dueAt: b.payment_deadline_at || b.checkin_date || null,
        }));
        break;
      }
      case 'awaiting_balance':
        tasks.push(bookingTask(b, 'BALANCE_DUE', 'warning', { meta: `入住 ${formatShortDate(b.checkin_date)}，尾款尚未收到` }));
        break;
      case 'awaiting_refund':
        tasks.push(bookingTask(b, 'REFUND', 'warning', { meta: '客人已取消，款項尚未退回', dueAt: b.updated_at || null }));
        break;
      case 'deposit_processing':
        tasks.push(bookingTask(b, 'DEPOSIT_RETURN', 'normal', { meta: `已退房，押金 NT$ ${Number(b.security_deposit || 0).toLocaleString()} 待核對／退還`, dueAt: b.checkout_date || null }));
        break;
    }
  }
  return tasks;
}

export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'));
  });
}

/** 需要人動手的訂單（含撞期旗標）。只撈會變成待辦的狀態，不整表掃。 */
export async function fetchTaskBookings(): Promise<BookingRow[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .or('status.in.(awaiting_confirmation,awaiting_balance,awaiting_refund,deposit_processing,pending_manual_conflict),ota_conflict_with.not.is.null')
    .order('checkin_date', { ascending: true });
  if (error) throw error;
  return (data || []) as BookingRow[];
}

/** 真人客服待處理：user_states.is_human_mode。回傳筆數與最近幾位，做成一張待辦。 */
export async function fetchHandoverTask(): Promise<Task | null> {
  const { data, count } = await supabase
    .from('user_states')
    .select('line_user_id, nickname, last_human_interaction', { count: 'exact' })
    .eq('is_human_mode', true)
    .order('last_human_interaction', { ascending: false })
    .limit(3);
  const n = count ?? (data || []).length;
  if (!n) return null;
  return {
    id: 'HANDOVER',
    type: 'HANDOVER',
    group: 'service',
    severity: 'warning',
    title: TASK_TYPE_LABELS.HANDOVER,
    detail: `${n} 位客人在真人模式：${(data || []).map((u: any) => u.nickname || u.line_user_id).join('、')}${n > 3 ? '…' : ''}`,
    href: '/service',
    actionLabel: '開啟客服工作台',
    dueAt: (data || [])[0]?.last_human_interaction || null,
  };
}

/** 最近 24 小時的系統錯誤（operation_logs level=error）。只有管理員讀得到，呼叫端先判斷權限。 */
export async function fetchSystemErrorTask(): Promise<Task | null> {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, count, error } = await supabase
    .from('operation_logs')
    .select('id, feature, action, error_message, created_at', { count: 'exact' })
    .eq('level', 'error')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return null;
  const n = count ?? 0;
  if (!n) return null;
  const last = (data || [])[0] as any;
  return {
    id: 'SYSTEM_ERROR',
    type: 'SYSTEM_ERROR',
    group: 'system',
    severity: 'critical',
    title: TASK_TYPE_LABELS.SYSTEM_ERROR,
    detail: `24 小時內 ${n} 筆錯誤，最近：${last?.feature || ''} ${last?.action || ''}`,
    meta: last?.error_message ? String(last.error_message).slice(0, 80) : undefined,
    href: '/admin/errors',
    actionLabel: '查看錯誤紀錄',
    dueAt: last?.created_at || null,
  };
}

export function taskStatusHint(t: Task): string {
  if (t.group !== 'booking') return '';
  const status = t.type === 'OTA_CONFLICT' ? 'external_synced' : ({
    MANUAL_CONFLICT: 'pending_manual_conflict', WAITLIST: 'pending_manual_conflict', PAYMENT_VERIFY: 'awaiting_confirmation',
    BALANCE_DUE: 'awaiting_balance', REFUND: 'awaiting_refund', DEPOSIT_RETURN: 'deposit_processing',
  } as Record<string, string>)[t.type];
  return status ? bookingStatusLabel(status) : '';
}

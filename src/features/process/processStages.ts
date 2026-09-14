import type { BookingRow } from '../booking/bookingQueries';

// ========================================================================
// 訂單處理的關卡定義與純函式（不碰資料庫，測試直接 import）。資料存取在 processQueries.ts。
// ========================================================================

export type StageKey = 'awaiting_confirmation' | 'awaiting_balance' | 'deposit_processing' | 'awaiting_refund' | 'checkin';
export type StageGroup = 'payment' | 'checkin';
export type EditableField = 'remit' | 'password' | 'linen';

export interface StageDef {
  key: StageKey;
  group: StageGroup;
  /** 佇列標題 */
  title: string;
  statuses: string[];
  /** 高亮動作鈕文字 */
  action: string;
  /** 高亮鈕與標籤的顏色（每關不同，一眼分得出來） */
  color: string;
  colorLight: string;
  /** 「確認並推進」要推到哪一關；null＝這一關不推進（由排程自動轉） */
  nextStatus: string | null;
  /** true＝「確認」本身就是推進（待確認：核對到帳＝已預定） */
  confirmAdvances: boolean;
  fields: EditableField[];
  /** 通知範本的預設標題（settings.stage_templates 沒設定時用這個名字找） */
  templateTitle: string;
  /** 按確認需要的權限 */
  permission: string;
  hint: string;
  /** 這一關要處理的金額是哪一筆（待確認看訂金、待收尾款看尾款、押金處理看待退押金…） */
  amountLabel: string;
  amountOf: (b: BookingRow) => number | null;
}

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const balanceOf = (b: BookingRow) => (num(b.total_amount) == null ? null : Number(b.total_amount) - Number(b.deposit || 0));

export const STAGES: StageDef[] = [
  {
    key: 'awaiting_confirmation', group: 'payment', title: '待確認', statuses: ['awaiting_confirmation'], action: '預約確認',
    color: '#d97706', colorLight: '#fef3c7', nextStatus: 'reserved', confirmAdvances: true, fields: ['remit'],
    templateTitle: '訂房成功通知', permission: 'booking.payment.verify',
    hint: '人工核對訂金已到帳後，填入匯款末五碼按確認；訂單會直接變成「已預定」（停在待確認會被自動取消排程當成未付款）。',
    amountLabel: '訂金', amountOf: (b) => num(b.deposit),
  },
  {
    key: 'awaiting_balance', group: 'payment', title: '待收尾款', statuses: ['awaiting_balance'], action: '收尾款',
    color: '#ea580c', colorLight: '#ffedd5', nextStatus: 'awaiting_checkin', confirmAdvances: false, fields: [],
    templateTitle: '已繳清尾款', permission: 'booking.payment.verify',
    hint: '收到尾款後按確認；要讓訂單進到「待入住」請按「確認並推進」。',
    amountLabel: '尾款', amountOf: balanceOf,
  },
  {
    key: 'deposit_processing', group: 'payment', title: '押金處理', statuses: ['deposit_processing'], action: '退房押金處理',
    color: '#4f46e5', colorLight: '#e0e7ff', nextStatus: 'completed', confirmAdvances: false, fields: [],
    templateTitle: '押金退款', permission: 'booking.refund.process',
    hint: '核對房間狀況、退還（或扣除）押金後按確認；「確認並推進」會把訂單結案為「已處理」。',
    amountLabel: '待退押金', amountOf: (b) => num(b.security_deposit),
  },
  {
    key: 'awaiting_refund', group: 'payment', title: '待退款', statuses: ['awaiting_refund'], action: '退款完成',
    color: '#e11d48', colorLight: '#ffe4e6', nextStatus: 'refunded', confirmAdvances: false, fields: [],
    templateTitle: '取消退款', permission: 'booking.refund.process',
    hint: '款項退回客人後按確認；「確認並推進」會把訂單標成「已退款」。',
    amountLabel: '已收訂金', amountOf: (b) => num(b.deposit),
  },
  {
    key: 'checkin', group: 'checkin', title: '待入住／入住中', statuses: ['awaiting_checkin', 'checked_in'], action: '密碼更新',
    color: '#0284c7', colorLight: '#e0f2fe', nextStatus: null, confirmAdvances: false, fields: ['password', 'linen'],
    templateTitle: '入住密碼發送', permission: 'booking.edit',
    hint: '設定或修改大門密碼、調整這筆訂單的洗物數量。狀態由排程在入住日／退房日自動轉，這裡不用推進。',
    amountLabel: '押金', amountOf: (b) => num(b.security_deposit),
  },
];

export const stageByKey = (key: StageKey) => STAGES.find((s) => s.key === key)!;
export const stageForStatus = (status: string) => STAGES.find((s) => s.statuses.includes(status)) || null;

/** 佇列排序：越急越上面 */
export function sortQueue(stage: StageDef, rows: BookingRow[]): BookingRow[] {
  const t = (v?: string | null) => (v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER);
  const by = (a: BookingRow, b: BookingRow) => {
    switch (stage.key) {
      case 'awaiting_confirmation': return t(a.payment_deadline_at) - t(b.payment_deadline_at) || t(a.created_at) - t(b.created_at);
      case 'deposit_processing': return t(a.checkout_date) - t(b.checkout_date);
      case 'awaiting_refund': return t(a.updated_at) - t(b.updated_at);
      default: return t(a.checkin_date) - t(b.checkin_date);
    }
  };
  return [...rows].sort(by);
}


/** 這一關的預設範本：先看設定，沒設定就用預設標題找 */
export interface MessageTemplate { id: string; title: string; body: string }

export function defaultTemplateFor(stage: StageDef, templates: MessageTemplate[], map: Record<string, string>): MessageTemplate | null {
  const byId = map[stage.key] ? templates.find((t) => t.id === map[stage.key]) : null;
  return byId || templates.find((t) => t.title === stage.templateTitle) || null;
}

export function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) result = result.split(`[${key}]`).join(value ?? '');
  return result;
}

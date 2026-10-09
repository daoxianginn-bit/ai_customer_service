import type { BookingRow } from '../booking/bookingQueries';
import { computeBalanceDue, hasUnpaidExtraCharges } from '../../lib/extraCharges';
import { BALANCE_PAID_STATUSES } from '../../lib/bookingStatus';

// ========================================================================
// 訂單處理的關卡定義與純函式（不碰資料庫，測試直接 import）。資料存取在 processQueries.ts。
//
// 關卡＝一件「輪到某個職務動手」的事，不是訂單狀態：同一筆訂單可以同時出現在好幾個關卡
// （待入住的訂單，房務要確認洗滌清單、也要設定入住密碼，兩張卡各自記自己的確認）。
// 每個關卡宣告自己需要的權限，頁面只顯示「這個人做得到」的關卡——房務看不到金流，會計看不到布巾。
// ========================================================================

export type StageKey =
  | 'awaiting_confirmation' | 'awaiting_balance' | 'extra_charges' | 'deposit_processing' | 'awaiting_refund'
  | 'linen' | 'checkin_password' | 'room_check' | 'linen_backfill';
export type StageGroup = 'payment' | 'checkin' | 'checkout' | 'backfill';
export type EditableField = 'remit' | 'balance_remit' | 'refund' | 'password' | 'linen' | 'damage' | 'extras';

export const GROUP_LABELS: Record<StageGroup, string> = { payment: '款項處理', checkin: '入住準備', checkout: '退房檢查', backfill: '資料補登' };
export const GROUP_HINTS: Record<StageGroup, string> = {
  payment: '確認錢進來了、或錢退出去了。確認後可以順手通知客人。',
  checkin: '客人到之前要準備好的事。狀態由排程在入住日自動轉，這裡不用推進。',
  checkout: '退房後先回報房況，會計再依回報決定押金退多少。',
  // 這一組刻意不跟「入住準備」合併：裡面會有已經住完的訂單，「客人到之前要準備好的事」那句話對不上。
  backfill: '資料不完整、需要補起來的訂單，包含第三方平台匯入的。補完按確認就會離開這裡。',
};

export interface StageDef {
  key: StageKey;
  group: StageGroup;
  /** 佇列標題 */
  title: string;
  statuses: string[];
  /**
   * 不看狀態、看訂單內容決定要不要出現在這一關（statuses 留空）。追加款收款就是這種：
   * 尾款已收的訂單只要還有未付追加款就要出現，跟它現在是待入住、入住中還是押金處理無關。
   */
  appliesTo?: (b: BookingRow) => boolean;
  /** 高亮動作鈕文字 */
  action: string;
  /** 高亮鈕與標籤的顏色（每關不同，一眼分得出來） */
  color: string;
  colorLight: string;
  /** 「確認並推進」要推到哪一關；null＝這一關不推進（由排程自動轉，或還要等別人） */
  nextStatus: string | null;
  /** true＝「確認」本身就是推進（訂金入款：核對到帳＝已預定） */
  confirmAdvances: boolean;
  fields: EditableField[];
  /** 金額怎麼顯示：full＝完整（會計）、total＝只顯示總額（房務不需要知道錢的細節） */
  money: 'full' | 'total';
  /** 這一關要處理的金額是哪一筆；null＝這一關跟金額無關 */
  amountLabel: string | null;
  amountOf: (b: BookingRow) => number | null;
  /** 實退金額的預設值（押金扣掉房務建議扣款、取消退款退已收訂金） */
  defaultRefund?: (b: BookingRow) => number | null;
  /** 通知範本的預設標題；null＝這一關不發客人通知（洗滌單發給洗滌廠、房況是內部的事） */
  templateTitle: string | null;
  notifyLabel?: string;
  /** 按確認需要的權限 */
  permission: string;
  hint: string;
}

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
const balanceOf = (b: BookingRow) => computeBalanceDue(b);
/** 取消退款的應退：訂金＋已付追加款 */
const paidOf = (b: BookingRow) => (num(b.deposit) == null && !Number(b.extra_paid_total || 0) ? null : Number(b.deposit || 0) + Number(b.extra_paid_total || 0));
// 「入住準備」兩張卡（洗滌清單、入住密碼）收的訂單：已預定 ~ 入住中。
//
// 原本只收「待入住／入住中」。問題是「待收尾款 → 待入住」那一步沒有排程、只能人工按
// （見 awaiting_balance 關卡的 nextStatus），尾款沒人確認的訂單就會一路停在待收尾款，
// 連客人當天要來了都還沒進到待入住——房務因此完全碰不到那筆單。
// 收到訂金之後訂單就確定會發生，備料不該再等前面那一關。
//
// 刻意不含押金處理與已處理：那兩個是退房後的狀態，備料已經沒有意義，放進來只會讓
// 住完的訂單堆在佇列裡。要回頭補已經住完的布巾成本，走「資料補登」那一關。
const CHECKIN_STATUSES = ['reserved', 'awaiting_balance', 'awaiting_checkin', 'checked_in'];

export const STAGES: StageDef[] = [
  // ---------------- 款項處理（會計）
  {
    key: 'awaiting_confirmation', group: 'payment', title: '訂金入款', statuses: ['awaiting_confirmation'], action: '訂金確認',
    color: '#d97706', colorLight: '#fef3c7', nextStatus: 'reserved', confirmAdvances: true, fields: ['remit'],
    money: 'full', amountLabel: '應收訂金', amountOf: (b) => num(b.deposit),
    templateTitle: '訂房成功通知', permission: 'booking.payment.verify',
    hint: '核對訂金已到帳後，填入匯款末五碼按確認；訂單會直接變成「已預定」（停在待確認會被自動取消排程當成未付款）。',
  },
  {
    key: 'awaiting_balance', group: 'payment', title: '尾款入款', statuses: ['awaiting_balance'], action: '尾款確認',
    color: '#ea580c', colorLight: '#ffedd5', nextStatus: 'awaiting_checkin', confirmAdvances: false, fields: ['balance_remit'],
    money: 'full', amountLabel: '應收尾款', amountOf: balanceOf,
    templateTitle: '已繳清尾款', permission: 'booking.payment.verify',
    hint: '尾款末五碼預設帶訂金那一組，不同再改。要讓訂單進到「待入住」請按「確認並推進」。',
  },
  {
    // 尾款收完之後才加的追加款：沒有下一關會自動收，所以另外列一關給會計。還沒到尾款關卡的訂單，
    // 未付追加款已經算進尾款，會在「尾款入款」一起收，不重複出現在這裡。
    key: 'extra_charges', group: 'payment', title: '追加款收款', statuses: [], action: '追加款確認',
    appliesTo: (b) => BALANCE_PAID_STATUSES.includes(b.status) && hasUnpaidExtraCharges(b),
    color: '#ca8a04', colorLight: '#fef9c3', nextStatus: null, confirmAdvances: false, fields: ['extras'],
    money: 'full', amountLabel: '未收追加款', amountOf: (b) => num(b.extra_unpaid_total),
    templateTitle: null, permission: 'booking.payment.verify',
    hint: '尾款收完之後才新增的追加款。勾選已經收到的項目按確認，全部收齊這筆訂單就會離開清單。',
  },
  {
    key: 'deposit_processing', group: 'payment', title: '押金退款', statuses: ['deposit_processing'], action: '押金退款',
    color: '#4f46e5', colorLight: '#e0e7ff', nextStatus: 'completed', confirmAdvances: false, fields: ['refund'],
    money: 'full', amountLabel: '應退押金', amountOf: (b) => num(b.security_deposit),
    // 押金扣掉房務回報的建議扣款就是實退；房務還沒檢查就退全額
    defaultRefund: (b) => (num(b.security_deposit) == null ? null : Math.max(0, Number(b.security_deposit) - Number(b.damage_deduction || 0))),
    templateTitle: '押金退款', permission: 'booking.refund.process',
    hint: '實退金額預設是押金扣掉房務回報的建議扣款，可以自己改。「確認並推進」會把訂單結案為「已處理」。',
  },
  {
    key: 'awaiting_refund', group: 'payment', title: '取消退款', statuses: ['awaiting_refund'], action: '退款完成',
    color: '#e11d48', colorLight: '#ffe4e6', nextStatus: 'refunded', confirmAdvances: false, fields: ['refund'],
    // 已付的追加款也要一起退，不然取消時會漏退
    money: 'full', amountLabel: '已收款項', amountOf: (b) => paidOf(b),
    defaultRefund: (b) => paidOf(b),
    templateTitle: '取消退款', permission: 'booking.refund.process',
    hint: '填實際退回客人的金額（沒退滿可以寫原因）。「確認並推進」會把訂單標成「已退款」。',
  },

  // ---------------- 入住準備（房務）
  {
    key: 'linen', group: 'checkin', title: '洗滌清單', statuses: CHECKIN_STATUSES, action: '洗滌確認',
    color: '#0d9488', colorLight: '#ccfbf1', nextStatus: null, confirmAdvances: false, fields: ['linen'],
    money: 'total', amountLabel: null, amountOf: () => null,
    templateTitle: null, permission: 'booking.linen.manage',
    hint: '核對這筆訂單要備的布巾數量。入住當天 13:00 的洗滌單會依這裡的數量加總發給洗滌廠，之後才改的話記得重發。',
  },
  {
    key: 'checkin_password', group: 'checkin', title: '入住密碼', statuses: CHECKIN_STATUSES, action: '密碼設定',
    color: '#0284c7', colorLight: '#e0f2fe', nextStatus: null, confirmAdvances: false, fields: ['password'],
    money: 'total', amountLabel: null, amountOf: () => null,
    templateTitle: '入住密碼發送', notifyLabel: '補發密碼給客人', permission: 'booking.checkin_password.manage',
    hint: '設定或修改大門密碼。入住當天 09:00 的排程會自動把密碼發給客人，確認後的「補發密碼」只是備用。',
  },

  // ---------------- 退房檢查（房務）
  {
    key: 'room_check', group: 'checkout', title: '房況檢查', statuses: ['deposit_processing'], action: '房況回報',
    color: '#7c3aed', colorLight: '#ede9fe', nextStatus: null, confirmAdvances: false, fields: ['damage'],
    money: 'total', amountLabel: null, amountOf: () => null,
    templateTitle: null, permission: 'booking.room_check',
    hint: '退房後檢查房間，回報有沒有損壞與建議扣多少；會計那邊的「押金退款」會直接帶入你填的金額。',
  },

  // ---------------- 資料補登（房務）
  //
  // 一筆訂單身上一點布巾數量都沒有，洗滌單與洗滌成本就都算不到它。會發生在三種來源：
  // 第三方平台匯入的包棟訂單（OTA 的 iCal 不帶房間資訊）、批次匯入沒填房型的、人工建單取消勾房的。
  //
  // 不看狀態也不看日期（statuses 留空、走 appliesTo）：已經住完的訂單一樣要補，否則那幾晚的
  // 洗滌成本就永遠少一塊。離開佇列的方式是「填了數量」或「按確認」——按確認是給「這筆真的不用布巾」
  // （客人自備、純場地租借）用的，否則填 0 會因為條件還成立而一直冒出來。
  {
    key: 'linen_backfill', group: 'backfill', title: '待補布巾數量', statuses: [],
    appliesTo: (b) => !!b.needs_linen_backfill,
    action: '補登數量',
    color: '#b45309', colorLight: '#fef3c7', nextStatus: null, confirmAdvances: false, fields: ['linen'],
    money: 'total', amountLabel: null, amountOf: () => null,
    templateTitle: null, permission: 'booking.linen.manage',
    hint: '這些訂單還沒有任何布巾數量，洗滌單與洗滌成本都算不到。沒有房間的（多半是第三方平台的包棟訂單）可以在這裡直接選房間，再按「回復預設」算出數量。確定不需要布巾就直接按確認。',
  },
];

export const stageByKey = (key: StageKey) => STAGES.find((s) => s.key === key)!;
/** 這筆訂單目前在不在這一關 */
export const stageApplies = (stage: StageDef, b: BookingRow) => stage.statuses.includes(b.status) || !!stage.appliesTo?.(b);
/** 這個狀態會出現在哪幾個關卡（一筆訂單可以同時有好幾張卡） */
export const stagesForStatus = (status: string) => STAGES.filter((s) => s.statuses.includes(status));
export const groupsOf = (stages: StageDef[]): StageGroup[] => (['payment', 'checkin', 'checkout', 'backfill'] as StageGroup[]).filter((g) => stages.some((s) => s.group === g));

/** 只有「入住準備」需要時間窗：太遠的訂單現在準備也沒意義 */
export const WINDOW_OPTIONS = [3, 7, 14, 0] as const; // 0＝全部
export const DEFAULT_WINDOW_DAYS = 14;
export const stageUsesWindow = (stage: StageDef) => stage.group === 'checkin';

/** 入住日在今天起 days 天內（含已經入住中的）。days<=0＝不限 */
export function withinCheckinWindow(b: BookingRow, days: number, today = new Date()): boolean {
  if (days <= 0 || !b.checkin_date) return true;
  const start = new Date(today); start.setHours(0, 0, 0, 0);
  const limit = new Date(start); limit.setDate(limit.getDate() + days);
  const checkin = new Date(`${b.checkin_date}T00:00:00`);
  return checkin < limit; // 已經過了入住日（入住中）也算，還在現場
}

/** 佇列排序：越急越上面 */
export function sortQueue(stage: StageDef, rows: BookingRow[]): BookingRow[] {
  const t = (v?: string | null) => (v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER);
  const by = (a: BookingRow, b: BookingRow) => {
    switch (stage.key) {
      case 'awaiting_confirmation': return t(a.payment_deadline_at) - t(b.payment_deadline_at) || t(a.created_at) - t(b.created_at);
      case 'deposit_processing': case 'room_check': return t(a.checkout_date) - t(b.checkout_date);
      case 'awaiting_refund': return t(a.updated_at) - t(b.updated_at);
      default: return t(a.checkin_date) - t(b.checkin_date);
    }
  };
  return [...rows].sort(by);
}

/** 房務回報的房況，給會計的押金退款卡顯示。null＝還沒檢查 */
export function damageSummary(b: BookingRow): { checked: boolean; label: string; deduction: number } {
  if (b.damage_found == null) return { checked: false, label: '房況尚未檢查', deduction: 0 };
  const deduction = Number(b.damage_deduction || 0);
  if (!b.damage_found) return { checked: true, label: '房況正常', deduction: 0 };
  return { checked: true, label: deduction > 0 ? `有損壞・建議扣 ${deduction.toLocaleString()}` : '有損壞', deduction };
}

/** 這一關的預設範本：先看設定，沒設定就用預設標題找 */
export interface MessageTemplate { id: string; title: string; body: string }

export function defaultTemplateFor(stage: StageDef, templates: MessageTemplate[], map: Record<string, string>): MessageTemplate | null {
  if (!stage.templateTitle) return null;
  const byId = map[stage.key] ? templates.find((t) => t.id === map[stage.key]) : null;
  return byId || templates.find((t) => t.title === stage.templateTitle) || null;
}

export function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) result = result.split(`[${key}]`).join(value ?? '');
  return result;
}

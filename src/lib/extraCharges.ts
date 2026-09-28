// ========================================================================
// 追加款（booking_extra_charges）的共用規則：前端畫面、booking-process function、測試都用這一份。
//
// 追加款是訂單成立後由後台人員手動加收的項目（烤肉用具租借、延遲退房…）。床位與人數異動不在這裡，
// 那是照固定公式重新報價。LINE 機器人不會建立或修改追加款。
//
// 尾款＝訂單總額－訂金＋未付追加款。訂單列上的 extra_unpaid_total 由資料庫觸發器維護
// （見 supabase_schema.sql 的 refresh_booking_extra_totals），這裡只負責用它算，不自己加總明細。
// ========================================================================

export interface ExtraCharge {
  id: string;
  booking_id: string;
  seq: string;
  title: string;
  amount: number;
  internal_note: string | null;
  is_paid: boolean;
  paid_at: string | null;
  paid_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_by: string | null;
  created_at: string | null;
}

/** 新增時一列的輸入（對話框裡的一列） */
export interface ExtraChargeInput {
  title: string;
  amount: number | string;
  internal_note?: string | null;
  /** 只有款項核對權限能帶 true */
  paid?: boolean;
}

export const EXTRA_CHARGE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const EXTRA_CHARGE_MAX = EXTRA_CHARGE_LETTERS.length;

/** 畫面上的編號：K7M2QX-A。舊訂單沒有訂單編號時只顯示字母。 */
export function extraChargeCode(orderNumber: string | null | undefined, seq: string): string {
  return orderNumber ? `${orderNumber}-${seq}` : seq;
}

/**
 * 接下來 count 筆要用的字母：從「用過的最後一個字母」往後排，作廢的不回收。
 * 已經告訴客人「B 是烤肉費」，B 作廢後也不能變成別的東西，所以不是找空位補。
 * 超過 Z 回 null（呼叫端要擋下來）。
 */
export function nextExtraChargeLetters(usedSeqs: string[], count: number): string[] | null {
  const lastIndex = usedSeqs.reduce((max, s) => Math.max(max, EXTRA_CHARGE_LETTERS.indexOf(s)), -1);
  const start = lastIndex + 1;
  if (count <= 0) return [];
  if (start + count > EXTRA_CHARGE_MAX) return null;
  return EXTRA_CHARGE_LETTERS.slice(start, start + count).split('');
}

/** 還可以新增幾筆 */
export function remainingExtraChargeSlots(usedSeqs: string[]): number {
  const lastIndex = usedSeqs.reduce((max, s) => Math.max(max, EXTRA_CHARGE_LETTERS.indexOf(s)), -1);
  return EXTRA_CHARGE_MAX - (lastIndex + 1);
}

/** 一列輸入的檢查。回傳錯誤訊息，沒問題回 null。金額要正整數：追加款不收小數，也不開放負數（折讓另外處理）。 */
export function validateExtraChargeInput(input: { title?: string | null; amount?: number | string | null }): { title?: string; amount?: string } | null {
  const errors: { title?: string; amount?: string } = {};
  if (!String(input.title ?? '').trim()) errors.title = '請填追加名稱';
  const raw = String(input.amount ?? '').trim();
  const n = Number(raw);
  if (!raw) errors.amount = '請填金額';
  else if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n <= 0) errors.amount = '金額要是大於 0 的整數';
  return Object.keys(errors).length ? errors : null;
}

/** 整列都沒填：對話框送出時直接略過，不算錯誤 */
export function isBlankExtraChargeInput(input: { title?: string | null; amount?: number | string | null; internal_note?: string | null }): boolean {
  return !String(input.title ?? '').trim() && !String(input.amount ?? '').trim() && !String(input.internal_note ?? '').trim();
}

/**
 * 尾款＝訂單總額－訂金＋未付追加款。沒有總額就算不出來（回 null）。
 * 所有顯示／通知尾款的地方都要用這個，不要各自重算。
 */
export function computeBalanceDue(b: { total_amount?: number | string | null; deposit?: number | string | null; extra_unpaid_total?: number | string | null }): number | null {
  if (b.total_amount == null || b.total_amount === '') return null;
  return Number(b.total_amount) - Number(b.deposit || 0) + Number(b.extra_unpaid_total || 0);
}

/** 訂單還有沒有未收的追加款 */
export function hasUnpaidExtraCharges(b: { extra_unpaid_total?: number | string | null }): boolean {
  return Number(b.extra_unpaid_total || 0) > 0;
}

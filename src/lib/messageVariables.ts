// ========================================================================
// 訊息變數解析器：把「訊息變數資料維護」頁面設定的 {變數名稱, 來源, 欄位} 對照表，
// 轉換成實際可以套進訊息範本的字串值。line-webhook.ts（LINE 自定訊息流程的罐頭訊息）、
// custom-messages.ts（客製訊息發送）、以及 MessageVariables.tsx（維護頁面本身的欄位下拉選單）
// 都共用這份邏輯，確保同一個變數在各處算出來的值一致。
// ========================================================================

import { bookingStatusLabel } from './bookingStatus';

export type VariableSource = 'booking' | 'customer' | 'settings';

export interface MessageVariable {
  variable_name: string;
  source: VariableSource;
  field_key: string;
}

export interface BookingCtx {
  order_number?: string | null;
  name?: string | null;
  nickname?: string | null;
  phone?: string | null;
  checkin_date?: string | null;
  checkout_date?: string | null;
  headcount?: number | null;
  adults?: number | null;
  kids?: number | null;
  infants?: number | null;
  whole_house?: boolean | null;
  room_type_label?: string | null;
  total_amount?: number | null;
  deposit?: number | null;
  status?: string | null;
}

export interface CustomerCtx {
  nickname?: string | null;
  line_user_id?: string | null;
  last_message_at?: string | null;
  first_message_at?: string | null;
}

export interface SettingsCtx {
  business_name?: string | null;
  customer_service_line?: string | null;
  booking_gift_message?: string | null;
}

export interface VariableResolveContext {
  booking?: BookingCtx;
  customer?: CustomerCtx;
  settings?: SettingsCtx;
}

// 每個來源開放的欄位白名單，「訊息變數資料維護」頁面的「欄位」下拉選單也是照這份清單顯示，
// 避免管理員手動打入不存在、或不該曝光的資料庫欄位（例如金鑰、密碼類欄位）。
export const BOOKING_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: 'order_number', label: '訂單編號' },
  { value: 'name', label: '客戶姓名' },
  { value: 'phone', label: '電話' },
  { value: 'checkin_date', label: '入住日期' },
  { value: 'checkout_date', label: '退房日期' },
  { value: 'headcount', label: '入住人數' },
  { value: 'adults_kids', label: '大人小孩' },
  { value: 'whole_house', label: '是否包棟' },
  { value: 'room_type_label', label: '房型' },
  { value: 'status', label: '訂單狀態' },
  { value: 'total_amount', label: '總金額' },
  { value: 'deposit', label: '訂金' },
  { value: 'balance_due', label: '尾款（總金額－訂金，自動計算）' },
];

export const CUSTOMER_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: 'nickname', label: 'LINE 暱稱' },
  { value: 'line_user_id', label: 'LINE User ID' },
  { value: 'last_message_at', label: '最近互動時間' },
  { value: 'first_message_at', label: '第一次互動時間' },
];

export const SETTINGS_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: 'business_name', label: '民宿名稱' },
  { value: 'customer_service_line', label: '客服 LINE' },
  { value: 'booking_gift_message', label: '禮金內容' },
];

export const SOURCE_OPTIONS: { value: VariableSource; label: string; fields: { value: string; label: string }[] }[] = [
  { value: 'booking', label: '訂單', fields: BOOKING_FIELD_OPTIONS },
  { value: 'customer', label: '客戶', fields: CUSTOMER_FIELD_OPTIONS },
  { value: 'settings', label: '民宿設定', fields: SETTINGS_FIELD_OPTIONS },
];

function toSlashDate(isoDate?: string | null): string {
  return (isoDate || '').replace(/-/g, '/');
}

function toDateTime(iso?: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-TW');
}

function formatAdultsKids(adults?: number | null, kids?: number | null, infants?: number | null): string {
  const a = adults ?? 0;
  const k = kids ?? 0;
  const i = infants ?? 0;
  return `${a}大${k}小${i > 0 ? `${i}幼` : ''}`;
}

function currency(n?: number | null): string {
  return n != null ? Number(n).toLocaleString() : '';
}

export function resolveVariable(source: VariableSource, fieldKey: string, ctx: VariableResolveContext): string {
  if (source === 'booking') {
    const b = ctx.booking;
    if (!b) return '';
    switch (fieldKey) {
      case 'order_number': return b.order_number || '';
      case 'name': return b.name || b.nickname || '';
      case 'phone': return b.phone || '';
      case 'checkin_date': return toSlashDate(b.checkin_date);
      case 'checkout_date': return toSlashDate(b.checkout_date);
      case 'headcount': return b.headcount != null ? String(b.headcount) : '';
      case 'adults_kids': return formatAdultsKids(b.adults, b.kids, b.infants);
      case 'whole_house': return b.whole_house ? '是' : '否';
      case 'room_type_label': return b.room_type_label || (b.whole_house ? '包棟' : '');
      case 'status': return bookingStatusLabel(b.status);
      case 'total_amount': return currency(b.total_amount);
      case 'deposit': return currency(b.deposit);
      case 'balance_due': return b.total_amount != null ? currency(Number(b.total_amount) - Number(b.deposit || 0)) : '';
      default: return '';
    }
  }
  if (source === 'customer') {
    const c = ctx.customer;
    if (!c) return '';
    switch (fieldKey) {
      case 'nickname': return c.nickname || '';
      case 'line_user_id': return c.line_user_id || '';
      case 'last_message_at': return toDateTime(c.last_message_at);
      case 'first_message_at': return toDateTime(c.first_message_at);
      default: return '';
    }
  }
  if (source === 'settings') {
    const s = ctx.settings;
    if (!s) return '';
    switch (fieldKey) {
      case 'business_name': return s.business_name || '';
      case 'customer_service_line': return s.customer_service_line || '';
      case 'booking_gift_message': return s.booking_gift_message || '';
      default: return '';
    }
  }
  return '';
}

export function buildMergeFields(variables: MessageVariable[], ctx: VariableResolveContext): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const v of variables) {
    fields[v.variable_name] = resolveVariable(v.source, v.field_key, ctx);
  }
  return fields;
}

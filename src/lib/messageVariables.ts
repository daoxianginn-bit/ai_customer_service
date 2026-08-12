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

// ------------------------------------------------------------------------
// 訂單金額結構
//   房價 room_amount：報價引擎算出來的住宿費用
//   押金 security_deposit：每筆固定收取、可退款，不算在房價裡
//   訂單總額 total_amount ＝ 房價 + 押金
//   訂金 deposit ＝ 房價 × 訂金比例（以房價為基數，不含押金）
// line-webhook.ts（自動報價）跟訂單管理頁（人工建單）都用這裡的函式，兩邊金額才不會算法不同。
// ------------------------------------------------------------------------
export function computeDeposit(roomAmount: number, depositPercent: number): number {
  if (!Number.isFinite(roomAmount) || roomAmount <= 0) return 0;
  const pct = Number.isFinite(depositPercent) && depositPercent > 0 ? depositPercent : 0;
  return Math.round((roomAmount * pct) / 100);
}

export function computeOrderAmounts(roomAmount: number, securityDeposit: number, depositPercent: number) {
  const room = Number.isFinite(roomAmount) ? roomAmount : 0;
  const security = Number.isFinite(securityDeposit) ? securityDeposit : 0;
  return {
    room_amount: room,
    security_deposit: security,
    total_amount: room + security,
    deposit: computeDeposit(room, depositPercent),
  };
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
  room_amount?: number | null;
  security_deposit?: number | null;
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
  { value: 'room_amount', label: '房價（不含押金）' },
  { value: 'security_deposit', label: '押金' },
  { value: 'total_amount', label: '訂單總額（房價＋押金）' },
  { value: 'deposit', label: '訂金（房價的固定比例）' },
  { value: 'balance_due', label: '尾款（訂單總額－訂金，自動計算）' },
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

// 不在 message_variables 對照表裡、但 line-webhook.ts 一定會自己算出來帶入的變數。
// 編輯器要認得它們，否則管理員會看到「這個變數沒有登記」的假警告。
export const ALWAYS_AVAILABLE_VARIABLES = ['匯款日時間'];

// ------------------------------------------------------------------------
// 訊息範本切段：把 "您好 [姓名]" 切成 [文字, 變數]，
// 供編輯器上色與檢視模式渲染綠色標籤共用，避免兩邊的判斷規則走鐘。
// 方括號裡不允許換行或巢狀括號，才算是一個變數 token。
// ------------------------------------------------------------------------
export type TemplateSegment = { type: 'text'; value: string } | { type: 'variable'; name: string };

const VARIABLE_TOKEN_RE = /\[([^[\]\n]+)\]/g;

export function parseTemplateSegments(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let lastIndex = 0;
  for (const match of (template || '').matchAll(VARIABLE_TOKEN_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex) segments.push({ type: 'text', value: template.slice(lastIndex, start) });
    segments.push({ type: 'variable', name: match[1] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < (template || '').length) segments.push({ type: 'text', value: template.slice(lastIndex) });
  return segments;
}

// 範本裡用到、但對照表查不到的變數名稱。編輯器用這份清單提醒管理員可能是打錯字，
// 因為這種 token 送出去時不會被替換，會原封不動出現在顧客的訊息裡。
export function findUnknownVariables(template: string, knownNames: string[]): string[] {
  const known = new Set([...knownNames, ...ALWAYS_AVAILABLE_VARIABLES]);
  const unknown = new Set<string>();
  for (const seg of parseTemplateSegments(template)) {
    if (seg.type === 'variable' && !known.has(seg.name)) unknown.add(seg.name);
  }
  return [...unknown];
}

// ------------------------------------------------------------------------
// 流程觸發關鍵字
// 「等於」＝顧客整句話就是這個關鍵字才算；「相關」＝句子裡有出現就算。
// 舊資料是一個逗號字串、比對規則寫死在 line-webhook.ts（單字用等於、多字用包含），
// 這裡把那份舊規則保留成轉換邏輯，既有流程升級後行為不變。
// ------------------------------------------------------------------------
export type KeywordMatch = 'exact' | 'contains';
export interface TriggerRule {
  keyword: string;
  match: KeywordMatch;
}

export function parseCsvKeywords(raw: string | null | undefined): string[] {
  return (raw || '')
    .replace(/，/g, ',')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

export function parseTriggerRules(rulesJson: unknown, legacyCsv?: string | null): TriggerRule[] {
  if (Array.isArray(rulesJson) && rulesJson.length > 0) {
    return rulesJson
      .map((r: any) => ({
        keyword: String(r?.keyword ?? '').trim(),
        match: r?.match === 'exact' ? ('exact' as const) : ('contains' as const),
      }))
      .filter((r) => r.keyword.length > 0);
  }
  return parseCsvKeywords(legacyCsv).map((keyword) => ({
    keyword,
    match: keyword.length === 1 ? ('exact' as const) : ('contains' as const),
  }));
}

// 回填舊的 trigger_keywords 欄位，萬一要退版回舊程式仍讀得到關鍵字。
export function serializeTriggerRules(rules: TriggerRule[]): string {
  return rules.map((r) => r.keyword).join(',');
}

export function matchTriggerRules(userMessage: string, rules: TriggerRule[]): TriggerRule | undefined {
  const trimmed = (userMessage || '').trim();
  return rules.find((r) => (r.match === 'exact' ? trimmed === r.keyword : trimmed.includes(r.keyword)));
}

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
      case 'room_amount': return currency(b.room_amount ?? b.total_amount); // 舊訂單沒有 room_amount，退回 total_amount（改版前它存的就是房價）
      case 'security_deposit': return currency(b.security_deposit);
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

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

// 不在 message_variables 對照表裡、但由特定呼叫端自己算出來帶入的變數，不走一般的
// BOOKING_FIELD_OPTIONS 白名單機制。編輯器要認得它們，否則管理員會看到「這個變數沒有登記」的假警告。
//   匯款日時間：line-webhook.ts 即時算出的截止時間。
//   入住密碼：scheduled-tasks-run.ts 的「入住排程」專用，故意不放進 BOOKING_FIELD_OPTIONS——
//     那份白名單的設計本來就是要擋掉密碼類欄位被任意範本引用，只有這個排程本身會手動帶入這個值。
//   今日日期／明日日期：跟訂單完全無關（沒有訂單也算得出來），所以不放進 BOOKING_FIELD_OPTIONS，
//     由 computeTodayTomorrowFields() 在每次渲染訊息時即時算。
export const ALWAYS_AVAILABLE_VARIABLES = ['匯款日時間', '入住密碼', '今日日期', '明日日期'];

// 「今日日期」「明日日期」：跟 [入住日期]／[退房日期] 用同一種 YYYY/MM/DD 格式，但算的是
// 「現在」而不是訂單欄位，所以不透過 BOOKING_FIELD_OPTIONS，由呼叫端直接把這兩個值併進
// buildMergeFields() 算出來的 fields 裡（跟 line-webhook.ts 帶入 [匯款日時間] 是同一套做法）。
// 一律用台灣時間（UTC+8）算「今天」是哪一天，不受伺服器本身的系統時區影響。
export function computeTodayTomorrowFields(): Record<string, string> {
  const taiwanNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const taiwanTomorrow = new Date(taiwanNow.getTime() + 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
  return { 今日日期: fmt(taiwanNow), 明日日期: fmt(taiwanTomorrow) };
}

// ------------------------------------------------------------------------
// 變數分區：範本編輯器的快捷插入改成兩層（先選分區、再選變數）之後用的對照。
// 分區名稱刻意跟「訂單管理」編輯畫面的區塊一致——編輯範本的人腦中想的是「我要插入訂單上
// 費用那一區的某個欄位」，分區跟他看到的表單長得一樣，才不用在心裡再翻譯一次。
// ------------------------------------------------------------------------
export const VARIABLE_SECTIONS = {
  guest: '住宿與客人資料',
  fee: '費用資訊',
  payment: '款項核對與備註',
  business: '民宿資訊',
  common: '常用',
} as const;

// 欄位 → 分區。沒列到的欄位歸「常用」，不會消失。
const FIELD_SECTION: Record<string, string> = {
  order_number: VARIABLE_SECTIONS.guest,
  name: VARIABLE_SECTIONS.guest,
  phone: VARIABLE_SECTIONS.guest,
  nickname: VARIABLE_SECTIONS.guest,
  line_user_id: VARIABLE_SECTIONS.guest,
  last_message_at: VARIABLE_SECTIONS.guest,
  first_message_at: VARIABLE_SECTIONS.guest,
  checkin_date: VARIABLE_SECTIONS.guest,
  checkout_date: VARIABLE_SECTIONS.guest,
  headcount: VARIABLE_SECTIONS.guest,
  adults_kids: VARIABLE_SECTIONS.guest,
  whole_house: VARIABLE_SECTIONS.guest,
  room_type_label: VARIABLE_SECTIONS.guest,
  room_amount: VARIABLE_SECTIONS.fee,
  security_deposit: VARIABLE_SECTIONS.fee,
  total_amount: VARIABLE_SECTIONS.fee,
  deposit: VARIABLE_SECTIONS.fee,
  balance_due: VARIABLE_SECTIONS.fee,
  status: VARIABLE_SECTIONS.payment,
  business_name: VARIABLE_SECTIONS.business,
  customer_service_line: VARIABLE_SECTIONS.business,
  booking_gift_message: VARIABLE_SECTIONS.business,
};

// 不在對照表裡、由呼叫端即時算出來的變數各自的分區。
const EXTRA_VARIABLE_SECTION: Record<string, string> = {
  匯款日時間: VARIABLE_SECTIONS.payment,
  入住密碼: VARIABLE_SECTIONS.payment,
  今日日期: VARIABLE_SECTIONS.common,
  明日日期: VARIABLE_SECTIONS.common,
};

export interface PlaceholderGroup {
  label: string;
  items: string[];
  /**
   * 這一區的變數在目前這個編輯器算不出值。四個編輯器列出的分區刻意完全一樣（不然改了一邊
   * 就會跟別處走鐘），但洗滌單的品項數量只有洗滌單排程統計得出來，插到客人訊息裡不會被替換、
   * 會原樣寄出去。標記起來讓編輯器把它畫成警示色，並在真的插進去時提醒。
   */
  inert?: boolean;
  /** inert 時顯示給編輯者看的說明。 */
  note?: string;
}

/**
 * 排程彙整訊息自己的欄位。名稱必須跟 scheduled-tasks-run.ts 算出來的 fields 一致。
 * [日期]、[訂單數] 兩區都有——每一區都要能自己寫完一則訊息，不然寫洗滌單還得跳到別區拿日期。
 * 重複的名字由 useTemplateVariables 去重，不會有兩顆一樣的按鈕同時亮著。
 */
export const LAUNDRY_SHEET_VARIABLES = ['日期', '訂單數', '布巾明細', '布巾明細(簡稱)'];
export const LAUNDRY_SECTION_LABEL = '洗滌單';
export const LINEN_SECTION_LABEL = '布巾備品洗滌成本';
export const DEPOSIT_NOTICE_VARIABLES = ['日期', '訂單數', '押金總額', '押金明細'];
export const DEPOSIT_SECTION_LABEL = '押金通知';
/** 每種彙整通知都算得出來的共同欄位，沒有洗滌單／押金那種專屬數字。 */
export const BOOKING_NOTICE_VARIABLES = ['日期', '訂單數'];
export const BOOKING_NOTICE_SECTION_LABEL = '彙整通知';

/**
 * 布巾品項的完整名稱（category＋spec）——「備品管理」用來辨識品項的正式寫法，
 * 例如「床包－平紋貢緞床包-5x6.2尺-高28cm紅線」。[布巾明細] 展開時用這個。
 */
export function laundryItemFullName(item: { category: string; spec?: string | null }): string {
  return item.spec ? `${item.category}－${item.spec}` : item.category;
}

/**
 * 布巾品項在洗滌單範本裡的變數名稱。必須跟後端 scheduled-tasks-run.ts 的 laundryItemName()
 * 一致，否則按鈕插進去的變數替換不到、會原樣出現在發給洗滌廠的訊息裡。
 * 優先用「備品管理」填的洗滌單簡稱，沒填就退回完整名稱（不會漏掉品項）。
 */
export function laundryItemName(item: { category: string; spec?: string | null; short_name?: string | null }): string {
  const short = (item.short_name || '').trim();
  if (short) return short;
  return laundryItemFullName(item);
}

/**
 * 把「訊息變數資料維護」設定的變數，依對應欄位分成幾區給編輯器用。
 * 分區順序固定（跟訂單編輯畫面由上而下一致），空的分區不回傳。
 */
export function groupVariablesBySection(
  variables: { variable_name: string; field_key: string }[],
  extras: string[] = []
): PlaceholderGroup[] {
  const order = [
    VARIABLE_SECTIONS.guest,
    VARIABLE_SECTIONS.fee,
    VARIABLE_SECTIONS.payment,
    VARIABLE_SECTIONS.business,
    VARIABLE_SECTIONS.common,
  ];
  const bucket = new Map<string, string[]>(order.map((k) => [k, []]));

  for (const v of variables) {
    const section = FIELD_SECTION[v.field_key] || VARIABLE_SECTIONS.common;
    bucket.get(section)!.push(v.variable_name);
  }
  for (const name of extras) {
    const section = EXTRA_VARIABLE_SECTION[name] || VARIABLE_SECTIONS.common;
    if (!bucket.get(section)!.includes(name)) bucket.get(section)!.push(name);
  }

  return order.map((label) => ({ label, items: bucket.get(label)! })).filter((g) => g.items.length > 0);
}

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

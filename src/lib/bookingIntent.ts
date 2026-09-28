// ========================================================================
// 訂房對話的意圖分類。
//
// 客人一句話進來，先判斷「他想做什麼」，再決定怎麼處理——這是整個訂房流程編排的第一步，
// 也是唯一一個判斷點。三個階段（收集中／待確認／待匯款）共用同一個分類器、同一張分派表，
// 不再各自用一堆 regex 猜意圖。
//
// 為什麼要先分意圖：以前是「在哪個階段就假設客人在做什麼」——收集中就假設他在回答欄位、
// 待確認就假設他在回是／否。但客人不會照劇本走：待確認時會先問早餐、收集中會突然打「我要訂房」
// 想重來、回一個「1」在不同狀態下意思完全不同。用 regex 硬猜，每補一條規則就在別處誤判一次。
// 把「目前狀態＋已填欄位＋最近對話」一起餵給 AI，一次判斷意圖與欄位，才分得清「1」是雙人房
// 一間還是別的；「好啊但改成 10/10」是要修改不是同意。
//
// 這個模組不碰資料庫也不呼叫 AI，只負責：組提示詞、解析 AI 回覆、規則版的退路。
// AI 呼叫本身與後續分派在 line-webhook.ts。
// ========================================================================

export type BookingPhase = 'collecting' | 'awaiting_confirmation' | 'awaiting_remittance';

export type BookingIntent =
  | 'provide_info'   // 提供或補充訂房資訊
  | 'confirm'        // 同意報價、確定要訂
  | 'decline'        // 不訂了、取消
  | 'modify'         // 要更改已提供的資訊（帶新值）
  | 'question'       // 問民宿相關問題
  | 'restart'        // 重新開始
  | 'payment_report' // 回報已匯款
  | 'unclear';

const INTENTS: BookingIntent[] = [
  'provide_info', 'confirm', 'decline', 'modify', 'question', 'restart', 'payment_report', 'unclear',
];

export interface IntentFieldDef {
  key: string;
  label: string;
  quote_field: 'checkin_date' | 'checkout_date' | 'headcount' | 'whole_house' | 'room_count' | 'order_number' | null;
  room_capacity?: number | null;
  value_type?: 'date' | 'number' | 'string' | null;
}

export interface IntentContext {
  phase: BookingPhase;
  fields: IntentFieldDef[];
  collected: Record<string, string>;
  /** 最近幾則對話，舊到新 */
  recentMessages: { role: 'customer' | 'bot'; text: string }[];
  todayIso: string;
  /**
   * 客服上一句「問的是哪幾個欄位」。「只剩一欄就整句當答案」要用這個當基準，不能用「所有還沒填的
   * 欄位」——房數是選填、永遠算沒填，用它當基準會讓客人回「1」永遠對不到任何一欄。
   * 沒給的話退回用所有未填欄位。
   */
  askedKeys?: string[];
  /**
   * 客服上一句問的是「要不要幫您排候補」，還在等客人回答（見 line-webhook 的 waitlistOffer）。
   * 這一題的「好／不用」是在回答候補、不是在確認報價，所以 confirm／decline 的判斷要放寬。
   */
  pendingWaitlist?: boolean;
}

export interface IntentResult {
  intent: BookingIntent;
  /** 這句話裡抽出／要更改的欄位值，key 對應 fields[].key */
  slots: Record<string, string>;
  source: 'ai' | 'rules';
  /** AI 給的一句話理由，只進診斷紀錄，不影響行為 */
  reason?: string;
}

// ------------------------------------------------------------------------
// 規則版的基本判斷。AI 模式下也會用到：「是／否」這種一個字的回答不值得花一次 AI 呼叫，
// 而且這幾個判斷夠精確，不需要 AI。
// ------------------------------------------------------------------------

// 「是/否」的判定：整句話必須就是那個答案，只允許差在標點與語尾助詞。
// 「好啊但我想改成10/10」「好像有點貴」「要再想一下」都不算同意——那是有其他要求，
// 訂單一旦成立就牽涉到房間與金流，寧可多問一句，也不要猜錯方向。
const YES_ANSWERS = new Set(['是', '對', '好', '要', '確定', '沒問題', 'ok', 'okay', 'yes', 'y', '確認', '可以']);
const NO_ANSWERS = new Set(['否', '不', '不要', '不用', '不需要', '取消', 'no', 'n', '不訂', '不訂了']);

export function normalizeShortAnswer(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[\s。，、；：！？!?~～．.…「」『』()（）]/g, '')
    .replace(/(的|了|啊|阿|喔|噢|唷|呀|吧|囉|嘍|喲|耶|哦|呦)+$/, '');
}

export function isYesAnswer(message: string): boolean {
  return YES_ANSWERS.has(normalizeShortAnswer(message));
}
export function isNoAnswer(message: string): boolean {
  return NO_ANSWERS.has(normalizeShortAnswer(message));
}

// 「要不要幫您排候補？」的答案。isYesAnswer 只認「整句就是一個好」，但這一題客人很常把關鍵字
// 帶上（「幫我排候補」「候補好了」「不用候補」），所以另外看一次。回 undefined 代表這句不是在
// 回答——「候補要等多久？」「候補是什麼」是在問候補這件事本身，該交給知識庫回答。
//
// 判斷順序有講究：
//   1. 明確的否定（不用／不要／先不／別排）最先——「不要幫我排候補」裡也有「幫我」。
//   2. 問候補本身（多久、怎麼運作、排到了沒）不是回答。
//   3. 明確的請求（幫我、麻煩、登記、排我）優先於「算了」「沒關係」——這兩個詞在口語裡常常只是
//      語氣（「沒關係，幫我排候補」「算了，還是排候補好了」），不能先當成拒絕。
//   4. 只剩「算了」「沒關係」才是拒絕；最後才看一般的「好／要／可以」。
export function scanWaitlistAnswer(message: string): 'yes' | 'no' | undefined {
  const t = message.trim();
  if (!/候補|候位/.test(t)) return undefined;
  if (/不(用|要|需要|想)|先不|別排/.test(t)) return 'no';
  if (/多久|多長|什麼|甚麼|怎麼|如何|意思|規則|機制|好了沒|排到|輪到|進度|第幾/.test(t)) return undefined;
  if (/幫我|幫忙|麻煩|請幫|登記|加入|排我|排一下|還是(要|排|幫|候補)/.test(t)) return 'yes';
  if (/算了|沒關係/.test(t)) return 'no';
  if (/好|要|可以|ok|yes/i.test(t)) return 'yes';
  return undefined;
}

// AI 抽出的欄位值，這句話裡要看得到根據才採用。
//
// AI 模式帶了最近對話當脈絡，模型偶爾會把「對話裡講過、但客人這句沒講」的值也填進 slots
// （例如客人只回「好」「有早餐嗎」，模型卻順手填了人數或日期），這個值會直接進重新報價，
// 客人拿到一張依他沒說過的條件算出來的價格。這裡不驗證值對不對，只驗證「這句話有沒有在講
// 這一類東西」：日期要有數字或日期用語、人數要有數字或「中文數字＋人的單位」、房數要有數字或
// 「中文數字＋間／房」。其餘欄位（包棟、備註等）不檢查。跟已收集的值相同的不用檢查——沒有改變任何事。
const DATE_WORDS_RE = /\d|今天|明天|後天|下週|下周|下禮拜|下星期|這週|這周|本週|週[一二三四五六日天末]|周[一二三四五六日天末]|星期|禮拜|[一二兩三四五六七八九十]+\s*[月號日晚夜天]|連假|過年|春節|中秋|端午|元旦|跨年|聖誕|月底|月初|下旬|上旬|中旬/;
const HEADCOUNT_WORDS_RE = /\d|[一二兩三四五六七八九十]+\s*(?:位|個|人|大|小|名)/;
const ROOM_WORDS_RE = /\d|[一二兩三四五六七八九十]+\s*(?:間|房)/;

export function dropUngroundedSlots(
  message: string,
  fields: IntentFieldDef[],
  collected: Record<string, string>,
  slots: Record<string, string>
): { slots: Record<string, string>; dropped: string[] } {
  const text = message || '';
  const kept: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(slots)) {
    const field = fields.find((f) => f.key === key);
    const qf = field?.quote_field;
    const grounded =
      !field || collected[key] === value ||
      (qf === 'checkin_date' || qf === 'checkout_date' ? DATE_WORDS_RE.test(text)
        : qf === 'headcount' ? HEADCOUNT_WORDS_RE.test(text)
          : qf === 'room_count' ? ROOM_WORDS_RE.test(text)
            : true);
    if (grounded) kept[key] = value;
    else dropped.push(key);
  }
  return { slots: kept, dropped };
}

export function isRestartCommand(message: string): boolean {
  return /^(修改|重新報價|重新試算|重新算|改訂單|改資料|重來|重新開始)/i.test(message.trim());
}

// 像問句：句尾是嗎／呢／？，或含請問／怎麼／多少／幾點這類疑問詞。
export function looksLikeQuestion(message: string): boolean {
  const t = message.trim().replace(/[。！!~～\s]+$/, '');
  return /[?？嗎呢嘛麼]$/.test(t)
    || /(請問|怎麼|怎樣|如何|多少|幾點|幾天|幾個|什麼|甚麼|哪裡|哪邊|哪些|有沒有|可不可以|能不能|是否)/.test(t);
}

// 像在回報匯款：提到匯／轉帳／末五碼，或整句就是 5 碼數字。
export function looksLikePaymentReport(message: string): boolean {
  const t = message.trim();
  return /(匯|轉帳|轉好|付款|付了|帳號|末五碼|後五碼|已付)/.test(t) || /^\d{5}$/.test(t);
}

// 只剩一個欄位沒答時，客人的整句話能不能直接當那一欄的答案。
// 數字類：整句就是一個數字，允許尾巴帶「間」「人」這種單位。自由文字：整句照收。
// 日期與包棟本來就不靠標籤定位，走到這裡代表真的沒寫，不硬塞。
export function interpretBareAnswer(message: string, field: IntentFieldDef): string | undefined {
  const trimmed = message.trim();
  if (!trimmed) return undefined;
  if (field.quote_field === 'headcount' || field.quote_field === 'room_count') {
    const m = trimmed.match(/^(\d{1,3})\s*(?:間|人|位|個)?$/);
    return m ? String(Number(m[1])) : undefined;
  }
  if (!field.quote_field) return trimmed;
  return undefined;
}

// 「住一晚」「兩天一夜」「3 晚」這種講法：客人常常只給入住日跟晚數，不會算退房日。
// 回傳晚數；抓不到回 undefined。
const CN_NUM: Record<string, number> = { 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function scanNights(message: string): number | undefined {
  const t = message.replace(/\s+/g, '');
  // 「兩天一夜」「三天兩夜」：以「夜」的數字為準
  const dn = t.match(/([0-9一兩二三四五六七八九十]+)天([0-9一兩二三四五六七八九十]+)夜/);
  const raw = dn ? dn[2] : t.match(/(?:住|待|停留|住宿)?([0-9一兩二三四五六七八九十]+)\s*(?:個)?(?:晚|夜)/)?.[1];
  if (!raw) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : CN_NUM[raw];
  return n && n > 0 && n < 60 ? n : undefined;
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export const QUOTE_ESSENTIAL_FIELDS = ['checkin_date', 'checkout_date', 'headcount'] as const;

/** 算價必要的欄位裡，還沒填的那些。房數是選填，不會出現在這裡。 */
export function missingEssentialFields(fields: IntentFieldDef[], collected: Record<string, string>): IntentFieldDef[] {
  return fields.filter(
    (f) => f.quote_field && (QUOTE_ESSENTIAL_FIELDS as readonly string[]).includes(f.quote_field) && !collected[f.key]
  );
}

/**
 * 房間組合的寫法：「2+2+4+4」＝兩間雙人房、兩間四人房。
 *
 * 客人講房型組合時最自然就是這樣寫（「能給我 2+2+4+4 的報價嗎？」），但它既沒有欄位標籤、
 * 句尾又是問號，AI 很容易判成「在問問題」，於是回一句「請找真人客服」——明明這個組合系統
 * 自己算得出來（多開的房間會照加開房費計價）。這裡把它解析成房數欄位，讓它走重新報價。
 *
 * 每一個數字都必須對得上實際存在的房型人數才採用，否則「7+2小」（7 大 2 小）這種人數寫法
 * 會被誤讀成房間組合。至少要兩個數字——單一個「4」是「4 人房」還是「4 間」分不出來。
 */
export function scanRoomComposition(message: string, fields: IntentFieldDef[]): Record<string, string> {
  const capacityFields = fields.filter((f) => f.quote_field === 'room_count' && Number(f.room_capacity) > 0);
  if (!capacityFields.length) return {};
  const byCapacity = new Map(capacityFields.map((f) => [Number(f.room_capacity), f]));

  // 取最長的一串「數字＋數字＋…」，避免只吃到前面兩個
  const candidates = (message.match(/(?<!\d)\d{1,2}(?:\s*[+＋]\s*\d{1,2})+(?!\d)/g) || [])
    .sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const numbers = candidate.split(/[+＋]/).map((n) => Number(n.trim()));
    if (numbers.length < 2 || numbers.some((n) => !byCapacity.has(n))) continue;
    const counts = new Map<number, number>();
    for (const n of numbers) counts.set(n, (counts.get(n) || 0) + 1);
    const slots: Record<string, string> = {};
    // 沒被提到的房型要明確填 0：客人是在指定「整組要哪幾間」，舊的組合不能留著
    for (const [capacity, field] of byCapacity) slots[field.key] = String(counts.get(capacity) ?? 0);
    return slots;
  }
  return {};
}

// 中文數字（含「兩」）轉阿拉伯數字，只處理 1~99 這種口語會出現的範圍。
const CJK_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function parseCjkNumber(raw: string): number | null {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text || /[^零一二兩三四五六七八九十]/.test(text)) return null;
  if (!text.includes('十')) return text.split('').reduce((n, c) => (n === null ? null : CJK_DIGITS[c] ?? null), 0 as number | null);
  const [tensPart, onesPart] = text.split('十');
  const tens = tensPart === '' ? 1 : CJK_DIGITS[tensPart] ?? null;
  const ones = onesPart === '' ? 0 : CJK_DIGITS[onesPart] ?? null;
  return tens === null || ones === null ? null : tens * 10 + ones;
}

const PEOPLE_UNIT = '(?:位|個人|個|名|人|大人|小孩|小朋友|兒童|童|小|老人|長輩|寶寶)';
const NUMBER_TOKEN = '(?:\\d{1,2}|[零一二兩三四五六七八九十]{1,3})';

/**
 * 相對的人數變動：「多 1 大人 1 小孩」「再加兩人」「少 1 位」。
 *
 * 客人問「如果多 1 大人 1 小孩價格一樣嗎？」時，系統其實算得出 11 人的價格，但這句話沒有
 * 任何「絕對人數」，掃描器只會抓到句子裡的 1，把 9 人改成 1 人比不回答更糟，所以以前只能
 * 整句丟給知識庫問答，回一句「稍後由專人回覆」。這裡把它解成「現有人數 ±N」。
 *
 * 只有已經收集到人數時才有意義；算出來 ≤ 0 就當作沒抓到（不要報價 0 人）。
 */
export function scanHeadcountDelta(message: string, currentHeadcount: number): number | undefined {
  if (!Number.isFinite(currentHeadcount) || currentHeadcount <= 0) return undefined;
  const text = message || '';
  // 一個「多／少」後面可以接好幾組「數字＋單位」：「多1大人1小孩」是一次加兩個
  const groupRe = new RegExp(`(多|加上?|增加|再加|新增|少|減少?|扣)\\s*((?:${NUMBER_TOKEN}\\s*${PEOPLE_UNIT}\\s*(?:和|跟|與|及|、|,|，|\\+|＋)?\\s*)+)`, 'g');
  let delta = 0;
  let matched = false;
  for (const m of text.matchAll(groupRe)) {
    const sign = /^(少|減|扣)/.test(m[1]) ? -1 : 1;
    for (const part of m[2].matchAll(new RegExp(`(${NUMBER_TOKEN})\\s*${PEOPLE_UNIT}`, 'g'))) {
      const n = parseCjkNumber(part[1]);
      if (n === null || n <= 0) continue;
      delta += sign * n;
      matched = true;
    }
  }
  if (!matched || delta === 0) return undefined;
  const next = currentHeadcount + delta;
  return next > 0 ? next : undefined;
}

/**
 * 「可以給我 4 間房嗎？」——只講間數、沒講是哪幾間。
 * 回傳客人要的房間總數；沒講就是 undefined。
 */
export function scanRoomTotal(message: string): number | undefined {
  // 「第2間房有浴缸嗎」的 2 是在指某一間，不是要 2 間
  // 數字前面也不能還有數字，否則「第12間」會從 2 開始比對、變成 2 間
  const m = (message || '').match(new RegExp(`(?<!第\\s*)(?<![\\d零一二兩三四五六七八九十])(${NUMBER_TOKEN})\\s*(?:間|間房|房間)`));
  if (!m) return undefined;
  const n = parseCjkNumber(m[1]);
  return n !== null && n > 0 && n <= 20 ? n : undefined;
}

export interface RoomComposition {
  layout: Record<number, number>;
  beds: number;
  /** 這個組合住得下要求的人數嗎。false 時呼叫端照樣往下走，由報價那邊的「住不下」說明處理 */
  seatsAll: boolean;
}

/**
 * 只給了「要幾間房」時，挑一組房型組合：間數剛好，住得下的裡面選總床位最少的
 * （多開的床位要算加開房費，客人不會想多付）。沒有任何組合住得下就回床位最多的那組，
 * 讓後面的「您指定的房間住不下 N 位」照實說明，而不是原封不動把同一張報價再送一次。
 * 回 null 只代表「根本湊不出這麼多間」（例如客人要 10 間、但總共只有 5 間）。
 */
export function composeRoomsForTotal(
  roomTotal: number,
  headcount: number,
  available: { capacity: number; count: number }[],
): RoomComposition | null {
  const caps = available.filter((c) => c.capacity > 0 && c.count > 0).sort((a, b) => a.capacity - b.capacity);
  if (!caps.length || roomTotal <= 0) return null;
  let fitting: RoomComposition | null = null;
  let largest: RoomComposition | null = null;
  const walk = (index: number, roomsLeft: number, beds: number, layout: Record<number, number>) => {
    if (roomsLeft === 0) {
      const found: RoomComposition = { layout: { ...layout }, beds, seatsAll: beds >= headcount };
      if (found.seatsAll) { if (!fitting || beds < fitting.beds) fitting = found; }
      else if (!largest || beds > largest.beds) largest = found;
      return;
    }
    if (index >= caps.length) return;
    const { capacity, count } = caps[index];
    for (let take = Math.min(count, roomsLeft); take >= 0; take--) {
      if (take > 0) layout[capacity] = take; else delete layout[capacity];
      walk(index + 1, roomsLeft - take, beds + take * capacity, layout);
    }
    delete layout[capacity];
  };
  walk(0, roomTotal, 0, {});
  return fitting ?? largest;
}

// ------------------------------------------------------------------------
// 規則版分類器：system 模式（不花 token）與 AI 失敗時的退路。
// 順序就是優先權：明確指令 > 階段專屬的短答 > 有欄位內容 > 問句 > 階段預設。
// ------------------------------------------------------------------------
export function classifyByRules(
  message: string,
  ctx: IntentContext,
  extract: (message: string, fields: IntentFieldDef[]) => Record<string, string>
): IntentResult {
  const trimmed = message.trim();
  const rules = (intent: BookingIntent, slots: Record<string, string> = {}): IntentResult => ({ intent, slots, source: 'rules' });

  if (isRestartCommand(trimmed)) return rules('restart');

  // 客服上一句在問「要不要幫您排候補」：這裡的「好／不用」是在回答那一句，不是在確認報價。
  // 要比下面的欄位擷取先判斷，不然收集中階段的「好」會一路掉到最後變成 unclear。
  if (ctx.pendingWaitlist) {
    const answer = scanWaitlistAnswer(trimmed);
    if (answer === 'no' || isNoAnswer(trimmed)) return rules('decline');
    if (answer === 'yes' || isYesAnswer(trimmed)) return rules('confirm');
  }

  if (ctx.phase === 'awaiting_confirmation') {
    if (isNoAnswer(trimmed)) return rules('decline');
    if (isYesAnswer(trimmed)) return rules('confirm');
  }

  // 一次把全部欄位丟給擷取器：它對「整個步驤只有一個自由文字欄位」有「整句當答案」的捷徑，
  // 單獨丟自由文字欄位進去會讓「你好」「有早餐嗎」全被當成備註。報價流程一定有日期＋人數
  // 至少三欄，整批丟不會觸發那條捷徑，自由文字只會靠「備註：xxx」標籤定位抓到。
  const slots = extract(trimmed, ctx.fields);
  // 已經答過的欄位，這句要明確寫了標籤才能覆蓋——「訊息裡任一個數字就當人數」這種猜測
  // 不能推翻已收集到的答案。待確認階段所有欄位都已收集，等於「沒標籤的新值一律不採用」，
  // 例如「好啊但改成10/10」到底改入住還是退房只有 AI 分得出來，規則版就交給下面的 unclear。
  for (const f of ctx.fields) {
    if (ctx.collected[f.key] && slots[f.key] !== undefined && !trimmed.includes(f.label)) delete slots[f.key];
  }

  // 「住一晚」「兩天一夜」：有入住日、沒退房日時，用晚數推出退房日
  const checkinField = ctx.fields.find((f) => f.quote_field === 'checkin_date');
  const checkoutField = ctx.fields.find((f) => f.quote_field === 'checkout_date');
  if (checkinField && checkoutField && slots[checkoutField.key] === undefined) {
    const checkin = slots[checkinField.key] ?? ctx.collected[checkinField.key];
    const nights = scanNights(trimmed);
    if (checkin && nights && /^\d{4}-\d{2}-\d{2}$/.test(checkin)) slots[checkoutField.key] = addDaysIso(checkin, nights);
  }

  // 「2+2+4+4」這種房間組合沒有欄位標籤，上面的擷取器抓不到，但它是明確指定要哪幾間房
  // 但同一句又講了對不上的間數（「2+4+4的房型嗎? 可以給我4間房嗎?」）時，組合是在複述目前的
  // 報價、間數才是新要求——規則版不知道各房型有幾間、挑不出 4 間的組合，就乾脆不採用組合，
  // 免得拿複述的內容重新報一張一模一樣的價。
  const composition = scanRoomComposition(trimmed, ctx.fields);
  const roomTotal = scanRoomTotal(trimmed);
  const compositionRooms = Object.values(composition).reduce((s, v) => s + Number(v), 0);
  if (roomTotal === undefined || compositionRooms === roomTotal) {
    for (const [k, v] of Object.entries(composition)) if (slots[k] === undefined) slots[k] = v;
  }

  // 「多 1 大人 1 小孩」這種相對人數：句子裡沒有絕對人數，只有加減，要用現有人數去算
  const headcountField = ctx.fields.find((f) => f.quote_field === 'headcount');
  if (headcountField && slots[headcountField.key] === undefined) {
    const next = scanHeadcountDelta(trimmed, Number(ctx.collected[headcountField.key]));
    if (next !== undefined) slots[headcountField.key] = String(next);
  }

  if (Object.keys(slots).length > 0) {
    return rules(ctx.phase === 'collecting' ? 'provide_info' : 'modify', slots);
  }

  // 客服剛問的欄位只剩一個沒填、客人回一個數字：那就是答案
  const asked = ctx.fields.filter((f) => !ctx.collected[f.key] && (!ctx.askedKeys || ctx.askedKeys.includes(f.key)));
  if (ctx.phase === 'collecting' && asked.length === 1) {
    const bare = interpretBareAnswer(trimmed, asked[0]);
    if (bare !== undefined) return rules('provide_info', { [asked[0].key]: bare });
  }

  if (ctx.phase === 'awaiting_remittance' && looksLikePaymentReport(trimmed)) return rules('payment_report');
  if (looksLikeQuestion(trimmed)) return rules('question');
  if (ctx.phase === 'collecting' && isNoAnswer(trimmed)) return rules('decline');

  // 待匯款階段預設當成匯款回報：漏掉一筆真的匯款回報（客服沒收到通知、款項沒人核對）
  // 比把一句閒聊誤當回報嚴重。
  if (ctx.phase === 'awaiting_remittance') return rules('payment_report');
  return rules('unclear');
}

// ------------------------------------------------------------------------
// AI 版：組提示詞、解析回覆
// ------------------------------------------------------------------------

const PHASE_DESCRIPTION: Record<BookingPhase, string> = {
  collecting: '收集訂房資訊中：還在向客人詢問日期、人數、房數等，尚未報價。',
  awaiting_confirmation: '已送出報價、等待客人確認：客人回「是」就成立訂單、「否」取消。',
  awaiting_remittance: '訂單已成立、等待客人匯款：客人應回報匯款完成或帳號末五碼。',
};

function describeFieldType(f: IntentFieldDef): string {
  switch (f.quote_field) {
    case 'checkin_date': return '入住日期，輸出 YYYY-MM-DD';
    case 'checkout_date': return '退房日期，輸出 YYYY-MM-DD';
    case 'headcount': return '總人數，輸出整數';
    case 'room_count': return `${f.room_capacity ?? '?'} 人房要幾間，輸出整數；客人沒提到就不要填`;
    case 'whole_house': return '是否包棟，輸出 true 或 false';
    case 'order_number': return '訂單編號';
    default: return f.value_type === 'date' ? '日期，輸出 YYYY-MM-DD' : f.value_type === 'number' ? '數字' : '自由文字';
  }
}

export function buildIntentPrompt(ctx: IntentContext): string {
  const collectedLines = ctx.fields
    .filter((f) => ctx.collected[f.key])
    .map((f) => `  - ${f.label}（${f.key}）：${ctx.collected[f.key]}`);
  const fieldLines = ctx.fields.map((f) => `  - ${f.key}：${f.label}，${describeFieldType(f)}`);
  const historyLines = ctx.recentMessages.slice(-8).map((m) => `  ${m.role === 'customer' ? '客人' : '客服'}：${m.text.replace(/\s+/g, ' ').slice(0, 200)}`);
  // 客服上一句問的是「要不要排候補」時，confirm 的意思就換成「同意排候補」。不換的話模型會照
  // 原本的定義說 confirm 只出現在待確認階段，把客人那句「好」判成 unclear。
  const confirmDefinition = ctx.pendingWaitlist
    ? '- confirm：同意客服上一句問的事。現在問的是「要不要幫您排候補」，所以「好／要／可以／幫我排」就是 confirm。'
    : '- confirm：純粹的同意報價、確定要訂，沒有附帶任何其他要求或條件。只有在「待確認」階段才會出現。';
  const waitlistBlock = ctx.pendingWaitlist
    ? `【客服上一句問的是「要不要幫您排候補」】
  同意（好／要／可以／幫我排候補）＝confirm；拒絕（不用／不要／算了／沒關係）＝decline。
  客人改講別的日期或人數，照常判 provide_info／modify；問候補本身怎麼運作（要等多久、是什麼）＝question。
`
    : '';
  const askedLabels = (ctx.askedKeys || [])
    .map((k) => ctx.fields.find((f) => f.key === k))
    .filter((f): f is IntentFieldDef => !!f && !ctx.collected[f.key])
    .map((f) => `${f.label}（${f.key}）`);

  return `你是民宿訂房 LINE 客服的「意圖分類器」。根據目前對話狀態，判斷客人這句話的意圖，並抽出訂房欄位。只輸出 JSON，不要任何其他文字。

今天是 ${ctx.todayIso}。

【目前階段】${PHASE_DESCRIPTION[ctx.phase]}

【已收集的欄位】
${collectedLines.length ? collectedLines.join('\n') : '  （尚無）'}

【可填的欄位】
${fieldLines.join('\n')}

【客服上一句問的欄位】
${askedLabels.length ? '  ' + askedLabels.join('、') : '  （無）'}

【最近對話（舊到新）】
${historyLines.length ? historyLines.join('\n') : '  （無）'}

${waitlistBlock}【意圖定義】只能是以下之一：
- provide_info：提供或補充訂房資訊（日期、人數、房數、備註）。包含「只回一個數字」補上剩下那一欄的情況。
${confirmDefinition}
- decline：不訂了、取消。
- modify：要更改「已收集」的資訊（例如「改成 3 個人」「日期換 10/10」「好啊但改成…」）。一定要把新值放進 slots。
- question：詢問民宿相關的問題（早餐、停車、入住時間、付款方式、設施…）。
- restart：要重新開始（「我要訂房」「重新報價」「重來」），而且這句沒有附帶任何欄位內容。
- payment_report：回報已匯款、提供帳號末五碼。只有在「待匯款」階段才會出現。
- unclear：以上皆非、或無法判斷。

【判斷規則】
- 客人只回一個數字：對應到「客服上一句問的欄位」裡唯一的數字類欄位；有多個數字類欄位就 unclear。
- 同一句話既有欄位值又像在問問題時，以欄位值為主（provide_info 或 modify）。
- 已收集的欄位，客人明確給了不同的值 → modify；還沒收集的欄位給了值 → provide_info。
- 「好啊但…」「可以，不過…」這種帶條件的同意，不是 confirm，看條件內容判斷是 modify 或 question。
- 日期沒寫年份：該日期今年還沒過就用今年，已經過了就用明年。「明年 3 月 3 號」就是明年。
- 客人只講住幾晚（「住一晚」「兩天一夜」「3 晚」）：退房日＝入住日＋晚數，直接算出來填進退房日期。
- 「大約 8 人」「8 個人左右」：人數就填 8。
- 房數欄位客人沒提到就不要填，不要填 0。
- 「2+2+4+4」「2人房兩間、4人房兩間」這種房間組合＝指定各房型各要幾間，拆進對應的房數欄位（這個例子是 2 人房 2 間、4 人房 2 間），沒被提到的房型填 0。
- 「多 1 大人 1 小孩」「再加兩人」「少 1 位」是**相對**的人數變動：新人數＝目前人數加減這些數字（目前 9 人、「多1大人1小孩」就是 11），不要把句子裡的 1 當成總人數。
- 「可以給我 4 間房嗎？」只講了間數沒講組合：一樣是 modify，房數欄位不用填，系統會自己挑組合。
- 「想改成 X 間房」「能給我 2+2+4+4 的報價嗎？」這類**要求用不同條件重新報價**的話一律是 modify，不是 question——就算句尾有問號、語氣像在詢問也一樣。question 只留給「民宿本身的事」（早餐、停車、設施、入住時間、付款方式）。
- 客人把整張表單（含「入住日期：」這類標籤）貼回來時，逐行對應欄位；留空的行不填。
- 不確定就 unclear，不要猜。

【輸出格式】
{"intent": "<意圖>", "slots": {"<欄位 key>": "<值>"}, "reason": "<十個字內的理由>"}
slots 沒有內容就給空物件 {}。`;
}

export function parseIntentResponse(raw: string, ctx: IntentContext): IntentResult | null {
  try {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    // 有時模型會在 JSON 前後多講一句，抓第一個 { 到最後一個 } 之間
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(cleaned.slice(start, end + 1));

    const intent = String(parsed.intent || '').trim() as BookingIntent;
    if (!INTENTS.includes(intent)) return null;

    const slots: Record<string, string> = {};
    const rawSlots = parsed.slots && typeof parsed.slots === 'object' ? parsed.slots : {};
    const validKeys = new Set(ctx.fields.map((f) => f.key));
    for (const [k, v] of Object.entries(rawSlots)) {
      if (!validKeys.has(k)) continue;
      if (v === null || v === undefined || v === '') continue;
      slots[k] = typeof v === 'boolean' ? String(v) : String(v).trim();
    }

    // 階段不對的意圖降級：待確認以外的階段不可能「確認報價」，待匯款以外不可能「回報匯款」。
    // 模型偶爾會被字面意思帶走（收集中客人回「好」），這裡擋一道。
    let finalIntent = intent;
    // 例外：客服上一句在問「要不要排候補」時，收集中階段的 confirm 是在回答那一句。
    if (intent === 'confirm' && ctx.phase !== 'awaiting_confirmation' && !ctx.pendingWaitlist) finalIntent = 'unclear';
    if (intent === 'payment_report' && ctx.phase !== 'awaiting_remittance') finalIntent = 'unclear';
    // restart 帶了欄位值等於矛盾——客人是在提供資訊，不是要重來
    if (intent === 'restart' && Object.keys(slots).length > 0) finalIntent = 'provide_info';

    return { intent: finalIntent, slots, source: 'ai', reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 60) : undefined };
  } catch {
    return null;
  }
}

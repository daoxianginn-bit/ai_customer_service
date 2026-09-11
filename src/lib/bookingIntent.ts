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

export const QUOTE_ESSENTIAL_FIELDS = ['checkin_date', 'checkout_date', 'headcount'] as const;

/** 算價必要的欄位裡，還沒填的那些。房數是選填，不會出現在這裡。 */
export function missingEssentialFields(fields: IntentFieldDef[], collected: Record<string, string>): IntentFieldDef[] {
  return fields.filter(
    (f) => f.quote_field && (QUOTE_ESSENTIAL_FIELDS as readonly string[]).includes(f.quote_field) && !collected[f.key]
  );
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

【意圖定義】只能是以下之一：
- provide_info：提供或補充訂房資訊（日期、人數、房數、備註）。包含「只回一個數字」補上剩下那一欄的情況。
- confirm：純粹的同意報價、確定要訂，沒有附帶任何其他要求或條件。只有在「待確認」階段才會出現。
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
- 日期沒寫年份：該日期今年還沒過就用今年，已經過了就用明年。
- 房數欄位客人沒提到就不要填，不要填 0。
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
    if (intent === 'confirm' && ctx.phase !== 'awaiting_confirmation') finalIntent = 'unclear';
    if (intent === 'payment_report' && ctx.phase !== 'awaiting_remittance') finalIntent = 'unclear';
    // restart 帶了欄位值等於矛盾——客人是在提供資訊，不是要重來
    if (intent === 'restart' && Object.keys(slots).length > 0) finalIntent = 'provide_info';

    return { intent: finalIntent, slots, source: 'ai', reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 60) : undefined };
  } catch {
    return null;
  }
}

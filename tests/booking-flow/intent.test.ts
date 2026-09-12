// 意圖分類器的單元測試：規則版分類、AI 回覆解析、提示詞內容。不碰資料庫與 LINE。
import { __quoteFlowTesting } from '../../netlify/functions/line-webhook';
const { extractStepFieldsWithoutAi } = __quoteFlowTesting;
import {
  classifyByRules, parseIntentResponse, buildIntentPrompt, missingEssentialFields, scanNights, addDaysIso,
  type IntentContext, type IntentFieldDef,
} from '../../src/lib/bookingIntent';

const fields: IntentFieldDef[] = [
  { key: 'checkin', label: '入住日期', quote_field: 'checkin_date' },
  { key: 'checkout', label: '退房日期', quote_field: 'checkout_date' },
  { key: 'headcount', label: '人數', quote_field: 'headcount' },
  { key: 'r2', label: '雙人房數', quote_field: 'room_count', room_capacity: 2 },
  { key: 'r4', label: '四人房數', quote_field: 'room_count', room_capacity: 4 },
  { key: 'notes', label: '備註', quote_field: null },
];
const four = { checkin: '2027-02-02', checkout: '2027-02-04', headcount: '12', r4: '3' };
const ctx = (phase: IntentContext['phase'], collected: Record<string, string> = {}): IntentContext =>
  ({ phase, fields, collected, recentMessages: [], todayIso: '2026-09-11' });
const extract = (m: string, f: IntentFieldDef[]) => extractStepFieldsWithoutAi(m, f as any);
const filled = `🏡 AI報價\n請直接回覆以下資訊，我們會協助您確認：\n\n入住日期：2/2\n退房日期：2/4\n人數：12\n雙人房數：\n四人房數：3\n備註：`;

const checks: [string, boolean][] = [];
const t = (name: string, ok: boolean) => checks.push([name, ok]);
const c = (phase: IntentContext['phase'], collected: Record<string, string>, msg: string) => classifyByRules(msg, ctx(phase, collected), extract);

// ===== 規則分類：收集中 =====
let r = c('collecting', {}, filled);
t('收集中｜填好的範本 → provide_info，抓 4 欄，雙人房不填', r.intent === 'provide_info' && Object.keys(r.slots).length === 4 && r.slots.r2 === undefined);
r = c('collecting', {}, '我要訂房');
t('收集中｜「我要訂房」→ unclear（觸發字由呼叫端判斷重來）', r.intent === 'unclear');
r = c('collecting', four, '1');
t('收集中｜只剩雙人房與備註… 回「1」→ 不是單一缺欄', r.intent !== 'provide_info' || r.slots.headcount === undefined);
r = c('collecting', { ...four, notes: '無' }, '1');
t('收集中｜只剩雙人房數、回「1」→ provide_info r2=1，人數不被覆蓋', r.intent === 'provide_info' && r.slots.r2 === '1' && r.slots.headcount === undefined);
r = c('collecting', four, '人數：15');
t('收集中｜「人數：15」有標籤 → 允許覆蓋', r.intent === 'provide_info' && r.slots.headcount === '15');
r = c('collecting', four, '有早餐嗎');
t('收集中｜「有早餐嗎」→ question', r.intent === 'question');
r = c('collecting', four, '重新報價');
t('收集中｜「重新報價」→ restart', r.intent === 'restart');
r = c('collecting', {}, '你好');
t('收集中｜「你好」→ unclear', r.intent === 'unclear');
r = c('collecting', four, '備註：想烤肉');
t('收集中｜「備註：想烤肉」→ provide_info notes', r.intent === 'provide_info' && r.slots.notes === '想烤肉');
r = c('collecting', four, '不要了');
t('收集中｜「不要了」→ decline', r.intent === 'decline');

// ===== 規則分類：待確認 =====
r = c('awaiting_confirmation', four, '是');
t('待確認｜「是」→ confirm', r.intent === 'confirm');
r = c('awaiting_confirmation', four, '好的');
t('待確認｜「好的」→ confirm', r.intent === 'confirm');
r = c('awaiting_confirmation', four, '否');
t('待確認｜「否」→ decline', r.intent === 'decline');
r = c('awaiting_confirmation', four, '有早餐嗎');
t('待確認｜「有早餐嗎」→ question', r.intent === 'question');
r = c('awaiting_confirmation', four, '好啊但我想改成10/10');
t('待確認｜「好啊但我想改成10/10」→ 規則版 unclear（哪個日期只有 AI 分得出，交真人）', r.intent === 'unclear');
r = c('awaiting_confirmation', four, '改成3個人');
t('待確認｜「改成3個人」→ 規則版無標籤不覆蓋 → unclear（交給 AI/真人）', r.intent === 'unclear');
r = c('awaiting_confirmation', four, '人數改成3人');
t('待確認｜「人數改成3人」→ modify headcount=3', r.intent === 'modify' && r.slots.headcount === '3');
r = c('awaiting_confirmation', four, '早餐');
t('待確認｜「早餐」→ unclear（交真人）', r.intent === 'unclear');

// ===== 規則分類：待匯款 =====
r = c('awaiting_remittance', four, '已匯款 末五碼12345');
t('待匯款｜「已匯款 末五碼12345」→ payment_report', r.intent === 'payment_report');
r = c('awaiting_remittance', four, '12345');
t('待匯款｜「12345」→ payment_report', r.intent === 'payment_report');
r = c('awaiting_remittance', four, '有早餐嗎');
t('待匯款｜「有早餐嗎」→ question', r.intent === 'question');
r = c('awaiting_remittance', four, '轉好了');
t('待匯款｜「轉好了」→ payment_report', r.intent === 'payment_report');
r = c('awaiting_remittance', four, '嗨');
t('待匯款｜「嗨」→ 預設 payment_report（保守）', r.intent === 'payment_report');

// ===== AI 回覆解析 =====
let p = parseIntentResponse('{"intent":"question","slots":{},"reason":"問早餐"}', ctx('awaiting_confirmation', four));
t('解析｜正常 JSON', p?.intent === 'question' && p.source === 'ai' && p.reason === '問早餐');
p = parseIntentResponse('```json\n{"intent":"modify","slots":{"headcount":"3"}}\n```', ctx('awaiting_confirmation', four));
t('解析｜code fence 包住', p?.intent === 'modify' && p.slots.headcount === '3');
p = parseIntentResponse('好的，判斷如下：{"intent":"confirm","slots":{}} 以上', ctx('awaiting_confirmation', four));
t('解析｜前後有廢話', p?.intent === 'confirm');
p = parseIntentResponse('{"intent":"confirm","slots":{}}', ctx('collecting', {}));
t('解析｜收集中回 confirm → 降級 unclear', p?.intent === 'unclear');
p = parseIntentResponse('{"intent":"payment_report","slots":{}}', ctx('collecting', {}));
t('解析｜收集中回 payment_report → 降級 unclear', p?.intent === 'unclear');
p = parseIntentResponse('{"intent":"restart","slots":{"checkin":"2027-02-02"}}', ctx('collecting', {}));
t('解析｜restart 卻帶欄位 → 改成 provide_info', p?.intent === 'provide_info' && p.slots.checkin === '2027-02-02');
p = parseIntentResponse('{"intent":"provide_info","slots":{"bogus":"x","r2":"","headcount":null,"checkin":"2027-02-02"}}', ctx('collecting', {}));
t('解析｜過濾未知 key、空值、null', p !== null && Object.keys(p.slots).join() === 'checkin');
p = parseIntentResponse('{"intent":"teleport","slots":{}}', ctx('collecting', {}));
t('解析｜未知意圖 → null', p === null);
p = parseIntentResponse('完全不是 JSON', ctx('collecting', {}));
t('解析｜非 JSON → null', p === null);

// ===== 晚數 → 退房日 =====
t('晚數｜「住一晚」→ 1', scanNights('住一晚') === 1);
t('晚數｜「兩天一夜」→ 1（以夜為準）', scanNights('兩天一夜') === 1);
t('晚數｜「三天兩夜」→ 2', scanNights('三天兩夜') === 2);
t('晚數｜「3晚」→ 3', scanNights('3晚') === 3);
t('晚數｜「住2個晚上」→ 2', scanNights('住2個晚上') === 2);
t('晚數｜「有早餐嗎」→ 無', scanNights('有早餐嗎') === undefined);
t('日期加法｜2027-03-03 +1 → 2027-03-04', addDaysIso('2027-03-03', 1) === '2027-03-04');
t('日期加法｜跨月 2027-02-28 +1 → 2027-03-01', addDaysIso('2027-02-28', 1) === '2027-03-01');
r = c('collecting', { checkin: '2027-03-03', headcount: '8' }, '住一晚');
t('規則｜有入住日、回「住一晚」→ provide_info 退房=入住+1', r.intent === 'provide_info' && r.slots.checkout === '2027-03-04');
r = c('collecting', { headcount: '8' }, '住一晚');
t('規則｜沒有入住日、回「住一晚」→ 推不出退房日 → unclear', r.intent === 'unclear');
r = c('collecting', {}, '3/3入住 住兩晚 8人');
t('規則｜「3/3入住 住兩晚 8人」一句話 → 三要素齊', r.intent === 'provide_info' && r.slots.checkout === addDaysIso(r.slots.checkin, 2) && r.slots.headcount === '8');

// ===== 必要欄位 =====
t('必要欄位｜四欄齊 → 無缺', missingEssentialFields(fields, four).length === 0);
t('必要欄位｜只有入住 → 缺退房、人數', missingEssentialFields(fields, { checkin: 'x' }).map((f) => f.label).join() === '退房日期,人數');

// ===== 提示詞含關鍵內容 =====
const prompt = buildIntentPrompt({ ...ctx('awaiting_confirmation', four), recentMessages: [{ role: 'bot', text: '報價 25000' }, { role: 'customer', text: '有早餐嗎' }] });
t('提示詞｜含階段、已收集、欄位、對話', /待確認/.test(prompt) && /人數（headcount）：12/.test(prompt) && /r2：雙人房數/.test(prompt) && /客人：有早餐嗎/.test(prompt));

let ok = true;
for (const [k, v] of checks) { console.log((v ? '✓ ' : '✗ ') + k); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

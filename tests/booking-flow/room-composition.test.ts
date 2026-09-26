// 客人講房間組合（「能給我 2+2+4+4 的報價嗎？」）要走重新報價，不是被丟給真人客服。
// 實際發生：訂單已成立、客人想改成 4 間房並指定 2+2+4+4，AI 判成 question，
// 回了「需由真人客服確認價格與房況」，但這個組合系統自己算得出來（多開的房間算加開房費）。
import { classifyByRules, scanRoomComposition, type IntentContext, type IntentFieldDef } from '../../src/lib/bookingIntent';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const fields: IntentFieldDef[] = [
  { key: 'checkin', label: '入住日期', quote_field: 'checkin_date', value_type: 'date' },
  { key: 'checkout', label: '退房日期', quote_field: 'checkout_date', value_type: 'date' },
  { key: 'people', label: '人數', quote_field: 'headcount', value_type: 'number' },
  { key: 'r2', label: '2人房數', quote_field: 'room_count', room_capacity: 2, value_type: 'number' },
  { key: 'r4', label: '4人房數', quote_field: 'room_count', room_capacity: 4, value_type: 'number' },
];
const collected = { checkin: '2026-10-06', checkout: '2026-10-07', people: '9' };

// ---- 解析
t('「2+2+4+4」＝2人房 2 間、4人房 2 間', (() => {
  const s = scanRoomComposition('好的我要改成4間房，能給我2+2+4+4的報價嗎?', fields);
  return s.r2 === '2' && s.r4 === '2';
})(), scanRoomComposition('好的我要改成4間房，能給我2+2+4+4的報價嗎?', fields));
t('「4+4」＝4人房 2 間，沒被提到的 2 人房明確填 0（舊組合不留著）', (() => {
  const s = scanRoomComposition('改成4+4就好', fields);
  return s.r4 === '2' && s.r2 === '0';
})());
t('全形加號也認得', scanRoomComposition('2＋4', fields).r2 === '1');
t('「7+2小」是人數寫法不是房間組合（7 不是任何房型的人數）', Object.keys(scanRoomComposition('7+2小', fields)).length === 0);
t('「9+1」不是房間組合', Object.keys(scanRoomComposition('9+1人', fields)).length === 0);
t('單一個數字不算組合（「4人房」分不出是幾間）', Object.keys(scanRoomComposition('有4人房嗎', fields)).length === 0);
t('沒有房數欄位的流程不會誤判', Object.keys(scanRoomComposition('2+2+4+4', fields.filter((f) => f.quote_field !== 'room_count'))).length === 0);
t('取最長的一串（2+2+4+4 不會只吃到 2+2）', (() => {
  const s = scanRoomComposition('2+2+4+4', fields);
  return s.r2 === '2' && s.r4 === '2';
})());

// ---- 規則分類器（system 模式／AI 失敗時的退路）
const ctx = (phase: IntentContext['phase']): IntentContext => ({
  phase, fields, collected, recentMessages: [], todayIso: '2026-09-26',
});
const extract = () => ({});

const afterQuote = classifyByRules('好的我要改成4間房，能給我2+2+4+4的報價嗎?', ctx('awaiting_remittance'), extract);
t('待匯款階段指定房間組合 → modify（會重新報價），不是 payment_report', afterQuote.intent === 'modify' && afterQuote.slots.r2 === '2' && afterQuote.slots.r4 === '2', afterQuote);
const confirming = classifyByRules('可以改成2+2+4+4嗎', ctx('awaiting_confirmation'), extract);
t('待確認階段指定房間組合 → modify', confirming.intent === 'modify' && confirming.slots.r4 === '2', confirming);
const collecting = classifyByRules('我要2+2+4+4', ctx('collecting'), extract);
t('收集中指定房間組合 → provide_info', collecting.intent === 'provide_info' && collecting.slots.r2 === '2', collecting);
const asking = classifyByRules('請問有停車位嗎', ctx('awaiting_remittance'), extract);
t('一般問題仍然是 question，不受影響', asking.intent === 'question', asking);
const remit = classifyByRules('已匯款末五碼12345', ctx('awaiting_remittance'), extract);
t('匯款回報仍然是 payment_report', remit.intent === 'payment_report', remit);

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

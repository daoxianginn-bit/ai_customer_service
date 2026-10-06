// 對話紀錄裡「資訊明明夠、系統卻答得含糊」的幾個案例：
//   「9/29-30」只抓到入住日、-30 被當成 30 人
//   「所以你們提供2+4+4的房型嗎? 可以給我4間房嗎?」重送同一張報價、或被轉真人
//   「如果多1大人1小孩價格一樣嗎?」AI 判成 unclear 時被轉真人
import { quoteFlowDeps, __quoteFlowTesting, flushPendingWrites } from '../../netlify/functions/line-webhook';
import { __reset, __db } from './stubs/supabase';
import { __sent, Client } from './stubs/line';

const { handleQuoteConversation, tryStartQuoteFromCompleteInfo, extractStepFieldsWithoutAi, runTurn, setActiveChannelId } = __quoteFlowTesting;

const calls: { fn: string; args: any }[] = [];
const record = (fn: string) => async (...args: any[]) => { calls.push({ fn, args }); return true; };
let aiReply = '{"intent":"unclear","slots":{}}';
quoteFlowDeps.finishBookingFlow = record('finishBookingFlow') as any;
quoteFlowDeps.confirmQuote = record('confirmQuote') as any;
quoteFlowDeps.declineQuote = record('declineQuote') as any;
quoteFlowDeps.handleRemittanceReport = record('handleRemittanceReport') as any;
quoteFlowDeps.restartQuoteFlow = record('restartQuoteFlow') as any;
quoteFlowDeps.startBookingFlow = record('startBookingFlow') as any;
quoteFlowDeps.requoteWithCollected = record('requoteWithCollected') as any;
quoteFlowDeps.callAi = async () => aiReply;

const fields = [
  { key: 'checkin', label: '入住日期', quote_field: 'checkin_date' },
  { key: 'checkout', label: '退房日期', quote_field: 'checkout_date' },
  { key: 'headcount', label: '人數', quote_field: 'headcount' },
  { key: 'r2', label: '雙人房數', quote_field: 'room_count', room_capacity: 2 },
  { key: 'r4', label: '四人房數', quote_field: 'room_count', room_capacity: 4 },
];
const mkFlow = () => ({
  id: 'flow1', name: 'AI報價', replyMode: 'ai', flowType: 'quote',
  triggerRules: [{ keyword: '我要訂房', match: 'contains' }],
  quoteMessage: null, confirmMessage: null, incompleteMessage: null, completionMessage: null, notifyAgentOnComplete: true,
  foundMessage: null, notFoundMessage: null, takenMessage: null, remittanceReceivedMessage: null,
  steps: [{ step_order: 1, message_template: '請提供日期人數房數', fields }],
});
const settings = { active_ai: 'gpt', agent_user_ids: 'agent1', handover_notification_group_id: null };
// 館內 5 間房：2 人房 2 間、4 人房 3 間。報價開的是 2+4+4（rA、rC、rD）
const roomTypes = [
  { id: 'rA', type: '房間', capacity: 2, is_active: true },
  { id: 'rB', type: '房間', capacity: 2, is_active: true },
  { id: 'rC', type: '房間', capacity: 4, is_active: true },
  { id: 'rD', type: '房間', capacity: 4, is_active: true },
  { id: 'rE', type: '房間', capacity: 4, is_active: true },
];
const quoted = { checkin: '2026-10-07', checkout: '2026-10-08', headcount: '9' };

async function confirmTurn(msg: string, ai: string) {
  calls.length = 0; __sent.length = 0;
  __reset({
    booking_flows: [], booking_flow_steps: [], room_types: roomTypes,
    user_states: [{ channel_id: 'ch1', line_user_id: 'U1', booking_session: null }],
    bookings: [{ id: 'b1', channel_id: 'ch1', line_user_id: 'U1', status: 'awaiting_deposit', collected_answers: quoted }],
    conversations: [], message_variables: [],
  });
  aiReply = ai;
  setActiveChannelId('ch1');
  const session = { flowId: 'flow1', stepIndex: 0, collected: quoted, bookingId: 'b1', phase: 'awaiting_confirmation', quote: { total: 10000, roomNights: [], roomIds: ['rA', 'rC', 'rD'] }, updatedAt: Date.now() };
  let handled: boolean | undefined;
  await runTurn(async () => {
    handled = await handleQuoteConversation({
      lineClient: new Client({}), lineEvent: { replyToken: 'tok' }, settings, userId: 'U1', nickname: '客人',
      userMessage: msg, session: session as any, flow: mkFlow() as any, isImage: false,
    });
  });
  await flushPendingWrites();
  return { handled, calls: [...calls], replies: __sent.filter((s) => s.kind === 'reply').map((s) => s.text), pushes: __sent.filter((s) => s.kind === 'push').map((s) => s.text) };
}

async function cold(msg: string) {
  calls.length = 0; __sent.length = 0;
  __reset({
    booking_flows: [], booking_flow_steps: [],
    user_states: [{ channel_id: 'ch1', line_user_id: 'U1', booking_session: null }],
    bookings: [], conversations: [], message_variables: [],
  });
  setActiveChannelId('ch1');
  let handled: boolean | undefined;
  await runTurn(async () => {
    handled = await tryStartQuoteFromCompleteInfo(new Client({}), { replyToken: 'tok' }, settings, 'U1', '客人', msg, [mkFlow()] as any);
  });
  await flushPendingWrites();
  const session = (() => { try { return JSON.parse(__db.user_states[0].booking_session); } catch { return null; } })();
  return { handled, replies: __sent.filter((s) => s.kind === 'reply').map((s) => s.text), session };
}

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: any) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const called = (r: any, fn: string) => r.calls.some((c: any) => c.fn === fn);
const requoted = (r: any) => r.calls.find((c: any) => c.fn === 'requoteWithCollected')?.args[7];
const ex = (m: string, opts?: any) => extractStepFieldsWithoutAi(m, fields as any, opts);

(async () => {
  // ===== 日期範圍 =====
  let e = ex('9/29-30');
  t('日期範圍｜「9/29-30」→ 入住 9/29、退房 9/30、不會有 30 人', /-09-29$/.test(e.checkin || '') && /-09-30$/.test(e.checkout || '') && e.headcount === undefined, e);
  e = ex('9/30-1');
  t('日期範圍｜「9/30-1」跨月 → 9/30~10/1', /-09-30$/.test(e.checkin || '') && /-10-01$/.test(e.checkout || ''), e);
  e = ex('9月29到30號');
  t('日期範圍｜「9月29到30號」→ 9/29~9/30', /-09-29$/.test(e.checkin || '') && /-09-30$/.test(e.checkout || ''), e);
  e = ex('10/9~10 9人');
  t('日期範圍｜「10/9~10 9人」→ 10/9~10/10、9 人', /-10-09$/.test(e.checkin || '') && /-10-10$/.test(e.checkout || '') && e.headcount === '9', e);
  e = ex('9/29-3人');
  t('日期範圍｜「9/29-3人」不是範圍 → 9/29、3 人', /-09-29$/.test(e.checkin || '') && e.checkout === undefined && e.headcount === '3', e);
  e = ex('2026/12/31-1');
  t('日期範圍｜「2026/12/31-1」跨年 → 2027/01/01', e.checkin === '2026-12-31' && e.checkout === '2027-01-01', e);
  e = ex('9/29 30', { allowBareNumberHeadcount: false });
  t('人數｜冷啟動不把沒單位的「30」當人數', e.headcount === undefined, e);
  t('人數｜被問人數時回「9」仍然是 9 人', ex('9').headcount === '9');

  // ===== 冷啟動 =====
  const c = await cold('9/29-30');
  t('冷啟動｜「9/29-30」→ 開流程、只問人數（不再問退房、不用 30 人）', c.handled === true && /人數/.test(c.replies[0] || '') && !/退房/.test(c.replies[0] || '') && c.session?.collected?.headcount === undefined, c);

  // ===== 報價後：問的是目前的組合 =====
  let r = await confirmTurn('所以你們提供2+4+4的房型嗎?', '{"intent":"question","slots":{}}');
  t('確認報價｜「提供2+4+4的房型嗎?」→ 直接回答是這個組合，不重新報價', /是的/.test(r.replies[0] || '') && /2人房 1 間、4人房 2 間/.test(r.replies[0] || '') && !called(r, 'requoteWithCollected'), r);

  // ===== 報價後：組合（複述）＋間數（新要求） =====
  r = await confirmTurn('所以你們提供2+4+4的房型嗎? 可以給我4間房嗎?', '{"intent":"unclear","slots":{}}');
  t('確認報價｜AI 判 unclear →「4間房」重新報價（2+2+4+4），不轉真人', requoted(r)?.r2 === '2' && requoted(r)?.r4 === '2' && !r.replies.some((x) => /請專人/.test(x)), r);
  r = await confirmTurn('所以你們提供2+4+4的房型嗎? 可以給我4間房嗎?', '{"intent":"question","slots":{}}');
  t('確認報價｜AI 判 question → 一樣以「4間房」重新報價', requoted(r)?.r2 === '2' && requoted(r)?.r4 === '2', r);
  r = await confirmTurn('所以你們提供2+4+4的房型嗎? 可以給我4間房嗎?', '{"intent":"modify","slots":{"r2":"1","r4":"2"}}');
  t('確認報價｜AI 把 2+4+4 抽成房數 → 改用「4間房」，不重送同一張報價', requoted(r)?.r2 === '2' && requoted(r)?.r4 === '2', r);

  // ===== 報價後：相對人數 =====
  r = await confirmTurn('如果多1大人1小孩價格一樣嗎?', '{"intent":"unclear","slots":{}}');
  t('確認報價｜「多1大人1小孩」AI 判 unclear → 用 11 人重新報價，不轉真人', requoted(r)?.headcount === '11', r);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n    ${d}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})();

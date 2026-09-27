// 排不出房時「要不要幫您排候補」的問答：客人回「好」才登記候補，回「不用」、改日期、講看不懂的話
// 都不能自己排下去。測的是 handleQuoteConversation 收到 session.waitlistOffer 之後的分流。
import { quoteFlowDeps, __quoteFlowTesting, flushPendingWrites } from '../../netlify/functions/line-webhook';
import { __reset, __db } from './stubs/supabase';
import { __sent, Client } from './stubs/line';
import { classifyByRules, parseIntentResponse, buildIntentPrompt, scanWaitlistAnswer, type IntentContext } from '../../src/lib/bookingIntent';

const { handleQuoteConversation, runTurn, takeTurnReminder, setActiveChannelId, extractStepFieldsWithoutAi } = __quoteFlowTesting;
const extract = (m: string, f: any[]) => extractStepFieldsWithoutAi(m, f as any);

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
  { key: 'r4', label: '四人房數', quote_field: 'room_count', room_capacity: 4 },
];
const flow = {
  id: 'flow1', name: 'AI報價', replyMode: 'ai', flowType: 'quote',
  triggerRules: [{ keyword: '我要訂房', match: 'contains' }],
  quoteMessage: null, confirmMessage: null, incompleteMessage: null, completionMessage: null, notifyAgentOnComplete: true,
  foundMessage: null, notFoundMessage: null, takenMessage: null, remittanceReceivedMessage: null,
  steps: [{ step_order: 1, message_template: '請提供日期人數房數', fields }],
};
const collected = { checkin: '2027-02-02', checkout: '2027-02-04', headcount: '12', r4: '3' };
const offer = {
  bookingId: 'b1', checkinIso: '2027-02-02', checkoutIso: '2027-02-04', headcount: 12,
  shortfallText: '四人房少 1 間', blockedRange: '2027/02/02~2027/02/04', watchTargetId: 'blocker',
};
const settings = { active_ai: 'gpt', agent_user_ids: 'agent1', handover_notification_group_id: null };

async function turn(msg: string, ai = '{"intent":"unclear","slots":{}}', withOffer = true) {
  calls.length = 0; __sent.length = 0;
  __reset({
    booking_flows: [], booking_flow_steps: [],
    user_states: [{ channel_id: 'ch1', line_user_id: 'U1', booking_session: null }],
    bookings: [
      { id: 'b1', channel_id: 'ch1', line_user_id: 'U1', status: 'pending_manual_conflict', waitlist_blocked_by: null, collected_answers: collected },
      { id: 'blocker', channel_id: 'ch1', line_user_id: 'U2', status: 'reserved', checkin_date: '2027-02-01', checkout_date: '2027-02-03', updated_at: '2026-09-01' },
    ],
    conversations: [], message_variables: [],
  });
  aiReply = ai;
  setActiveChannelId('ch1');
  const session = { flowId: 'flow1', stepIndex: 0, collected, bookingId: 'b1', phase: 'in_flow', quote: null, waitlistOffer: withOffer ? offer : null, updatedAt: Date.now() };
  let handled: boolean | undefined; let reminder: string | null = null;
  await runTurn(async () => {
    handled = await handleQuoteConversation({
      lineClient: new Client({}), lineEvent: { replyToken: 'tok' }, settings, userId: 'U1', nickname: '客人',
      userMessage: msg, session: session as any, flow: flow as any, isImage: false,
    });
    reminder = takeTurnReminder();
  });
  await flushPendingWrites();
  const saved = (() => { try { return JSON.parse(__db.user_states[0].booking_session); } catch { return null; } })();
  return {
    handled, reminder, calls: [...calls], saved,
    replies: __sent.filter((s) => s.kind === 'reply').map((s) => s.text),
    pushes: __sent.filter((s) => s.kind === 'push').map((s) => s.text),
    booking: __db.bookings.find((b) => b.id === 'b1'),
  };
}

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: any) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const called = (r: any, fn: string) => r.calls.some((c: any) => c.fn === fn);

(async () => {
  // ===== 關鍵字判斷 =====
  t('判斷｜「幫我排候補」→ yes', scanWaitlistAnswer('幫我排候補') === 'yes');
  t('判斷｜「不用候補了」→ no', scanWaitlistAnswer('不用候補了') === 'no');
  t('判斷｜「候補要等多久」→ 不是在回答', scanWaitlistAnswer('候補要等多久') === undefined);
  t('判斷｜「好」沒提候補 → 交給一般 是／否 判斷', scanWaitlistAnswer('好') === undefined);

  const ctx = (pendingWaitlist: boolean): IntentContext => ({ phase: 'collecting', fields, collected, recentMessages: [], todayIso: '2026-09-27', pendingWaitlist });
  t('規則｜等候補答案時「好」→ confirm', classifyByRules('好', ctx(true), extract).intent === 'confirm');
  t('規則｜等候補答案時「不用」→ decline', classifyByRules('不用', ctx(true), extract).intent === 'decline');
  t('規則｜沒在等候補時「好」→ 不是 confirm', classifyByRules('好', ctx(false), extract).intent !== 'confirm');
  t('解析｜等候補答案時 AI 回 confirm → 不降級', parseIntentResponse('{"intent":"confirm","slots":{}}', ctx(true))?.intent === 'confirm');
  t('提示詞｜等候補答案時有說明候補問句', /要不要幫您排候補/.test(buildIntentPrompt(ctx(true))));

  // ===== 客人同意 =====
  let r = await turn('好');
  t('同意｜「好」→ 登記監看對象、回覆已排入候補', r.booking?.waitlist_blocked_by === 'blocker' && /已經幫您排入/.test(r.replies[0] || ''), r);
  t('同意｜通知客服「客人同意排候補」', r.pushes.some((p) => /客人同意排候補/.test(p)), r.pushes);
  t('同意｜session 的候補問句清掉、不重算報價', r.saved?.waitlistOffer == null && !called(r, 'finishBookingFlow'), r);

  r = await turn('麻煩幫我排候補', '{"intent":"unclear","slots":{}}');
  t('同意｜「麻煩幫我排候補」AI 判不出 → 規則仍認得是同意', r.booking?.waitlist_blocked_by === 'blocker', r);

  // ===== 客人拒絕 =====
  r = await turn('不用了');
  t('拒絕｜「不用了」→ 不登記候補，訂單留待人工確認', r.booking?.waitlist_blocked_by === null && r.booking?.status === 'pending_manual_conflict', r.booking);
  t('拒絕｜回覆「先不排候補」並通知客服，session 留著可改日期', /先不排候補/.test(r.replies[0] || '') && r.pushes.some((p) => /不排候補/.test(p)) && r.saved?.flowId === 'flow1', r);
  t('拒絕｜不會被當成取消訂房', !called(r, 'declineQuote'), r.calls);

  // ===== 客人改日期 =====
  r = await turn('那 2/10 到 2/12 呢', '{"intent":"modify","slots":{"checkin":"2027-02-10","checkout":"2027-02-12"}}');
  t('改日期｜不登記候補，照新日期重新試算', r.booking?.waitlist_blocked_by === null && (called(r, 'finishBookingFlow') || called(r, 'requoteWithCollected')), r);

  // ===== 問候補本身 =====
  r = await turn('候補要等多久', '{"intent":"question","slots":{}}');
  t('問問題｜交給 AI 問答、不登記，提醒回「好」排候補', r.handled === false && r.booking?.waitlist_blocked_by === null && /排候補/.test(r.reminder || ''), r);

  // ===== 看不懂 =====
  r = await turn('嗯嗯');
  t('看不懂｜再問一次要不要排候補，不重跑試算、不登記', /需要幫您排候補嗎/.test(r.replies[0] || '') && !called(r, 'finishBookingFlow') && r.booking?.waitlist_blocked_by === null, r);

  // ===== 沒問過候補 =====
  r = await turn('好', '{"intent":"confirm","slots":{}}', false);
  t('沒問過｜收集中回「好」不會登記候補', r.booking?.waitlist_blocked_by === null, r);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n    ${d}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})();

// 客人不能已讀不回，AI 也不能拿客人沒講過的條件去報價：
//   一般問答的各種空回覆（只回標記、推理吃光額度、Chat Completions 回空內容）都要有保底回覆＋通知客服
//   AI 抽出這句沒講到的欄位值不採用
//   待匯款階段的「4間」不能被當成要重新報價
//   候補回答、小數、「第2間」這幾種容易誤判的句子
import OpenAI from './stubs/openai';
import { quoteFlowDeps, __quoteFlowTesting, flushPendingWrites, extractResponsesApiText } from '../../netlify/functions/line-webhook';
import { __reset, __db } from './stubs/supabase';
import { __sent, Client } from './stubs/line';
import { dropUngroundedSlots, scanWaitlistAnswer, scanRoomTotal } from '../../src/lib/bookingIntent';

const { handleQuoteConversation, extractStepFieldsWithoutAi, runTurn, processLineEvent, setActiveChannelId } = __quoteFlowTesting;

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
const flow = {
  id: 'flow1', name: 'AI報價', replyMode: 'ai', flowType: 'quote',
  triggerRules: [{ keyword: '我要訂房', match: 'contains' }],
  quoteMessage: null, confirmMessage: null, incompleteMessage: null, completionMessage: null, notifyAgentOnComplete: true,
  foundMessage: null, notFoundMessage: null, takenMessage: null, remittanceReceivedMessage: null,
  steps: [{ step_order: 1, message_template: '請提供日期人數房數', fields }],
};
const collected = { checkin: '2026-10-07', checkout: '2026-10-08', headcount: '9' };
const settings = { active_ai: 'gpt', agent_user_ids: 'agent1', handover_notification_group_id: null };

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: any) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const called = (r: any, fn: string) => r.calls.some((c: any) => c.fn === fn);

// ---------- 一般問答整條跑：用假的 fetch 模擬 OpenAI Responses API ----------
let fetchQueue: any[] = [];
let fetchCount = 0;
(globalThis as any).__fetchStub = async () => {
  fetchCount++;
  const body = fetchQueue.shift() ?? { status: 'completed', output: [] };
  return { ok: true, statusText: 'OK', json: async () => body };
};
const responsesText = (text: string) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });

async function chat(msg: string, model: string, responses: any[], opts: { aiEnabled?: boolean; keepDb?: boolean } = {}) {
  fetchQueue = [...responses]; fetchCount = 0; __sent.length = 0;
  if (!opts.keepDb) __reset({
    booking_flows: [], booking_flow_steps: [], processed_events: [], knowledge_base_items: [], conversations: [], message_variables: [], room_types: [], handover_logs: [],
    user_states: [{ channel_id: 'ch1', line_user_id: 'U1', nickname: '客人', booking_session: null, flow_lock_at: null }],
    bookings: [],
  });
  const s = {
    ...settings, is_ai_enabled: opts.aiEnabled !== false, ai_ignore_keywords: '', handover_keywords: '',
    gpt_model_name: model, gpt_api_key: 'k', gpt_max_tokens: 500, gpt_temperature: 0.3, system_prompt: '你是客服',
  };
  await runTurn(async () => {
    await processLineEvent(
      { type: 'message', message: { type: 'text', text: msg }, source: { type: 'user', userId: 'U1' }, replyToken: 'tok', webhookEventId: `evt-${Math.random()}` } as any,
      s, new Client({}) as any, { id: 'ch1', name: '客戶用', role: 'customer' } as any,
    );
  });
  await flushPendingWrites();
  return {
    fetchCount,
    replies: __sent.filter((x) => x.kind === 'reply').map((x) => x.text),
    pushes: __sent.filter((x) => x.kind === 'push').map((x) => x.text),
    handovers: (__db.handover_logs || []).length,
  };
}

// ---------- 訂房對話：報價後 ----------
async function quoteTurn(phase: 'awaiting_confirmation' | 'awaiting_remittance', msg: string, ai: string) {
  calls.length = 0; __sent.length = 0;
  __reset({
    booking_flows: [], booking_flow_steps: [], room_types: [], conversations: [], message_variables: [],
    user_states: [{ channel_id: 'ch1', line_user_id: 'U1', booking_session: null }],
    bookings: [{ id: 'b1', channel_id: 'ch1', line_user_id: 'U1', status: 'awaiting_deposit', collected_answers: collected }],
  });
  aiReply = ai;
  setActiveChannelId('ch1');
  const session = { flowId: 'flow1', stepIndex: 0, collected, bookingId: 'b1', phase, quote: phase === 'awaiting_confirmation' ? { total: 1, roomNights: [], roomIds: [] } : null, updatedAt: Date.now() };
  await runTurn(async () => {
    await handleQuoteConversation({
      lineClient: new Client({}), lineEvent: { replyToken: 'tok' }, settings, userId: 'U1', nickname: '客人',
      userMessage: msg, session: session as any, flow: flow as any, isImage: false,
    });
  });
  await flushPendingWrites();
  return { calls: [...calls], replies: __sent.filter((s) => s.kind === 'reply').map((s) => s.text) };
}

(async () => {
  // ===== 不能已讀不回 =====
  let c = await chat('有消毒鍋嗎', 'gpt-5-mini', [responsesText('[[需專人]]')]);
  t('空回覆｜GPT 只回標記 → 客人收到「稍後由專人回覆」、開轉接紀錄並通知客服', c.replies.length === 1 && /稍後由專人回覆/.test(c.replies[0]) && c.handovers === 1 && c.pushes.some((p) => /AI 答不出來/.test(p)), c);

  c = await chat('有早餐嗎', 'gpt-5-mini', [
    { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'reasoning' }] },
    responsesText('我們有提供早餐喔'),
  ]);
  t('空回覆｜推理吃光額度 → 放寬額度重試一次，客人收到真正的答案', c.fetchCount === 2 && c.replies[0] === '我們有提供早餐喔', c);

  c = await chat('有早餐嗎', 'gpt-5-mini', [{ status: 'completed', output: [] }]);
  t('空回覆｜GPT-5 完全沒文字 → 保底「系統忙線」＋通知客服', /系統忙線中/.test(c.replies[0] || '') && c.pushes.some((p) => /AI 呼叫失敗/.test(p)), c);

  (OpenAI as any).next = { choices: [{ message: { content: null, refusal: '無法回答' }, finish_reason: 'stop' }] };
  c = await chat('有早餐嗎', 'gpt-4o-mini', []);
  t('空回覆｜Chat Completions 回空內容 → 保底「系統忙線」＋通知客服（以前整則不回）', /系統忙線中/.test(c.replies[0] || '') && c.pushes.some((p) => /AI 呼叫失敗/.test(p) && /refusal/.test(p)), c);

  (OpenAI as any).next = { choices: [{ message: { content: '我們早餐 8 點開始' }, finish_reason: 'stop' }] };
  c = await chat('有早餐嗎', 'gpt-4o-mini', []);
  t('正常｜Chat Completions 有內容 → 照送', c.replies[0] === '我們早餐 8 點開始', c);
  t('正常｜Responses API 解析', extractResponsesApiText(responsesText('ok')) === 'ok');

  c = await chat('請問有空房嗎', 'gpt-5-mini', [], { aiEnabled: false });
  t('AI 關閉｜回「稍後由專人回覆」、開轉接紀錄並通知客服', /稍後由專人回覆/.test(c.replies[0] || '') && c.handovers === 1 && c.pushes.some((p) => /AI 已關閉/.test(p)) && c.fetchCount === 0, c);
  c = await chat('在嗎', 'gpt-5-mini', [], { aiEnabled: false, keepDb: true });
  t('AI 關閉｜連傳第二句 → 照樣回覆，但不重複通知客服', /稍後由專人回覆/.test(c.replies[0] || '') && c.handovers === 1 && !c.pushes.some((p) => /AI 已關閉/.test(p)), c);

  // ===== AI 抽出這句沒講到的欄位 =====
  const g = dropUngroundedSlots('好喔 謝謝', fields as any, collected, { headcount: '12' });
  t('欄位根據｜「好喔 謝謝」AI 填人數 12 → 不採用', g.slots.headcount === undefined && g.dropped.includes('headcount'), g);
  t('欄位根據｜「改成12人」→ 採用', dropUngroundedSlots('改成12人', fields as any, collected, { headcount: '12' }).slots.headcount === '12');
  t('欄位根據｜「多兩位」→ 採用（中文數字）', dropUngroundedSlots('多兩位', fields as any, collected, { headcount: '11' }).slots.headcount === '11');
  t('欄位根據｜「改下週六」→ 日期採用', dropUngroundedSlots('改下週六', fields as any, collected, { checkin: '2026-10-10' }).slots.checkin === '2026-10-10');
  t('欄位根據｜「有早餐嗎」AI 填入住日 → 不採用', dropUngroundedSlots('有早餐嗎', fields as any, collected, { checkin: '2026-10-10' }).slots.checkin === undefined);
  t('欄位根據｜「好啊一起去」的「一」不算人數', dropUngroundedSlots('好啊一起去', fields as any, collected, { headcount: '1' }).slots.headcount === undefined);
  t('欄位根據｜值跟原本相同 → 不用檢查', dropUngroundedSlots('好', fields as any, collected, { headcount: '9' }).slots.headcount === '9');

  let r = await quoteTurn('awaiting_confirmation', '好喔 謝謝', '{"intent":"modify","slots":{"headcount":"12"}}');
  t('欄位根據｜報價後「好喔 謝謝」AI 判 modify 人數 12 → 不重新報價', !called(r, 'requoteWithCollected'), r);

  // ===== 待匯款不能被改成重新報價 =====
  r = await quoteTurn('awaiting_remittance', '已匯4間房的訂金', '{"intent":"unclear","slots":{}}');
  t('待匯款｜「已匯4間房的訂金」→ 當匯款回報，不重新報價', called(r, 'handleRemittanceReport') && !called(r, 'requoteWithCollected'), r);

  // ===== 候補回答 =====
  t('候補｜「沒關係，幫我排候補」→ 同意', scanWaitlistAnswer('沒關係，幫我排候補') === 'yes');
  t('候補｜「算了，還是排候補好了」→ 同意', scanWaitlistAnswer('算了，還是排候補好了') === 'yes');
  t('候補｜「候補算了」→ 不要', scanWaitlistAnswer('候補算了') === 'no');
  t('候補｜「不要幫我排候補」→ 不要', scanWaitlistAnswer('不要幫我排候補') === 'no');
  t('候補｜「候補好了沒？」→ 在問進度，不是回答', scanWaitlistAnswer('候補好了沒？') === undefined);

  // ===== 小數、第幾間 =====
  const e = extractStepFieldsWithoutAi('預算大概1.5-2萬', fields as any);
  t('日期｜「預算大概1.5-2萬」不是日期', e.checkin === undefined && e.checkout === undefined, e);
  t('間數｜「第2間房有浴缸嗎」不是要 2 間', scanRoomTotal('第2間房有浴缸嗎') === undefined);
  t('間數｜「第12間」不是要 2 間', scanRoomTotal('第12間') === undefined);
  t('間數｜「可以給我4間房嗎」→ 4', scanRoomTotal('可以給我4間房嗎') === 4);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n    ${d.slice(0, 500)}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });

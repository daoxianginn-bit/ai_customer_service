import { quoteFlowDeps, __quoteFlowTesting, flushPendingWrites } from '../../netlify/functions/line-webhook';
import { __reset, __db } from './stubs/supabase';
import { __sent, Client } from './stubs/line';
import { addDaysIso } from '../../src/lib/bookingIntent';

const { handleQuoteConversation, runTurn, takeTurnReminder, setActiveChannelId } = __quoteFlowTesting;

// ---------------- 假的重機械：只記錄被呼叫 ----------------
const calls: { fn: string; args: any }[] = [];
const record = (fn: string) => async (...args: any[]) => { calls.push({ fn, args }); return true; };
let aiReply: string | (() => Promise<string>) = '{"intent":"unclear","slots":{}}';
quoteFlowDeps.finishBookingFlow = record('finishBookingFlow') as any;
quoteFlowDeps.confirmQuote = record('confirmQuote') as any;
quoteFlowDeps.declineQuote = record('declineQuote') as any;
quoteFlowDeps.handleRemittanceReport = record('handleRemittanceReport') as any;
quoteFlowDeps.restartQuoteFlow = record('restartQuoteFlow') as any;
quoteFlowDeps.startBookingFlow = record('startBookingFlow') as any;
quoteFlowDeps.requoteWithCollected = record('requoteWithCollected') as any;
quoteFlowDeps.callAi = async () => (typeof aiReply === 'function' ? aiReply() : aiReply);

// ---------------- 測試資料 ----------------
const fields = [
  { key: 'checkin', label: '入住日期', quote_field: 'checkin_date' },
  { key: 'checkout', label: '退房日期', quote_field: 'checkout_date' },
  { key: 'headcount', label: '人數', quote_field: 'headcount' },
  { key: 'r2', label: '雙人房數', quote_field: 'room_count', room_capacity: 2 },
  { key: 'r4', label: '四人房數', quote_field: 'room_count', room_capacity: 4 },
];
const notesField = { key: 'notes', label: '備註', quote_field: null };
const mkFlow = (mode: 'ai' | 'system', twoSteps = false) => ({
  id: 'flow1', name: 'AI報價', replyMode: mode, flowType: 'quote',
  triggerRules: [{ keyword: '我要訂房', match: 'contains' }, { keyword: 'AI報價', match: 'contains' }],
  quoteMessage: null, confirmMessage: null, incompleteMessage: null, completionMessage: null, notifyAgentOnComplete: true,
  foundMessage: null, notFoundMessage: null, takenMessage: null, remittanceReceivedMessage: null,
  steps: twoSteps
    ? [{ step_order: 1, message_template: '請提供日期人數', fields }, { step_order: 2, message_template: '有什麼備註嗎？', fields: [notesField] }]
    : [{ step_order: 1, message_template: '請提供日期人數房數', fields: [...fields, notesField] }],
});
const otherFlowRow = { id: 'flow2', name: '常見問題', is_active: true, display_order: 2, flow_type: 'collect', reply_mode: 'system', trigger_rules: [{ keyword: '常見問題', match: 'contains' }] };
const otherFlowStep = { id: 's2', flow_id: 'flow2', step_order: 1, message_template: '這是常見問題的第一句', fields: [] };
const four = { checkin: '2027-02-02', checkout: '2027-02-04', headcount: '12', r4: '3' };
const filled = `🏡 AI報價\n請直接回覆以下資訊，我們會協助您確認：\n\n入住日期：2/2\n退房日期：2/4\n人數：12\n雙人房數：\n四人房數：3\n備註：`;
const settings = { active_ai: 'gpt', agent_user_ids: 'agent1', handover_notification_group_id: null };

const mkSession = (phase: 'in_flow' | 'awaiting_confirmation' | 'awaiting_remittance', collected: Record<string, string>, stepIndex = 0) =>
  ({ flowId: 'flow1', stepIndex, collected, bookingId: 'b1', phase, quote: phase === 'awaiting_confirmation' ? { total: 1, roomNights: [], roomIds: [] } : null, updatedAt: Date.now() });

async function turn(opts: { mode?: 'ai' | 'system'; twoSteps?: boolean; phase: 'in_flow' | 'awaiting_confirmation' | 'awaiting_remittance'; collected: Record<string, string>; msg: string; ai?: string | (() => Promise<string>); stepIndex?: number; isImage?: boolean }) {
  calls.length = 0; __sent.length = 0;
  __reset({
    booking_flows: [otherFlowRow],
    booking_flow_steps: [otherFlowStep],
    user_states: [{ channel_id: 'ch1', line_user_id: 'U1', booking_session: null }],
    bookings: [{ id: 'b1', channel_id: 'ch1', line_user_id: 'U1', status: opts.phase === 'in_flow' ? 'inquiring' : 'awaiting_deposit', collected_answers: opts.collected }],
    conversations: [], message_variables: [],
  });
  aiReply = opts.ai ?? '{"intent":"unclear","slots":{}}';
  setActiveChannelId('ch1');
  let handled: boolean | undefined; let reminder: string | null = null;
  await runTurn(async () => {
    handled = await handleQuoteConversation({
      lineClient: new Client({}), lineEvent: { replyToken: 'tok' }, settings, userId: 'U1', nickname: '客人',
      userMessage: opts.msg, session: mkSession(opts.phase, opts.collected, opts.stepIndex ?? 0) as any, flow: mkFlow(opts.mode ?? 'ai', opts.twoSteps) as any, isImage: !!opts.isImage,
    });
    reminder = takeTurnReminder();
  });
  await flushPendingWrites();
  const session = (() => { try { return JSON.parse(__db.user_states[0].booking_session); } catch { return null; } })();
  const replies = __sent.filter((s) => s.kind === 'reply').map((s) => s.text);
  const pushes = __sent.filter((s) => s.kind === 'push').map((s) => s.text);
  return { handled, reminder, calls, replies, pushes, session, booking: __db.bookings[0] };
}

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: any) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const called = (r: any, fn: string) => r.calls.some((c: any) => c.fn === fn);
const arg = (r: any, fn: string, i: number) => r.calls.find((c: any) => c.fn === fn)?.args[i];

(async () => {
  let r;

  // ===== 收集中 =====
  r = await turn({ mode: 'system', phase: 'in_flow', collected: {}, msg: filled });
  t('收集中｜貼填好的範本（雙人房留空）→ 直接試算，帶 4 欄', called(r, 'finishBookingFlow') && Object.keys(arg(r, 'finishBookingFlow', 6)).length === 4, r.calls);

  r = await turn({ mode: 'system', phase: 'in_flow', collected: four, msg: '1' });
  t('收集中｜三要素齊、剛問的欄位有兩個（雙人房、備註）、回「1」→ 對不到單一欄 → 選填不強求 → 試算', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).r2 === undefined && arg(r, 'finishBookingFlow', 6).headcount === '12', r);

  r = await turn({ mode: 'system', twoSteps: true, phase: 'in_flow', collected: four, stepIndex: 1, msg: '1' });
  t('收集中｜兩步驟、正在問第 2 步（只有備註）、回「1」→ 當備註 → 試算', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).notes === '1', r);

  r = await turn({ mode: 'system', phase: 'in_flow', collected: { checkin: '2027-02-02', checkout: '2027-02-04' }, msg: '12' });
  t('收集中｜只缺人數、回「12」→ 人數=12 → 試算', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).headcount === '12', r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: { checkin: '2027-02-02', checkout: '2027-02-04', r4: '3' }, msg: '12', ai: '{"intent":"provide_info","slots":{"headcount":"12"}}' });
  t('收集中｜AI 判定「12」是人數 → 三要素齊 → 試算，人數=12', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).headcount === '12', r.calls);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: {}, msg: '我要訂房' });
  t('收集中｜「我要訂房」→ 重新開始（startBookingFlow），不花 AI', called(r, 'startBookingFlow') && !called(r, 'restartQuoteFlow'), r.calls);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: four, msg: '有早餐嗎', ai: '{"intent":"question","slots":{}}' });
  t('收集中｜三要素齊、「有早餐嗎」→ 交給 AI 問答（handled=false）＋「還在進行中」提醒', r.handled === false && /即為您試算/.test(r.reminder || ''), r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: { checkin: '2027-02-02' }, msg: '有早餐嗎', ai: '{"intent":"question","slots":{}}' });
  t('收集中｜缺退房人數、「有早餐嗎」→ AI 問答 ＋「還需要：退房日期、人數」提醒', r.handled === false && /訂房還需要：退房日期、人數/.test(r.reminder || ''), r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: {}, msg: '嗨', ai: '{"intent":"unclear","slots":{}}' });
  t('收集中｜什麼都沒填、「嗨」→ 當閒聊交給 AI（handled=false）', r.handled === false && !!r.reminder, r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: { checkin: '2027-02-02' }, msg: '嗨', ai: '{"intent":"unclear","slots":{}}' });
  t('收集中｜填了一部分、意圖不明 → 再問缺的（退房、人數）', r.replies[0]?.includes('退房日期') && r.replies[0]?.includes('人數') && !r.replies[0]?.includes('雙人房'), r.replies);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: {}, msg: '常見問題' });
  t('收集中｜打到別的流程觸發字 → 顯示那個流程第一句，session 不動、不花 AI', r.replies[0] === '這是常見問題的第一句' && r.calls.length === 0, r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: {}, msg: '入住2/30退房2/31 12人', ai: '{"intent":"provide_info","slots":{"checkin":"2/30","checkout":"2/31","headcount":"12"}}' });
  t('收集中｜AI 抽到不合法日期 → 回格式錯誤', /格式錯誤/.test(r.replies[0] || '') && /入住日期/.test(r.replies[0] || ''), r.replies);

  r = await turn({ mode: 'ai', twoSteps: true, phase: 'in_flow', collected: {}, msg: '2/2到2/4 12人 四人房3間', ai: '{"intent":"provide_info","slots":{"checkin":"2027-02-02","checkout":"2027-02-04","headcount":"12","r4":"3"}}' });
  t('收集中｜兩步驟流程：三要素齊但第 2 步（備註）整組沒答且沒問過 → 先問第 2 步，不試算', r.replies[0] === '有什麼備註嗎？' && !called(r, 'finishBookingFlow') && r.session?.stepIndex === 1, r);

  r = await turn({ mode: 'ai', twoSteps: true, phase: 'in_flow', collected: four, stepIndex: 1, msg: '無', ai: '{"intent":"provide_info","slots":{"notes":"無"}}' });
  t('收集中｜第 2 步答了「無」→ 試算，備註=無', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).notes === '無', r.calls);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: four, msg: '不訂了', ai: '{"intent":"decline","slots":{}}' });
  t('收集中｜「不訂了」→ 取消 inquiring 訂單、清 session', r.booking.status === 'cancelled' && r.session === null && /先不訂房/.test(r.replies[0] || ''), r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: four, msg: '好', ai: '{"intent":"confirm","slots":{}}' });
  t('收集中｜AI 誤判「好」為 confirm → 降級 unclear → 三要素齊、選填不強求 → 試算（絕不成立訂單）', !called(r, 'confirmQuote') && called(r, 'finishBookingFlow'), r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: { checkin: '2027-02-02' }, msg: '好', ai: '{"intent":"confirm","slots":{}}' });
  t('收集中｜三要素未齊、AI 誤判「好」為 confirm → 降級 → 再問缺的（退房、人數）', !called(r, 'confirmQuote') && !called(r, 'finishBookingFlow') && /退房日期/.test(r.replies[0] || ''), r);

  // ===== 待確認 =====
  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '是' });
  t('待確認｜「是」→ confirmQuote，不花 AI', called(r, 'confirmQuote'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '好的' });
  t('待確認｜「好的」→ confirmQuote', called(r, 'confirmQuote'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '否' });
  t('待確認｜「否」→ declineQuote', called(r, 'declineQuote'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '有早餐嗎', ai: '{"intent":"question","slots":{}}' });
  t('待確認｜「有早餐嗎」→ AI 問答 + 提醒「是／否／修改」', r.handled === false && /報價確認：回「是」/.test(r.reminder || ''), r);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '好啊但我想改成10/10', ai: '{"intent":"modify","slots":{"checkin":"2026-10-10","checkout":"2026-10-12"}}' });
  t('待確認｜「好啊但改成10/10」AI 判 modify → 重新報價，帶新日期', called(r, 'requoteWithCollected') && arg(r, 'requoteWithCollected', 7).checkin === '2026-10-10' && !called(r, 'confirmQuote'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '改成3個人', ai: '{"intent":"modify","slots":{"headcount":"3"}}' });
  t('待確認｜「改成3個人」→ 重新報價，人數=3、其他欄位保留', called(r, 'requoteWithCollected') && arg(r, 'requoteWithCollected', 7).headcount === '3' && arg(r, 'requoteWithCollected', 7).checkin === '2027-02-02', r.calls);

  r = await turn({ mode: 'system', phase: 'awaiting_confirmation', collected: four, msg: '好啊但我想改成10/10' });
  t('待確認｜system 模式「好啊但改成10/10」→ 交真人（回覆＋通知客服）', /專人為您確認/.test(r.replies[0] || '') && r.pushes.some((p) => /人工判斷/.test(p)) && !called(r, 'confirmQuote'), r);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '我要訂房' });
  t('待確認｜「我要訂房」→ restartQuoteFlow（不是 startBookingFlow，避免重複開單）', called(r, 'restartQuoteFlow') && !called(r, 'startBookingFlow'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '已匯款', ai: '{"intent":"payment_report","slots":{}}' });
  t('待確認｜還沒成立就說已匯款 → 降級 unclear → 交真人', /專人為您確認/.test(r.replies[0] || ''), r.replies);

  // ===== 待匯款 =====
  r = await turn({ mode: 'ai', phase: 'awaiting_remittance', collected: four, msg: '12345', ai: '{"intent":"payment_report","slots":{}}' });
  t('待匯款｜「12345」→ handleRemittanceReport', called(r, 'handleRemittanceReport'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_remittance', collected: four, msg: '有早餐嗎', ai: '{"intent":"question","slots":{}}' });
  t('待匯款｜「有早餐嗎」→ AI 問答 + 提醒末五碼', r.handled === false && /末五碼/.test(r.reminder || ''), r);

  r = await turn({ mode: 'ai', phase: 'awaiting_remittance', collected: four, msg: '嗨', ai: '{"intent":"unclear","slots":{}}' });
  t('待匯款｜意圖不明 → 保守當匯款回報', called(r, 'handleRemittanceReport'), r.calls);

  r = await turn({ mode: 'ai', phase: 'awaiting_remittance', collected: four, msg: '我不訂了', ai: '{"intent":"decline","slots":{}}' });
  t('待匯款｜「不訂了」→ 不自動取消、通知客服', r.booking.status !== 'cancelled' && r.pushes.some((p) => /要求取消/.test(p)), r);

  r = await turn({ mode: 'ai', phase: 'awaiting_remittance', collected: four, msg: '[圖片]', isImage: true });
  t('待匯款｜圖片 → 當匯款憑證', called(r, 'handleRemittanceReport') && arg(r, 'handleRemittanceReport', 7) === true, r.calls);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: four, msg: '[圖片]', isImage: true });
  t('收集中｜圖片 → 通知客服、session 不動', r.pushes.some((p) => /收到圖片/.test(p)) && !called(r, 'handleRemittanceReport'), r);

  // ===== AI 失敗退回規則 =====
  r = await turn({ mode: 'ai', phase: 'awaiting_confirmation', collected: four, msg: '有早餐嗎', ai: async () => { throw new Error('401 bad key'); } });
  t('AI 掛掉｜「有早餐嗎」→ 規則判 question → AI 問答；並通知客服 AI 失敗', r.handled === false && r.pushes.some((p) => /AI 呼叫失敗/.test(p)), r);

  r = await turn({ mode: 'ai', phase: 'in_flow', collected: {}, msg: filled, ai: '這不是 JSON' });
  t('AI 回非 JSON｜貼範本 → 規則抓到 4 欄 → 試算', called(r, 'finishBookingFlow') && Object.keys(arg(r, 'finishBookingFlow', 6)).length === 4, r.calls);

  // ===== 已答過的欄位不被無標籤猜測覆蓋（規則路徑） =====
  r = await turn({ mode: 'system', phase: 'in_flow', collected: { ...four, notes: 'x' }, msg: '1' });
  t('規則｜只剩雙人房、回「1」→ r2=1、人數仍 12 → 試算', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).r2 === '1' && arg(r, 'finishBookingFlow', 6).headcount === '12', r.calls);

  // ===== 沒有 session、直接打字訂房（冷啟動） =====
  const cold = async (msg: string, mode: 'ai' | 'system' = 'system') => {
    calls.length = 0; __sent.length = 0;
    __reset({
      booking_flows: [{ id: 'flow1', name: 'AI報價', is_active: true, display_order: 1, flow_type: 'quote', reply_mode: mode, trigger_rules: [{ keyword: '我要訂房', match: 'contains' }] }],
      booking_flow_steps: [{ id: 's1', flow_id: 'flow1', step_order: 1, message_template: '請提供日期人數房數', fields: [...fields, notesField] }],
      user_states: [{ channel_id: 'ch1', line_user_id: 'U1', booking_session: null }],
      bookings: [], conversations: [], message_variables: [],
    });
    setActiveChannelId('ch1');
    let handled: boolean | undefined;
    await runTurn(async () => {
      const flows = [mkFlow(mode)];
      handled = await __quoteFlowTesting.tryStartQuoteFromCompleteInfo(new Client({}), { replyToken: 'tok' }, settings, 'U1', '客人', msg, flows as any);
    });
    await flushPendingWrites();
    const session = (() => { try { return JSON.parse(__db.user_states[0].booking_session); } catch { return null; } })();
    return { handled, calls, replies: __sent.filter((s) => s.kind === 'reply').map((s) => s.text), session, bookings: __db.bookings };
  };

  r = await cold('我想訂 2/2 到 2/4，12個人');
  t('冷啟動｜三要素齊 → 直接試算、開單', r.handled === true && called(r, 'finishBookingFlow') && r.bookings.length === 1, r);

  r = await cold('我想訂 2/2 到 2/4');
  t('冷啟動｜兩個日期、沒人數 → 開流程預填日期、只問人數', r.handled === true && !called(r, 'finishBookingFlow') && /人數/.test(r.replies[0] || '') && !/入住/.test(r.replies[0] || '') && r.session?.collected?.checkin === '2027-02-02' && r.bookings.length === 1, r);

  r = await cold('2/2 12個人');
  t('冷啟動｜日期＋人數 → 開流程、只問退房', r.handled === true && /退房日期/.test(r.replies[0] || '') && !/人數/.test(r.replies[0] || ''), r);

  // 截圖裡的真實案例：「你好，我想安排明年3月3號大約8人」→ 問退房 →「住一晚」→ 應該直接試算（沒指定房型＝自動配房）
  r = await cold('你好，我想安排明年3月3號大約8人');
  t('冷啟動｜「明年3月3號大約8人」→ 抓到入住＋人數、只問退房日期', r.handled === true && /退房日期/.test(r.replies[0] || '') && r.session?.collected?.headcount === '8' && /^[0-9]{4}-03-03$/.test(r.session?.collected?.checkin || ''), r);
  const checkinIso = r.session?.collected?.checkin;
  r = await turn({ mode: 'system', phase: 'in_flow', collected: { checkin: checkinIso, headcount: '8' }, msg: '住一晚' });
  t('接著回「住一晚」→ 退房＝入住＋1、三要素齊 → 試算（不要求房數）', called(r, 'finishBookingFlow') && arg(r, 'finishBookingFlow', 6).checkout === addDaysIso(checkinIso, 1), r);

  r = await cold('2/2 有房嗎');
  t('冷啟動｜只有一個日期 → 不開流程（交給 AI 問答）', r.handled === false && r.bookings.length === 0, r);

  r = await cold('你好');
  t('冷啟動｜閒聊 → 不開流程', r.handled === false, r);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d.slice(0, 400)}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });

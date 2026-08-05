import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { computeMultiNightQuote } from '../../src/lib/bookingEngine';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function logConversation(userId: string, nickname: string | null, direction: 'inbound' | 'outbound', content: string, source: string) {
  try {
    await supabase.from('conversations').insert({ line_user_id: userId, nickname, direction, content, source });
  } catch (e) {
    console.error('[Log] Failed to insert conversation:', e);
  }
}

function parseCsvKeywords(raw: string | null | undefined): string[] {
  return (raw || '')
    .replace(/，/g, ',')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function matchKeyword(userMessage: string, keywords: string[]): string | undefined {
  return keywords.find((k) => (k.length === 1 ? userMessage === k : userMessage.includes(k)));
}

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').single();
  if (settingsError || !settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const lineClient = new Client({
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  });

  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', settings.line_channel_secret, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const events: WebhookEvent[] = JSON.parse(event.body || '').events;

  for (const lineEvent of events) {
    if (lineEvent.type === 'message' && lineEvent.message.type === 'text') {
      const userId = lineEvent.source.userId!;
      const userMessage = (lineEvent.message.text || '').trim();
      const eventId = (lineEvent as any).webhookEventId;

      if (!userMessage || !eventId) continue;

      // 1. 強制去重 (關鍵防禦)
      const { error: eventError } = await supabase
        .from('processed_events')
        .insert({ event_id: eventId });

      if (eventError) {
        console.log(`[Dedupe] Skipping already processed event: ${eventId}`);
        continue;
      }

      // 2. 獲取當前狀態
      const { data: userState } = await supabase.from('user_states').select('*').eq('line_user_id', userId).single();
      let nickname = userState?.nickname || null;

      await logConversation(userId, nickname, 'inbound', userMessage, 'user');

      // 3. 關鍵字偵測 (轉真人客服)
      const handoverKeywords = parseCsvKeywords(settings.handover_keywords);
      const matchedKeyword = matchKeyword(userMessage, handoverKeywords);

      if (matchedKeyword) {
        console.log(`[Handover] Triggered by keyword: ${matchedKeyword}`);
        try { const p = await lineClient.getProfile(userId); nickname = p.displayName; } catch (e) {}

        const startedAt = new Date().toISOString();

        await supabase.from('user_states').upsert({
          line_user_id: userId,
          nickname,
          is_human_mode: true,
          last_human_interaction: startedAt
        });

        await supabase.from('handover_logs').insert({
          line_user_id: userId,
          nickname,
          triggered_keyword: matchedKeyword,
          started_at: startedAt,
          status: 'open',
        });

        const replyText = '已為您轉接真人客服，請稍候。';
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
        await logConversation(userId, nickname, 'outbound', replyText, 'system');

        const agentIds = settings.agent_user_ids?.split(',').map((id: string) => id.trim()).filter(Boolean);
        if (agentIds) {
          for (const id of agentIds) {
            try { await lineClient.pushMessage(id, { type: 'text', text: `🔔 真人通知：【${nickname}】正在呼叫專人。\n觸發字：${matchedKeyword}\n原文：${userMessage}` }); } catch (e) {}
          }
        }
        continue;
      }

      // 4. 真人模式判斷
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
        if (new Date().getTime() - lastInteraction < timeoutMs) continue;

        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
        await supabase
          .from('handover_logs')
          .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: 'timeout_auto' })
          .eq('line_user_id', userId)
          .eq('status', 'open');
      }

      // 4.5 動態訂房流程：管理員在「訂房流程設定」自訂的多步驟對話（最多 5 步，每步最多擷取 3 個答案）。
      if (settings.is_ai_enabled) {
        const existingSession = loadBookingSession(userState);
        const activeFlows = await fetchActiveFlows();
        const matchedFlow = activeFlows.find((f) => matchKeyword(userMessage, parseCsvKeywords(f.triggerKeywords)));

        if (matchedFlow) {
          try {
            await startBookingFlow(lineClient, lineEvent, settings, userId, nickname, matchedFlow, existingSession);
          } catch (e: any) {
            console.error('[Booking] start flow failed:', e.message);
          }
          continue;
        }
        if (existingSession) {
          try {
            await continueBookingFlow(lineClient, lineEvent, settings, userId, nickname, userMessage, existingSession);
          } catch (e: any) {
            console.error('[Booking] continue flow failed:', e.message);
          }
          continue;
        }
      }

      // 5. 呼叫 AI
      if (!settings.is_ai_enabled) continue;

      const { data: kbItemsData } = await supabase.from('knowledge_base_items').select('*').eq('is_active', true);
      const kbItems = kbItemsData || [];

      let aiResult = '';
      try {
        if (settings.active_ai === 'gpt') aiResult = (await callGPT(settings, userMessage, kbItems)).text;
        else aiResult = await callGemini(settings, userMessage, kbItems);
      } catch (e: any) {
        aiResult = `❌ AI 錯誤：\n${e.message}`;
      }

      if (aiResult) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult });
        await logConversation(userId, nickname, 'outbound', aiResult, settings.active_ai === 'gpt' ? 'ai_gpt' : 'ai_gemini');
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

// ========================================================================
// 動態訂房流程
// 設計原則：日期判斷、晚數計算、金額計算全部交給 computeMultiNightQuote()（純程式碼），
// AI 只負責①依每個步驟定義的欄位擷取顧客回答、②把算好的報價結果包裝成罐頭訊息，絕不讓 AI 自己算晚數或金額。
// 訂房紀錄以 Supabase `bookings` 表為主要來源，Google「報價」試算表只是盡力鏡射的備份，寫入失敗不影響主流程。
// ========================================================================

const BOOKING_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分鐘沒有新回覆，視為放棄這次詢問
const BOOKING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface FlowFieldDef {
  key: string;
  label: string;
  quote_field: 'checkin_date' | 'checkout_date' | 'headcount' | 'whole_house' | null;
}
interface FlowStepDef {
  step_order: number;
  message_template: string;
  fields: FlowFieldDef[];
}
interface FlowDef {
  id: string;
  name: string;
  triggerKeywords: string;
  steps: FlowStepDef[];
}

interface BookingQuoteInfo {
  total: number;
  useWholeHouse: boolean;
  roomNights: { date: string; roomTypeIds: string[] }[]; // 只有個別租房才會有內容，供確認訂房時的衝突檢查/寫入用
}

interface BookingSession {
  flowId: string;
  stepIndex: number; // 目前等待回答的步驟（0-based）；awaiting_confirmation 階段不再使用
  collected: Record<string, string>;
  bookingId: string;
  phase: 'in_flow' | 'awaiting_confirmation';
  quote: BookingQuoteInfo | null;
  updatedAt: number;
}

function loadBookingSession(userState: any): BookingSession | null {
  if (!userState?.booking_session) return null;
  try {
    const parsed = JSON.parse(userState.booking_session);
    if (!parsed || Date.now() - parsed.updatedAt > BOOKING_SESSION_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveBookingSession(userId: string, session: Omit<BookingSession, 'updatedAt'>) {
  try {
    await supabase.from('user_states').upsert({ line_user_id: userId, booking_session: JSON.stringify({ ...session, updatedAt: Date.now() }) });
  } catch (e: any) {
    console.error('[Booking] save session failed:', e.message);
  }
}

async function clearBookingSession(userId: string) {
  try {
    await supabase.from('user_states').update({ booking_session: null }).eq('line_user_id', userId);
  } catch (e: any) {
    console.error('[Booking] clear session failed:', e.message);
  }
}

async function fetchActiveFlows(): Promise<FlowDef[]> {
  const { data: flows } = await supabase.from('booking_flows').select('*').eq('is_active', true).order('display_order');
  if (!flows || !flows.length) return [];
  const { data: steps } = await supabase.from('booking_flow_steps').select('*').in('flow_id', flows.map((f: any) => f.id)).order('step_order');
  return flows.map((f: any) => ({
    id: f.id,
    name: f.name,
    triggerKeywords: f.trigger_keywords,
    steps: (steps || []).filter((s: any) => s.flow_id === f.id).map((s: any) => ({ step_order: s.step_order, message_template: s.message_template, fields: s.fields || [] })),
  }));
}

async function fetchFlowById(flowId: string): Promise<FlowDef | null> {
  const { data: flow } = await supabase.from('booking_flows').select('*').eq('id', flowId).single();
  if (!flow) return null;
  const { data: steps } = await supabase.from('booking_flow_steps').select('*').eq('flow_id', flowId).order('step_order');
  return {
    id: flow.id,
    name: flow.name,
    triggerKeywords: flow.trigger_keywords,
    steps: (steps || []).map((s: any) => ({ step_order: s.step_order, message_template: s.message_template, fields: s.fields || [] })),
  };
}

function buildStepExtractionPrompt(todayIso: string, fields: FlowFieldDef[]): string {
  const fieldLines = fields
    .map((f) => {
      let hint = '字串，照顧客原話擷取，沒提到就是 null。';
      if (f.quote_field === 'checkin_date' || f.quote_field === 'checkout_date') {
        hint = '轉換成 YYYY-MM-DD。若使用者只寫月/日（如「7/30」），用今天日期推算最合理的年份：日期還沒過就用今年，已經過了就用明年。沒提到就是 null。';
      } else if (f.quote_field === 'headcount') {
        hint = '純數字，沒提到就是 null。';
      } else if (f.quote_field === 'whole_house') {
        hint = 'true/false，從「是」「否」或包棟／不包棟等文字判斷，沒提到就是 null。';
      }
      return `- ${f.key}（${f.label}）：${hint}`;
    })
    .join('\n');
  return (
    `你是專門負責「訂房資訊擷取」的助手，這個步驟不需要回答問題、不需要計算晚數或金額，只需要從對話中擷取欄位。\n` +
    `今天的日期是 ${todayIso}。\n\n` +
    `需要擷取的欄位（JSON 格式，key 請完全照下面列出的英數代碼）：\n${fieldLines}\n\n` +
    `規則：\n` +
    `1. 只回傳一個 JSON 物件，包含以上欄位，不要加任何其他文字、不要用 markdown code block。\n` +
    `2. 從對話中能確定的欄位才填值，不確定或沒提到的欄位填 null，絕對不要自己猜測。`
  );
}

function coerceStepFieldValue(field: FlowFieldDef, value: unknown): string | undefined {
  if (field.quote_field === 'checkin_date' || field.quote_field === 'checkout_date') {
    return typeof value === 'string' && BOOKING_DATE_RE.test(value) ? value : undefined;
  }
  if (field.quote_field === 'headcount') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : undefined;
  }
  if (field.quote_field === 'whole_house') {
    if (typeof value === 'boolean') return String(value);
    if (value === 'true' || value === 'false') return value;
    return undefined;
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseStepExtraction(raw: string, fields: FlowFieldDef[]): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned);
    for (const f of fields) {
      const v = parsed[f.key];
      if (v === undefined || v === null) continue;
      const coerced = coerceStepFieldValue(f, v);
      if (coerced !== undefined) result[f.key] = coerced;
    }
  } catch {
    // 解析失敗就不更新任何欄位，維持原本已知值
  }
  return result;
}

async function extractStepFields(settings: any, userMessage: string, fields: FlowFieldDef[]): Promise<Record<string, string>> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const prompt = buildStepExtractionPrompt(todayIso, fields);
  let raw = '';
  if (settings.active_ai === 'gpt') {
    raw = (await callGPT(settings, userMessage, [], prompt)).text;
  } else {
    raw = await callGemini(settings, userMessage, [], prompt);
  }
  return parseStepExtraction(raw, fields);
}

function pickByLabelHeuristic(collected: Record<string, string>, allFields: FlowFieldDef[], keywords: string[]): string | null {
  const field = allFields.find((f) => keywords.some((k) => f.label.includes(k)));
  return field ? collected[field.key] ?? null : null;
}

async function fetchBookingData() {
  const [rt, rp, rep, wp, wpp, epr, dr, promo] = await Promise.all([
    supabase.from('room_types').select('*'),
    supabase.from('room_pricing').select('*'),
    supabase.from('room_extra_person_pricing').select('*'),
    supabase.from('whole_house_packages').select('*'),
    supabase.from('whole_house_package_pricing').select('*'),
    supabase.from('whole_house_extra_person_rules').select('*'),
    supabase.from('booking_date_ranges').select('*'),
    supabase.from('promotions').select('*'),
  ]);
  return {
    roomTypes: rt.data || [],
    roomPricing: rp.data || [],
    roomExtraPersonPricing: rep.data || [],
    packages: wp.data || [],
    packagePricing: wpp.data || [],
    extraPersonRules: epr.data || [],
    dateRanges: (dr.data || []).map((d: any) => ({ range_type: d.range_type, start_date: d.start_date, end_date: d.end_date })),
    promotions: promo.data || [],
  };
}

function formatAdultsKids(adults: number | null, kids: number | null, infants: number | null): string {
  const a = adults ?? 0;
  const k = kids ?? 0;
  const i = infants ?? 0;
  return `${a}大${k}小${i > 0 ? `${i}幼` : ''}`;
}

// 匯款截止時間：現在（台灣時間）18:00 前 → 今天 21:00；18:00（含）以後 → 明天 21:00。
function computePaymentDeadline(): string {
  const taiwanMs = Date.now() + 8 * 60 * 60 * 1000;
  const taiwanNow = new Date(taiwanMs);
  const deadlineMs = taiwanNow.getUTCHours() >= 18 ? taiwanMs + 24 * 60 * 60 * 1000 : taiwanMs;
  const deadline = new Date(deadlineMs);
  const y = deadline.getUTCFullYear();
  const m = String(deadline.getUTCMonth() + 1).padStart(2, '0');
  const d = String(deadline.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${d} 21:00`;
}

function toTaiwanSlashFromIso(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.split(`[${key}]`).join(value);
  }
  return result;
}

function toSlashDate(isoDate: string | null | undefined): string {
  return (isoDate || '').replace(/-/g, '/');
}

function bookingStatusLabel(status: string): string {
  switch (status) {
    case 'inquiring': return '詢問中';
    case 'pending_confirmation': return '待確認';
    case 'confirmed': return '已確認';
    case 'cancelled': return '已取消';
    case 'pending_manual_conflict': return '待人工確認（檔期衝突）';
    default: return status;
  }
}

// 鏡射寫入 Google「報價」試算表（盡力而為，失敗不影響資料庫端的訂房流程）
async function mirrorBookingToSheet(settings: any, booking: any) {
  if (!settings.quote_sheet_id) return;
  try {
    const fields: Record<string, string> = {
      LINE_USER_ID: booking.line_user_id,
      LINE_NAME: booking.nickname || '',
      訂房姓名: booking.name || '',
      入住日期: toSlashDate(booking.checkin_date),
      退房日期: toSlashDate(booking.checkout_date),
      入住天數: booking.nights != null ? String(booking.nights) : '',
      人數: booking.headcount != null ? String(booking.headcount) : '',
      大人小孩: formatAdultsKids(booking.adults, booking.kids, booking.infants),
      是否包棟: booking.whole_house == null ? '' : booking.whole_house ? '是' : '否',
      總金額: booking.total_amount != null ? String(booking.total_amount) : '',
      預定日期: toTaiwanSlashFromIso(booking.reserved_at),
      狀態: bookingStatusLabel(booking.status),
    };
    let rowNumber: number | null = booking.sheet_row_number ?? null;
    if (!rowNumber) rowNumber = await findOpenQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', booking.line_user_id);
    if (rowNumber) {
      await mergeUpdateQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', rowNumber, fields);
    } else {
      rowNumber = await appendQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', fields);
    }
    if (rowNumber && rowNumber !== booking.sheet_row_number) {
      await supabase.from('bookings').update({ sheet_row_number: rowNumber }).eq('id', booking.id);
    }
  } catch (e: any) {
    console.error('[Booking] mirror to sheet failed:', e.message);
  }
}

// 不同顧客訂到同一天/同房型（或跟包棟）衝突檢查，只比對狀態＝已確認的訂單。
async function checkBookingConflict(
  target: { checkin_date: string; checkout_date: string; whole_house: boolean; roomTypeIdsByNight: Map<string, string[]> },
  excludeBookingId: string
): Promise<boolean> {
  const { data: overlapping } = await supabase
    .from('bookings')
    .select('id, whole_house')
    .eq('status', 'confirmed')
    .neq('id', excludeBookingId)
    .lt('checkin_date', target.checkout_date)
    .gt('checkout_date', target.checkin_date);

  if (!overlapping || !overlapping.length) return false;

  if (target.whole_house) return true; // 新訂單是包棟：跟任何一筆日期重疊的已確認訂單都算衝突
  if (overlapping.some((b: any) => b.whole_house)) return true; // 已有包棟訂單佔用同一時段

  const individualIds = overlapping.filter((b: any) => !b.whole_house).map((b: any) => b.id);
  if (!individualIds.length) return false;

  const { data: existingRoomNights } = await supabase
    .from('booking_room_nights')
    .select('night_date, room_type_id')
    .in('booking_id', individualIds);

  for (const [night, roomTypeIds] of target.roomTypeIdsByNight) {
    for (const roomTypeId of roomTypeIds) {
      if ((existingRoomNights || []).some((r: any) => r.night_date === night && r.room_type_id === roomTypeId)) return true;
    }
  }
  return false;
}

async function startBookingFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  flow: FlowDef,
  existingSession: BookingSession | null
) {
  let bookingId: string | null = null;
  if (existingSession?.bookingId) {
    const { data: existingBooking } = await supabase.from('bookings').select('id, status').eq('id', existingSession.bookingId).maybeSingle();
    if (existingBooking && existingBooking.status === 'inquiring') bookingId = existingBooking.id;
  }

  let resolvedNickname = nickname;
  if (!bookingId) {
    try {
      const p = await lineClient.getProfile(userId);
      resolvedNickname = p.displayName;
    } catch {}
    const { data, error } = await supabase
      .from('bookings')
      .insert({ line_user_id: userId, nickname: resolvedNickname, flow_id: flow.id, status: 'inquiring', collected_answers: {} })
      .select()
      .single();
    if (error) throw error;
    bookingId = data.id;
    mirrorBookingToSheet(settings, data).catch(() => {});
  } else {
    await supabase.from('bookings').update({ flow_id: flow.id }).eq('id', bookingId);
  }

  const firstStep = flow.steps.find((s) => s.step_order === 1);
  if (!firstStep) return; // 流程沒有設定任何步驟，視為設定異常，不處理

  await saveBookingSession(userId, { flowId: flow.id, stepIndex: 0, collected: {}, bookingId: bookingId as string, phase: 'in_flow', quote: null });
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: firstStep.message_template });
  await logConversation(userId, resolvedNickname, 'outbound', firstStep.message_template, 'system');
}

async function continueBookingFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  session: BookingSession
) {
  if (session.phase === 'awaiting_confirmation') {
    await handleBookingConfirmation(lineClient, lineEvent, settings, userId, nickname, userMessage, session);
    return;
  }

  const flow = await fetchFlowById(session.flowId);
  if (!flow) {
    await clearBookingSession(userId);
    return;
  }
  const currentStep = flow.steps.find((s) => s.step_order === session.stepIndex + 1);
  if (!currentStep) {
    await clearBookingSession(userId);
    return;
  }

  const extracted = await extractStepFields(settings, userMessage, currentStep.fields).catch((e: any) => {
    console.error('[Booking] step extraction failed:', e.message);
    return {};
  });
  const collected = { ...session.collected, ...extracted };

  const missingFields = currentStep.fields.filter((f) => !collected[f.key]);
  if (missingFields.length > 0) {
    await saveBookingSession(userId, { ...session, collected });
    const replyText = `還需要麻煩您補充：${missingFields.map((f) => f.label).join('、')}`;
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return;
  }

  await supabase.from('bookings').update({ collected_answers: collected, updated_at: new Date().toISOString() }).eq('id', session.bookingId);

  const nextStepOrder = session.stepIndex + 2;
  const nextStep = flow.steps.find((s) => s.step_order === nextStepOrder);
  if (nextStep) {
    await saveBookingSession(userId, { ...session, stepIndex: session.stepIndex + 1, collected });
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: nextStep.message_template });
    await logConversation(userId, nickname, 'outbound', nextStep.message_template, 'system');
    return;
  }

  await finishBookingFlow(lineClient, lineEvent, settings, userId, nickname, flow, collected, session.bookingId);
}

async function finishBookingFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  flow: FlowDef,
  collected: Record<string, string>,
  bookingId: string
) {
  const allFields = flow.steps.flatMap((s) => s.fields);
  const quoteValues: Record<string, string> = {};
  for (const f of allFields) {
    if (f.quote_field && collected[f.key] !== undefined) quoteValues[f.quote_field] = collected[f.key];
  }

  const hasAllQuoteFields = ['checkin_date', 'checkout_date', 'headcount', 'whole_house'].every((k) => quoteValues[k] !== undefined);

  if (!hasAllQuoteFields) {
    const name = pickByLabelHeuristic(collected, allFields, ['姓名', '名字']) || nickname;
    const phone = pickByLabelHeuristic(collected, allFields, ['電話', '手機', '聯絡']);
    const { data: booking } = await supabase
      .from('bookings')
      .update({ collected_answers: collected, name, phone, updated_at: new Date().toISOString() })
      .eq('id', bookingId)
      .select()
      .single();
    if (booking) mirrorBookingToSheet(settings, booking).catch(() => {});

    const replyText = '感謝您提供的資訊！我們已經收到，將由客服人員盡快為您確認詳細報價，謝謝您的耐心等候 🙏';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');

    const agentIds = parseCsvKeywords(settings.agent_user_ids);
    for (const id of agentIds) {
      try {
        await lineClient.pushMessage(id, {
          type: 'text',
          text: `🔔 訂房詢問（資料不齊全，需人工報價）：【${nickname || '匿名用戶'}】\n${Object.entries(collected).map(([k, v]) => `${k}: ${v}`).join('\n')}`,
        });
      } catch {}
    }
    await clearBookingSession(userId);
    return;
  }

  const checkinIso = quoteValues.checkin_date;
  const checkoutIso = quoteValues.checkout_date;
  const headcount = Number(quoteValues.headcount);
  const useWholeHouse = quoteValues.whole_house === 'true';

  const checkinDate = new Date(`${checkinIso}T00:00:00`);
  const checkoutDate = new Date(`${checkoutIso}T00:00:00`);
  const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

  if (!Number.isFinite(nights) || nights <= 0 || !Number.isFinite(headcount) || headcount <= 0) {
    await supabase.from('bookings').update({ collected_answers: collected, updated_at: new Date().toISOString() }).eq('id', bookingId);
    const replyText = '不好意思，入住日期、退房日期或人數看起來有點對不上，麻煩您點選「真人客服」，我們會盡快為您確認。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await clearBookingSession(userId);
    return;
  }

  try {
    const data = await fetchBookingData();
    const maxOccupancy = data.packages.length ? Math.max(...data.packages.map((p: any) => p.occupancy)) : 0;
    const consecutiveStayDiscountPerNight =
      settings.consecutive_stay_default_option === 'cleaning'
        ? settings.consecutive_stay_discount_cleaning || 0
        : settings.consecutive_stay_discount_no_cleaning || 0;
    const activePromotion = settings.active_promotion_id ? data.promotions.find((p: any) => p.id === settings.active_promotion_id) || null : null;

    const result = computeMultiNightQuote({
      checkInDate: checkinDate,
      nights,
      headcount,
      dateRanges: data.dateRanges,
      roomTypes: data.roomTypes,
      roomPricing: data.roomPricing,
      roomExtraPersonPricing: data.roomExtraPersonPricing,
      packages: settings.booking_whole_house_enabled ? data.packages : [],
      packagePricing: settings.booking_whole_house_enabled ? data.packagePricing : [],
      extraPersonRules: settings.booking_whole_house_enabled ? data.extraPersonRules : [],
      maxOccupancy,
      promotion: activePromotion,
      consecutiveStayDiscountPerNight,
      peakSeasonWeekdayTier: settings.peak_season_weekday_tier || 'peak',
    });

    const chosenOption = useWholeHouse ? result.wholeHouse : result.individual;

    if (chosenOption.total == null) {
      await supabase
        .from('bookings')
        .update({ collected_answers: collected, checkin_date: checkinIso, checkout_date: checkoutIso, nights, headcount, whole_house: useWholeHouse, updated_at: new Date().toISOString() })
        .eq('id', bookingId);
      const replyText = '不好意思，這個日期／人數組合目前無法自動試算（可能是該時段未開放此方案，或超過可接待人數），麻煩您點選「真人客服」，我們會盡快為您確認房況與價格。';
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      await clearBookingSession(userId);
      return;
    }

    const total = chosenOption.total as number;
    const roomNights = !useWholeHouse
      ? result.individual.nights.map((n) => ({ date: dateToIso(n.date), roomTypeIds: (n.roomsUsed || []).map((r) => r.id) }))
      : [];

    const name = pickByLabelHeuristic(collected, allFields, ['姓名', '名字']) || nickname;
    const phone = pickByLabelHeuristic(collected, allFields, ['電話', '手機', '聯絡']);

    const { data: updatedBooking, error: updateError } = await supabase
      .from('bookings')
      .update({
        name,
        phone,
        checkin_date: checkinIso,
        checkout_date: checkoutIso,
        nights,
        headcount,
        whole_house: useWholeHouse,
        total_amount: total,
        status: 'pending_confirmation',
        collected_answers: collected,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .select()
      .single();
    if (updateError) throw updateError;

    mirrorBookingToSheet(settings, updatedBooking).catch(() => {});

    const quoteMessage = mergeTemplate(settings.booking_quote_message || '', {
      入住日期: toSlashDate(checkinIso),
      退房日期: toSlashDate(checkoutIso),
      人數: String(headcount),
      是否包棟: useWholeHouse ? '是' : '否',
      總金額: total.toLocaleString(),
    });

    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: quoteMessage });
    await logConversation(userId, nickname, 'outbound', quoteMessage, 'system');

    await saveBookingSession(userId, {
      flowId: flow.id,
      stepIndex: -1,
      collected,
      bookingId,
      phase: 'awaiting_confirmation',
      quote: { total, useWholeHouse, roomNights },
    });
  } catch (e: any) {
    console.error('[Booking] quote failed:', e.message);
    const replyText = '不好意思，剛剛試算報價時出了一點狀況，麻煩您點選「真人客服」按鈕，我們會盡快為您確認房況與價格。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await clearBookingSession(userId);
  }
}

async function handleBookingConfirmation(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  session: BookingSession
) {
  const trimmed = userMessage.trim();
  const isNo = /^(否|不要|不需要|取消|no)/i.test(trimmed);
  const isYes = !isNo && /^(是|對|確定|好|要|沒問題|ok|yes)/i.test(trimmed);

  if (!isYes && !isNo) {
    const replyText = '不好意思，麻煩回覆「是」確認訂房，或「否」取消，謝謝！';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return; // 停留在 awaiting_confirmation，不清 session
  }

  if (isNo) {
    const { data: booking } = await supabase.from('bookings').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', session.bookingId).select().single();
    if (booking) mirrorBookingToSheet(settings, booking).catch(() => {});
    const replyText = '好的，這次先不訂房沒關係！之後想重新試算歡迎再輸入訂房關鍵字，或直接點選「真人客服」讓我們協助您。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await clearBookingSession(userId);
    return;
  }

  const quote = session.quote;
  const { data: booking } = await supabase.from('bookings').select('*').eq('id', session.bookingId).single();
  if (!quote || !booking) {
    const replyText = '不好意思，剛剛的報價資訊遺失了，麻煩您重新輸入訂房關鍵字再試一次。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await clearBookingSession(userId);
    return;
  }

  const roomTypeIdsByNight = new Map<string, string[]>();
  for (const rn of quote.roomNights || []) roomTypeIdsByNight.set(rn.date, rn.roomTypeIds);

  let hasConflict = false;
  try {
    hasConflict = await checkBookingConflict(
      { checkin_date: booking.checkin_date, checkout_date: booking.checkout_date, whole_house: quote.useWholeHouse, roomTypeIdsByNight },
      booking.id
    );
  } catch (e: any) {
    console.error('[Booking] conflict check failed:', e.message);
  }

  if (hasConflict) {
    const { data: updated } = await supabase.from('bookings').update({ status: 'pending_manual_conflict', updated_at: new Date().toISOString() }).eq('id', booking.id).select().single();
    if (updated) mirrorBookingToSheet(settings, updated).catch(() => {});
    const replyText = '非常抱歉，這個日期範圍目前可能已經有其他訂單衝突，需要請真人客服為您確認實際空房狀況，我們會盡快與您聯繫，謝謝您的耐心等候 🙏';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    const agentIds = parseCsvKeywords(settings.agent_user_ids);
    for (const id of agentIds) {
      try {
        await lineClient.pushMessage(id, {
          type: 'text',
          text: `⚠️ 檔期衝突通知：【${booking.name || ''}】想確認 ${toSlashDate(booking.checkin_date)}~${toSlashDate(booking.checkout_date)} 訂房，但已有其他「已確認」訂單日期/房型重疊，請人工核實實際空房狀況並跟客人聯繫。`,
        });
      } catch {}
    }
    await clearBookingSession(userId);
    return;
  }

  const nowIso = new Date().toISOString();
  const { data: confirmed } = await supabase.from('bookings').update({ status: 'confirmed', reserved_at: nowIso, updated_at: nowIso }).eq('id', booking.id).select().single();

  if (!quote.useWholeHouse && quote.roomNights?.length) {
    const rows = quote.roomNights.flatMap((rn) => rn.roomTypeIds.map((roomTypeId) => ({ booking_id: booking.id, night_date: rn.date, room_type_id: roomTypeId })));
    if (rows.length) {
      const { error: roomNightsError } = await supabase.from('booking_room_nights').insert(rows);
      if (roomNightsError) console.error('[Booking] insert room nights failed:', roomNightsError.message);
    }
  }

  let depositNumber = NaN;
  if (confirmed) {
    mirrorBookingToSheet(settings, confirmed).catch(() => {});
    // 訂金目前只能透過鏡射的 Google 試算表手動填寫（或用公式算），這裡重新讀一次把訂金抓回來。
    if (settings.quote_sheet_id && confirmed.sheet_row_number) {
      try {
        const sheetRow = await getQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', confirmed.sheet_row_number);
        const raw = sheetRow?.['訂金'] || '';
        depositNumber = raw ? Number(raw) : NaN;
        if (Number.isFinite(depositNumber)) await supabase.from('bookings').update({ deposit: depositNumber }).eq('id', booking.id);
      } catch (e: any) {
        console.error('[Booking] read deposit from sheet failed:', e.message);
      }
    }
  }

  const confirmMessage = mergeTemplate(settings.booking_confirm_message || '', {
    姓名: booking.name || '',
    入住日期: toSlashDate(booking.checkin_date),
    退房日期: toSlashDate(booking.checkout_date),
    是否包棟: quote.useWholeHouse ? '是' : '否',
    人數: String(booking.headcount ?? ''),
    大人小孩: formatAdultsKids(booking.adults, booking.kids, booking.infants),
    總金額: quote.total.toLocaleString(),
    訂金: Number.isFinite(depositNumber) ? depositNumber.toLocaleString() : '（請洽真人客服確認金額）',
    匯款日時間: computePaymentDeadline(),
  });

  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: confirmMessage });
  await logConversation(userId, nickname, 'outbound', confirmMessage, 'system');
  await clearBookingSession(userId);
}

// ========================================================================
// 「報價」試算表讀寫（Google Sheets，鏡射備份用，服務帳號需為 Editor 權限）
// 不寫死欄位順序——一律先讀第一列（標題列）建立「欄位名稱 → 第幾欄」對照表。
// ========================================================================

let tokenCache: { token: string; expiresAt: number } | null = null;
let quoteSheetHeaderCache: { key: string; title: string; headers: string[]; fetchedAt: number } | null = null;
const QUOTE_SHEET_HEADER_CACHE_TTL_MS = 5 * 60 * 1000;

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt - 60 > nowSec) return tokenCache.token;

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !rawKey) throw new Error('尚未設定 GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY 環境變數');
  const privateKey = rawKey.replace(/\\n/g, '\n');

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(privateKey));
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error_description || result.error || 'Google 授權失敗');

  tokenCache = { token: result.access_token, expiresAt: nowSec + (result.expires_in || 3600) };
  return result.access_token;
}

async function resolveSheetTitle(sheetId: string, gid: string, accessToken: string): Promise<string> {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '讀取試算表結構失敗');
  const sheets = result.sheets || [];
  const target = sheets.find((s: any) => String(s.properties?.sheetId) === String(gid || '0'));
  return (target || sheets[0])?.properties?.title || '工作表1';
}

async function getQuoteSheetHeaders(sheetId: string, gid: string, accessToken: string): Promise<{ title: string; headers: string[] }> {
  const cacheKey = `${sheetId}:${gid}`;
  const now = Date.now();
  if (quoteSheetHeaderCache && quoteSheetHeaderCache.key === cacheKey && now - quoteSheetHeaderCache.fetchedAt < QUOTE_SHEET_HEADER_CACHE_TTL_MS) {
    return { title: quoteSheetHeaderCache.title, headers: quoteSheetHeaderCache.headers };
  }
  const title = await resolveSheetTitle(sheetId, gid, accessToken);
  const range = encodeURIComponent(`${title}!1:1`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '讀取「報價」試算表標題列失敗');
  const headers: string[] = (result.values?.[0] || []).map((h: string) => (h || '').trim());
  quoteSheetHeaderCache = { key: cacheKey, title, headers, fetchedAt: now };
  return { title, headers };
}

async function findOpenQuoteSheetRow(sheetId: string, gid: string, userId: string): Promise<number | null> {
  const accessToken = await getGoogleAccessToken();
  const { title, headers } = await getQuoteSheetHeaders(sheetId, gid, accessToken);
  const userIdx = headers.indexOf('LINE_USER_ID');
  if (userIdx === -1) return null;
  const totalIdx = headers.indexOf('總金額');
  const range = encodeURIComponent(`${title}!A2:Z`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '讀取「報價」試算表資料失敗');
  const rows: string[][] = result.values || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r[userIdx] === userId && (totalIdx === -1 || !r[totalIdx])) {
      return i + 2;
    }
  }
  return null;
}

async function appendQuoteSheetRow(sheetId: string, gid: string, rowData: Record<string, string>): Promise<number> {
  const accessToken = await getGoogleAccessToken();
  const { title, headers } = await getQuoteSheetHeaders(sheetId, gid, accessToken);
  const row = headers.map((h) => rowData[h] ?? '');
  const range = encodeURIComponent(`${title}!A:Z`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    }
  );
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '寫入「報價」試算表失敗');
  const updatedRange: string = result.updates?.updatedRange || '';
  const match = updatedRange.match(/![A-Za-z]+(\d+)/);
  const rowNumber = match ? parseInt(match[1], 10) : 0;
  if (!rowNumber) throw new Error('無法判斷新增資料所在的列號');
  return rowNumber;
}

async function getQuoteSheetRow(sheetId: string, gid: string, rowNumber: number): Promise<Record<string, string> | null> {
  const accessToken = await getGoogleAccessToken();
  const { title, headers } = await getQuoteSheetHeaders(sheetId, gid, accessToken);
  const range = encodeURIComponent(`${title}!A${rowNumber}:Z${rowNumber}`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '讀取「報價」試算表資料失敗');
  const values: string[] = result.values?.[0] || [];
  if (!values.length) return null;
  const obj: Record<string, string> = {};
  headers.forEach((h, i) => {
    obj[h] = values[i] ?? '';
  });
  return obj;
}

async function mergeUpdateQuoteSheetRow(sheetId: string, gid: string, rowNumber: number, newFields: Record<string, string>): Promise<void> {
  const accessToken = await getGoogleAccessToken();
  const { title, headers } = await getQuoteSheetHeaders(sheetId, gid, accessToken);
  const range = encodeURIComponent(`${title}!A${rowNumber}:Z${rowNumber}`);

  const readRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const readResult: any = await readRes.json();
  if (!readRes.ok || readResult.error) throw new Error(readResult.error?.message || '讀取「報價」試算表既有資料失敗');
  const existingValues: string[] = readResult.values?.[0] || [];
  const existing: Record<string, string> = {};
  headers.forEach((h, i) => {
    existing[h] = existingValues[i] ?? '';
  });

  const merged = { ...existing, ...newFields };
  const row = headers.map((h) => merged[h] ?? '');

  const writeRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  const writeResult: any = await writeRes.json();
  if (!writeRes.ok || writeResult.error) throw new Error(writeResult.error?.message || '更新「報價」試算表失敗');
}

// ========================================================================
// AI 呼叫 (GPT / Gemini)
// overrideSystemPrompt：訂房流程的欄位擷取／內部任務用，會完全取代知識庫 system prompt。
// ========================================================================

async function callGPT(settings: any, currentMessage: string, kbItems: any[], overrideSystemPrompt?: string) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');

  let systemContent: string;
  if (overrideSystemPrompt) {
    systemContent = overrideSystemPrompt;
  } else {
    const textBlock = kbItems.filter((i) => i.type === 'text' && i.content).map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
    let fileContent = '';
    for (const item of kbItems.filter((i) => i.type === 'file' && i.file_url)) {
      try {
        const r = await fetch(item.file_url);
        if (r.ok) fileContent += `\n\n【${item.title}】\n${await r.text()}`;
      } catch (e) {}
    }
    systemContent = `${settings.system_prompt}\n\n參考資料：\n${textBlock}${fileContent}`;
  }

  if (isGPT5) {
    const body: any = {
      model: settings.gpt_model_name,
      input: `System: ${systemContent}\nUser: ${currentMessage}`,
      reasoning: { effort: settings.gpt_reasoning_effort || 'none' },
      text: { verbosity: settings.gpt_verbosity || 'medium' }
    };
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.gpt_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result: any = await res.json();
    if (!res.ok || result.error) throw new Error(result.error?.message || res.statusText);
    return { text: result.output?.text || '' };
  }

  const openai = new OpenAI({ apiKey: settings.gpt_api_key });
  const messages: any[] = [{ role: 'system', content: systemContent }, { role: 'user', content: currentMessage }];
  const params: any = { model: settings.gpt_model_name, messages };
  if (settings.gpt_model_name.startsWith('o1') || settings.gpt_model_name.startsWith('o3')) {
    params.max_completion_tokens = settings.gpt_max_tokens;
  } else {
    params.max_tokens = settings.gpt_max_tokens;
    params.temperature = settings.gpt_temperature;
  }
  const completion = await openai.chat.completions.create(params);
  return { text: completion.choices[0].message.content || '' };
}

async function callGemini(settings: any, currentMessage: string, kbItems: any[], overrideSystemPrompt?: string) {
  if (overrideSystemPrompt) {
    const contents = [{ role: 'user', parts: [{ text: overrideSystemPrompt }, { text: `User: ${currentMessage}` }] }];
    return callGeminiRaw(settings, contents);
  }

  const textBlock = kbItems.filter((i) => i.type === 'text' && i.content).map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
  const userParts: any[] = [{ text: `System: ${settings.system_prompt}\nReference: ${textBlock}` }];

  for (const item of kbItems.filter((i) => i.type === 'file' && i.file_url)) {
    try {
      const r = await fetch(item.file_url);
      if (r.ok) {
        const b = await r.arrayBuffer();
        userParts.push({ inline_data: { data: Buffer.from(b).toString('base64'), mime_type: item.file_url.endsWith('.pdf') ? 'application/pdf' : 'text/plain' } });
      }
    } catch (e) {}
  }
  userParts.push({ text: `User: ${currentMessage}` });
  const contents = [{ role: 'user', parts: userParts }];
  return callGeminiRaw(settings, contents);
}

async function callGeminiRaw(settings: any, contents: any[]): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${settings.gemini_model_name}:generateContent?key=${settings.gemini_api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature: 1.0, maxOutputTokens: settings.gemini_max_tokens } })
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || 'Gemini API Error');
  return result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || '';
}

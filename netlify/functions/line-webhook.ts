import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { computeMultiNightQuote } from '../../src/lib/bookingEngine';
import {
  buildMergeFields,
  MessageVariable,
  TriggerRule,
  parseTriggerRules,
  matchTriggerRules,
  computeOrderAmounts,
} from '../../src/lib/messageVariables';
import { bookingStatusLabel, OCCUPYING_STATUSES } from '../../src/lib/bookingStatus';
import { roomLabel } from '../../src/lib/rooms';
import { generateOrderNumber } from '../../src/lib/orderNumber';
import {
  SelectableRoom, RoomCountRequest, selectRoomsByRequest, toRoomCountRequests, describeShortfall,
} from '../../src/lib/roomSelection';
import { computeUsage, normalizeChangeCount } from '../../src/lib/linenCost';

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

// 轉接規則（真人客服關鍵字）專用。訂房流程的關鍵字比對已改用 matchTriggerRules()——
// 每個關鍵字各自設定等於／相關。兩邊不要合併：這個函式一改，轉接行為就會跟著變。
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
      let avatarUrl = userState?.avatar_url || null;

      // 聯絡人紀錄：暱稱/大頭貼只在還沒抓過時才呼叫 LINE Profile API（之後都沿用快取，避免每則訊息都打 API），
      // 但每則訊息都更新 last_message_at，讓「客製訊息發送」/「客戶資料」能查到所有聊過天的人，不限於有轉真人/訂房過的。
      if (!nickname) {
        try { const p = await lineClient.getProfile(userId); nickname = p.displayName; avatarUrl = p.pictureUrl || null; } catch (e) {}
      }
      try {
        await supabase.from('user_states').upsert({
          line_user_id: userId,
          nickname,
          avatar_url: avatarUrl,
          last_message_at: new Date().toISOString(),
          // first_message_at 只在第一次見到這個 userId 時寫入一次，之後 upsert 不會再覆蓋
          ...(userState ? {} : { first_message_at: new Date().toISOString() }),
        });
      } catch (e) {
        console.error('[Contacts] Failed to upsert user_states:', e);
      }

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
        if (new Date().getTime() - lastInteraction < timeoutMs) {
          // 客人還在互動就延後計時——真人客服是直接在 LINE 官方帳號 App 裡回覆客人，這個系統
          // 看不到真人本人有沒有在處理，只能靠客人是否還在傳訊息判斷「這通還沒結束」。
          await supabase.from('user_states').update({ last_human_interaction: new Date().toISOString() }).eq('line_user_id', userId);
          continue;
        }

        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
        await supabase
          .from('handover_logs')
          .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: 'timeout_auto' })
          .eq('line_user_id', userId)
          .eq('status', 'open');
      }

      // 4.5 動態訂房流程：管理員在「訂房流程設定」自訂的多步驟對話（最多 5 步，每步最多擷取 3 個答案）。
      if (settings.is_ai_enabled) {
        const existingSession = loadBookingSession(userState, settings);
        const activeFlows = await fetchActiveFlows();
        const matchedFlow = activeFlows.find((f) => matchTriggerRules(userMessage, f.triggerRules));

        if (matchedFlow) {
          try {
            await startBookingFlow(lineClient, lineEvent, settings, userId, nickname, matchedFlow);
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
        // session 曾經存在、但已經逾時被 loadBookingSession() 判定過期（不是這位客人從沒問過）：
        // 不能悄悄把這句回覆丟給下面的 AI/知識庫，客人會覺得系統在答非所問，要明確告知重新開始。
        if (userState?.booking_session) {
          await clearBookingSession(userId);
          const replyText = '不好意思，這次詢問已逾時，請重新輸入一次，謝謝您 🙏';
          await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
          await logConversation(userId, nickname, 'outbound', replyText, 'system');
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
        // 不能把原始錯誤訊息（API 金鑰失效、額度用完…）直接回給客人，客人看了只會一頭霧水；
        // 客服也不會自動知道 AI 掛了，所以額外推播通知，不能只靠客人截圖來問才發現。
        console.error('[AI] call failed:', e.message);
        aiResult = '不好意思，目前系統忙線中，麻煩您稍後再試一次，或點選「真人客服」由專人為您服務 🙏';
        for (const id of parseCsvKeywords(settings.agent_user_ids)) {
          try {
            await lineClient.pushMessage(id, { type: 'text', text: `⚠️ AI 呼叫失敗：【${nickname || '匿名用戶'}】\n錯誤訊息：${e.message}` });
          } catch {}
        }
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

const BOOKING_SESSION_TTL_MS = 30 * 60 * 1000; // in_flow／awaiting_confirmation：30 分鐘沒有新回覆，視為放棄這次詢問
// awaiting_remittance 的存活時間要蓋過匯款截止時間（settings.payment_deadline_hours，見 computePaymentDeadline()），
// 不然設定的小時數一拉長，session 會比匯款期限還早過期。多留 24 小時當緩衝，客人晚點才回也還接得住。
const REMITTANCE_SESSION_BUFFER_MS = 24 * 60 * 60 * 1000;
const BOOKING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function bookingSessionTtlMs(phase: BookingSession['phase'], settings: any): number {
  if (phase !== 'awaiting_remittance') return BOOKING_SESSION_TTL_MS;
  const hours = Number(settings?.payment_deadline_hours) > 0 ? Number(settings.payment_deadline_hours) : 10;
  return hours * 60 * 60 * 1000 + REMITTANCE_SESSION_BUFFER_MS;
}

interface FlowFieldDef {
  key: string;
  label: string;
  quote_field: 'checkin_date' | 'checkout_date' | 'headcount' | 'whole_house' | 'room_count' | 'order_number' | null;
  // quote_field='room_count' 時代表這是「幾人房」的間數，例如 2 就是 2 人房要開幾間。
  // 這個值不影響價格（價格仍由 bookingEngine 決定），只用來決定實際開哪幾間房。
  room_capacity?: number | null;
}
interface FlowStepDef {
  step_order: number;
  message_template: string;
  fields: FlowFieldDef[];
}
interface FlowDef {
  id: string;
  name: string;
  triggerRules: TriggerRule[];
  // 'ai'＝呼叫 AI 理解顧客回覆並擷取欄位；'system'＝完全不呼叫 AI，用純程式解析（省 token）
  replyMode: 'ai' | 'system';
  // 'quote'＝走完步驟後嘗試算價、跑報價確認/付款確認（既有行為）；
  // 'collect'＝純問答/收集資訊，走完步驟直接送完成訊息結束，不碰 bookings 表；
  // 'query'＝純查詢既有訂單，只讀不寫，回覆內容依查詢結果動態變化。
  flowType: 'quote' | 'collect' | 'query';
  // 流程自己的報價／付款確認訊息。null＝這個流程還沒設定，webhook 會退回 settings 的舊值。
  quoteMessage: string | null;
  confirmMessage: string | null;
  // quote 型專用：算價欄位沒收集齊時的回覆。null＝用內建預設文字。
  incompleteMessage: string | null;
  // collect 型專用：走完步驟後的完成訊息。null＝用內建預設文字。
  completionMessage: string | null;
  // collect 型專用：完成後要不要推播通知 agent_user_ids。
  notifyAgentOnComplete: boolean;
  // query 型專用：查到／查無訂單時的回覆。null＝用內建預設文字。
  foundMessage: string | null;
  notFoundMessage: string | null;
  steps: FlowStepDef[];
}

function mapFlowRow(row: any, stepRows: any[]): FlowDef {
  return {
    id: row.id,
    name: row.name,
    triggerRules: parseTriggerRules(row.trigger_rules, row.trigger_keywords),
    replyMode: row.reply_mode === 'system' ? 'system' : 'ai',
    flowType: row.flow_type === 'collect' ? 'collect' : row.flow_type === 'query' ? 'query' : 'quote',
    quoteMessage: row.quote_message ?? null,
    confirmMessage: row.confirm_message ?? null,
    incompleteMessage: row.incomplete_message ?? null,
    completionMessage: row.completion_message ?? null,
    notifyAgentOnComplete: row.notify_agent_on_complete !== false,
    foundMessage: row.found_message ?? null,
    notFoundMessage: row.not_found_message ?? null,
    steps: stepRows.map((s: any) => ({ step_order: s.step_order, message_template: s.message_template, fields: s.fields || [] })),
  };
}

interface BookingQuoteInfo {
  total: number;
  useWholeHouse: boolean;
  roomNights: { date: string; roomTypeIds: string[] }[]; // 只有個別租房才會有內容，供確認訂房時的衝突檢查/寫入用
  roomIds: string[]; // 這張訂單開的房間（包棟也有），確認訂房時用來產生布巾用量
}

interface BookingSession {
  flowId: string;
  stepIndex: number; // 目前等待回答的步驟（0-based）；awaiting_confirmation／awaiting_remittance 階段不再使用
  collected: Record<string, string>;
  // collect 型流程完全不建立 bookings 紀錄，這裡是 null；quote 型流程一律非 null。
  // awaiting_confirmation／awaiting_remittance 這兩個階段只有 quote 型流程會進入，
  // 進到那兩個階段時 bookingId 保證非 null（collect 型走完步驟就直接結束，不會經過這兩階段）。
  bookingId: string | null;
  // in_flow：還在逐步收集資料
  // awaiting_confirmation：報價已送出，等顧客回「是」或「否」
  // awaiting_remittance：顧客已回「是」、預訂單已送出，等顧客回報匯款
  phase: 'in_flow' | 'awaiting_confirmation' | 'awaiting_remittance';
  quote: BookingQuoteInfo | null;
  updatedAt: number;
}

function loadBookingSession(userState: any, settings: any): BookingSession | null {
  if (!userState?.booking_session) return null;
  try {
    const parsed = JSON.parse(userState.booking_session);
    if (!parsed || Date.now() - parsed.updatedAt > bookingSessionTtlMs(parsed.phase, settings)) return null;
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
  return flows.map((f: any) => mapFlowRow(f, (steps || []).filter((s: any) => s.flow_id === f.id)));
}

async function fetchFlowById(flowId: string): Promise<FlowDef | null> {
  const { data: flow } = await supabase.from('booking_flows').select('*').eq('id', flowId).single();
  if (!flow) return null;
  const { data: steps } = await supabase.from('booking_flow_steps').select('*').eq('flow_id', flowId).order('step_order');
  return mapFlowRow(flow, steps || []);
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
      } else if (f.quote_field === 'room_count') {
        hint = `純數字，代表 ${f.room_capacity ?? '？'} 人房要開幾間，沒提到就是 null。`;
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
  if (field.quote_field === 'headcount' || field.quote_field === 'room_count') {
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

// ------------------------------------------------------------------------
// 系統模式（reply_mode = 'system'）的欄位擷取：完全不呼叫 AI，用純程式解析顧客回覆。
// 好處是每則訊息省下一次 LLM 呼叫；代價是只認得標準寫法，「下週五」這種相對日期讀不出來，
// 讀不出來的欄位會留空，continueBookingFlow() 就會照原本的邏輯再問一次。
// ------------------------------------------------------------------------

// 依序比對：完整年月日 → 「7月30日」→ 「7/30」。最後一組用 (?<!\d)/(?!\d) 夾住，
// 避免把 2026-07-30 的片段重複當成一個獨立日期。
const DATE_SCAN_RE = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})|(\d{1,2})\s*月\s*(\d{1,2})\s*[日號]?|(?<!\d)(\d{1,2})[-/.](\d{1,2})(?!\d)/g;

function taiwanToday(): Date {
  const tw = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate());
}

// 顧客只寫月/日時，比照 AI 版提示詞的規則推算年份：日期還沒過就用今年，已經過了就用明年。
function buildIsoDate(month: number, day: number, year?: number): string | null {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const today = taiwanToday();
  let y = year ?? today.getFullYear();
  let d = new Date(y, month - 1, day);
  if (d.getMonth() !== month - 1) return null; // 例如 2/30：JS 會自動進位到 3 月，視為無效日期
  if (year === undefined && d.getTime() < today.getTime()) {
    y += 1;
    d = new Date(y, month - 1, day);
  }
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function scanDates(message: string): string[] {
  const found: string[] = [];
  for (const m of message.matchAll(DATE_SCAN_RE)) {
    let iso: string | null = null;
    if (m[1]) iso = buildIsoDate(Number(m[2]), Number(m[3]), Number(m[1]));
    else if (m[4]) iso = buildIsoDate(Number(m[4]), Number(m[5]));
    else if (m[6]) iso = buildIsoDate(Number(m[6]), Number(m[7]));
    if (iso && !found.includes(iso)) found.push(iso);
  }
  return found;
}

function scanHeadcount(message: string): string | undefined {
  // 先把日期字樣挖掉，否則「7/30 入住」的 7 會被誤判成人數
  const withoutDates = message.replace(DATE_SCAN_RE, ' ');
  const m = withoutDates.match(/(\d{1,3})\s*(?:位|人|個人|大人)?/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? String(n) : undefined;
}

function scanWholeHouse(message: string): string | undefined {
  const trimmed = message.trim();
  // 否定要先判斷：「不包棟」裡面也含有「包棟」兩個字
  if (/不\s*(用|要|需要)?\s*(包棟|包整棟|整棟)|沒有?\s*要?\s*包棟/.test(trimmed)) return 'false';
  if (/包棟|包整棟|整棟/.test(trimmed)) return 'true';
  if (/^(否|不要|不用|不需要|不|no)/i.test(trimmed)) return 'false';
  if (/^(是|要|對|好|需要|沒問題|ok|yes)/i.test(trimmed)) return 'true';
  return undefined;
}

// 從「欄位名稱：數字」這種逐行回答裡取值，例如「2人房數：2」。
// 名稱可能含有正規表示式的特殊字元（例如括號），先逐字轉義再組 pattern。
function scanLabelledNumber(message: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = message.match(new RegExp(`${escaped}\\s*[:：]?\\s*(\\d{1,3})`));
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? String(n) : undefined;
}

function extractStepFieldsWithoutAi(userMessage: string, fields: FlowFieldDef[]): Record<string, string> {
  const result: Record<string, string> = {};
  const message = userMessage || '';

  // 同一個步驟同時問入住與退房時，一句話裡會出現兩個日期：照欄位順序配對第一個、第二個。
  const dateFields = fields.filter((f) => f.quote_field === 'checkin_date' || f.quote_field === 'checkout_date');
  if (dateFields.length > 0) {
    const dates = scanDates(message);
    dateFields.forEach((f, i) => {
      if (dates[i]) result[f.key] = dates[i];
    });
  }

  for (const f of fields) {
    if (result[f.key] !== undefined) continue;
    if (f.quote_field === 'headcount') {
      const v = scanHeadcount(message);
      if (v !== undefined) result[f.key] = v;
    } else if (f.quote_field === 'whole_house') {
      const v = scanWholeHouse(message);
      if (v !== undefined) result[f.key] = v;
    } else if (f.quote_field === 'room_count') {
      // 顧客通常照著問句逐行回答（「2人房數：2」），所以用欄位名稱當定位點抓後面的數字。
      // 抓不到就留空，continueBookingFlow() 會再問一次。
      const v = scanLabelledNumber(message, f.label);
      if (v !== undefined) result[f.key] = v;
    }
  }

  // 自由文字欄位（quote_field 為 null，例如姓名、電話）沒有 AI 可以拆句子，
  // 只有在整個步驟就問這一個欄位時才能安全地把整句話當答案；問兩個以上就留空再問一次。
  const freeTextFields = fields.filter((f) => !f.quote_field);
  if (freeTextFields.length === 1 && fields.length === 1 && message.trim()) {
    result[freeTextFields[0].key] = message.trim();
  }

  return result;
}

// ------------------------------------------------------------------------
// 流程訊息的變數替換：步驟訊息、報價確認、付款確認都會經過這裡，
// 讓管理員在「訊息變數資料維護」設定的 [變數名稱] 真的換成實際資料。
// 範本裡沒有方括號就直接原文回傳，不會多打資料庫。
// ------------------------------------------------------------------------
async function renderFlowMessage(
  template: string,
  settings: any,
  userId: string,
  nickname: string | null,
  bookingId: string | null
): Promise<string> {
  if (!template || !template.includes('[')) return template;
  try {
    const variables = await fetchMessageVariables();
    let booking: any = null;
    if (bookingId) {
      const { data } = await supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle();
      booking = data;
    }
    return mergeTemplate(
      template,
      buildMergeFields(variables, {
        booking: booking || undefined,
        customer: { nickname, line_user_id: userId },
        settings,
      })
    );
  } catch (e: any) {
    // 替換失敗不能讓整個流程卡住，退回原文（顧客會看到 [變數名稱]，但對話能繼續）
    console.error('[Booking] render message failed:', e.message);
    return template;
  }
}

function pickByLabelHeuristic(collected: Record<string, string>, allFields: FlowFieldDef[], keywords: string[]): string | null {
  const field = allFields.find((f) => keywords.some((k) => f.label.includes(k)));
  return field ? collected[field.key] ?? null : null;
}

async function fetchBookingData() {
  const [rt, rp, rep, wp, wpp, wpr, epr, dr, promo, sp] = await Promise.all([
    // 只抓「房間」類型：其他類型（例如公共空間）不能訂房，不該進到報價引擎
    supabase.from('room_types').select('*').eq('type', '房間'),
    supabase.from('room_pricing').select('*'),
    supabase.from('room_extra_person_pricing').select('*'),
    supabase.from('whole_house_packages').select('*'),
    supabase.from('whole_house_package_pricing').select('*'),
    supabase.from('whole_house_package_rooms').select('*'),
    supabase.from('whole_house_extra_person_rules').select('*'),
    supabase.from('booking_date_ranges').select('*'),
    supabase.from('promotions').select('*'),
    supabase.from('special_prices').select('*'),
  ]);
  return {
    roomTypes: rt.data || [],
    roomPricing: rp.data || [],
    roomExtraPersonPricing: rep.data || [],
    packages: wp.data || [],
    packagePricing: wpp.data || [],
    packageRooms: wpr.data || [],
    extraPersonRules: epr.data || [],
    dateRanges: (dr.data || []).map((d: any) => ({ range_type: d.range_type, start_date: d.start_date, end_date: d.end_date })),
    promotions: promo.data || [],
    specialPrices: (sp.data || []).map((s: any) => ({ start_date: s.start_date, end_date: s.end_date, occupancy: s.occupancy, price: s.price })),
  };
}

function formatAdultsKids(adults: number | null, kids: number | null, infants: number | null): string {
  const a = adults ?? 0;
  const k = kids ?? 0;
  const i = infants ?? 0;
  return `${a}大${k}小${i > 0 ? `${i}幼` : ''}`;
}

// 匯款截止時間：訂房確認當下起算 N 小時，N 是「系統設定」裡可調整的 payment_deadline_hours
// （沒設定時預設 10 小時）。回傳真實時間戳，寫進 bookings.payment_deadline_at 供「排程管理」
// 的自動取消逾期訂單使用；computePaymentDeadline() 是給訊息文字用的字串版本，
// 兩者共用同一個計算結果，不會算出不同答案。
function computePaymentDeadlineDate(settings: any): Date {
  const hours = Number(settings?.payment_deadline_hours) > 0 ? Number(settings.payment_deadline_hours) : 10;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function computePaymentDeadline(settings: any): string {
  const deadline = computePaymentDeadlineDate(settings);
  const taiwanDeadline = new Date(deadline.getTime() + 8 * 60 * 60 * 1000);
  const y = taiwanDeadline.getUTCFullYear();
  const m = String(taiwanDeadline.getUTCMonth() + 1).padStart(2, '0');
  const d = String(taiwanDeadline.getUTCDate()).padStart(2, '0');
  const hh = String(taiwanDeadline.getUTCHours()).padStart(2, '0');
  const mm = String(taiwanDeadline.getUTCMinutes()).padStart(2, '0');
  return `${y}/${m}/${d} ${hh}:${mm}`;
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

async function fetchMessageVariables(): Promise<MessageVariable[]> {
  const { data } = await supabase.from('message_variables').select('variable_name, source, field_key').order('display_order');
  return (data as MessageVariable[]) || [];
}

function toSlashDate(isoDate: string | null | undefined): string {
  return (isoDate || '').replace(/-/g, '/');
}

// 鏡射寫入 Google「報價」試算表（盡力而為，失敗不影響資料庫端的訂房流程）
async function mirrorBookingToSheet(settings: any, booking: any) {
  if (!settings.quote_sheet_id) return;
  try {
    const fields: Record<string, string> = {
      訂單編號: booking.order_number || '',
      LINE_USER_ID: booking.line_user_id,
      LINE_NAME: booking.nickname || '',
      訂房姓名: booking.name || '',
      入住日期: toSlashDate(booking.checkin_date),
      退房日期: toSlashDate(booking.checkout_date),
      入住天數: booking.nights != null ? String(booking.nights) : '',
      人數: booking.headcount != null ? String(booking.headcount) : '',
      大人小孩: formatAdultsKids(booking.adults, booking.kids, booking.infants),
      是否包棟: booking.whole_house == null ? '' : booking.whole_house ? '是' : '否',
      房型: booking.room_type_label || '',
      // 試算表沒有這些欄位標題時會自動略過（mergeUpdateQuoteSheetRow 只寫得出既有的標題），
      // 想在試算表看到就自己加一欄標題即可，不用改程式。
      房價: booking.room_amount != null ? String(booking.room_amount) : '',
      押金: booking.security_deposit != null ? String(booking.security_deposit) : '',
      訂金: booking.deposit != null ? String(booking.deposit) : '',
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

// 不同顧客訂到同一天/同房型（或跟包棟）衝突檢查，比對所有「房間已鎖定」的狀態（待預定～已確認，
// 含系統待人工確認），不只是已確認，避免同一天有兩筆都還在收訂金階段的訂單互相沒偵測到衝突。
async function checkBookingConflict(
  target: { checkin_date: string; checkout_date: string; whole_house: boolean; roomTypeIdsByNight: Map<string, string[]> },
  excludeBookingId: string
): Promise<boolean> {
  const { data: overlapping } = await supabase
    .from('bookings')
    .select('id, whole_house')
    .in('status', OCCUPYING_STATUSES)
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

// ------------------------------------------------------------------------
// 這張訂單開了哪幾間房
// 純粹決定「開哪幾間」，完全不碰價格——價格已經由 bookingEngine 算完。
// 這份紀錄有三個用途：預訂單訊息列出房型、布巾洗滌成本、房況/檔期衝突。
// ------------------------------------------------------------------------

// 同一段日期已被其他訂單佔用的房間。booking_room_nights（LINE 個別租房）跟
// booking_rooms（所有來源，含包棟與手動建單）記錄的來源不同，兩張都要看。
async function fetchOccupiedRoomIds(checkinIso: string, checkoutIso: string, excludeBookingId: string): Promise<Set<string>> {
  const occupied = new Set<string>();
  const { data: overlapping } = await supabase
    .from('bookings')
    .select('id')
    .in('status', OCCUPYING_STATUSES)
    .neq('id', excludeBookingId)
    .lt('checkin_date', checkoutIso)
    .gt('checkout_date', checkinIso);

  const ids = (overlapping || []).map((b: any) => b.id);
  if (!ids.length) return occupied;

  const [nightsRes, roomsRes] = await Promise.all([
    supabase.from('booking_room_nights').select('room_type_id').in('booking_id', ids),
    supabase.from('booking_rooms').select('room_type_id').in('booking_id', ids),
  ]);
  for (const r of nightsRes.data || []) occupied.add((r as any).room_type_id);
  for (const r of roomsRes.data || []) occupied.add((r as any).room_type_id);
  return occupied;
}

async function saveBookingRooms(bookingId: string, roomIds: string[]) {
  const { error: delError } = await supabase.from('booking_rooms').delete().eq('booking_id', bookingId);
  if (delError) {
    // booking_rooms 還沒建立（schema 未執行）時只記錄，不能讓整個訂房流程掛掉
    console.error('[Booking] clear booking_rooms failed:', delError.message);
    return;
  }
  if (!roomIds.length) return;
  const { error } = await supabase.from('booking_rooms').insert(roomIds.map((room_type_id) => ({ booking_id: bookingId, room_type_id })));
  if (error) console.error('[Booking] save booking_rooms failed:', error.message);
}

// 顧客答案裡「幾人房要開幾間」這類欄位，換算成「容量 -> 間數」，供房間分配跟包棟方案比對共用。
function deriveRequestedLayout(collected: Record<string, string>, allFields: FlowFieldDef[]): Record<number, number> {
  const countsByCapacity: Record<number, number> = {};
  for (const f of allFields) {
    if (f.quote_field !== 'room_count' || f.room_capacity == null) continue;
    const n = Number(collected[f.key]);
    if (Number.isFinite(n) && n > 0) countsByCapacity[f.room_capacity] = (countsByCapacity[f.room_capacity] || 0) + n;
  }
  return countsByCapacity;
}

async function resolveOpenedRooms(input: {
  collected: Record<string, string>;
  allFields: FlowFieldDef[];
  roomTypes: any[];
  useWholeHouse: boolean;
  engineRooms: { id: string }[];
  wholeHouseDefaultRoomIds: string[]; // 沒指定房型組合時，包棟要開的是報價當下選中方案的房間，不是全部房間
  checkinIso: string;
  checkoutIso: string;
  bookingId: string;
}): Promise<{ rooms: SelectableRoom[]; shortfall: RoomCountRequest[] }> {
  const selectable: SelectableRoom[] = (input.roomTypes || [])
    .filter((r: any) => r.is_active !== false)
    .map((r: any) => ({ id: r.id, name: r.name, capacity: r.capacity, display_order: r.display_order ?? 0, floor: r.floor ?? '' }));

  // 1. 顧客有指定「幾人房各要幾間」就照他指定的挑
  const countsByCapacity = deriveRequestedLayout(input.collected, input.allFields);
  const requests = toRoomCountRequests(countsByCapacity);
  if (requests.length) {
    const occupied = await fetchOccupiedRoomIds(input.checkinIso, input.checkoutIso, input.bookingId);
    return selectRoomsByRequest(requests, selectable, occupied);
  }

  // 2. 沒指定 + 包棟 → 開報價當下選中的那個包棟方案的房間組成（同人數現在可能有多個方案，
  //    不能再像改版前那樣直接給全部房間——方案沒包含到的房間不該一起算進這張訂單）
  if (input.useWholeHouse) {
    const byId = new Map(selectable.map((r) => [r.id, r]));
    const rooms = input.wholeHouseDefaultRoomIds.map((id) => byId.get(id)).filter((r): r is SelectableRoom => !!r);
    return { rooms, shortfall: [] };
  }

  // 3. 沒指定 + 個別租房 → 用報價引擎實際算價時用到的房型，房間與價格才會一致
  const byId = new Map(selectable.map((r) => [r.id, r]));
  const rooms = Array.from(new Set(input.engineRooms.map((r) => r.id)))
    .map((id) => byId.get(id))
    .filter((r): r is SelectableRoom => !!r);
  return { rooms, shortfall: [] };
}

// 依「布巾備品 > 房間預設組合」自動帶出這張訂單的洗滌用量與成本。
// 單價在這一刻存成快照，之後洗滌廠調價不會動到這筆歷史紀錄。
async function generateLinenUsage(bookingId: string, roomIds: string[], changeCount: number) {
  if (!roomIds.length) return;
  const [itemRes, defRes] = await Promise.all([
    supabase.from('linen_items').select('*').eq('is_active', true),
    supabase.from('room_type_linen_defaults').select('*').in('room_type_id', roomIds),
  ]);
  if (itemRes.error || defRes.error) return; // 布巾資料表還沒建立就跳過，不影響訂房

  const rows = computeUsage(roomIds, defRes.data || [], normalizeChangeCount(changeCount), itemRes.data || []);
  if (!rows.length) return;

  await supabase.from('booking_linen_usage').delete().eq('booking_id', bookingId);
  const { error } = await supabase
    .from('booking_linen_usage')
    .insert(rows.map((r) => ({ booking_id: bookingId, ...r })));
  if (error) console.error('[Linen] generate usage failed:', error.message);
}

// order_number 有 UNIQUE 限制，極低機率撞號時重試幾次即可。
async function insertNewBooking(fields: Record<string, any>): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase
      .from('bookings')
      .insert({ ...fields, order_number: generateOrderNumber() })
      .select()
      .single();
    if (!error) return data;
    if (!String(error.message || '').includes('order_number')) throw error;
  }
  throw new Error('無法產生不重複的訂單編號，請稍後再試');
}

async function startBookingFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  flow: FlowDef
) {
  // collect／query 型流程都不碰 bookings 表——不判斷接續舊訂單、不建立訂單紀錄。
  // 這條路徑走完就直接回第一步訊息，session 的 bookingId 是 null。
  if (flow.flowType === 'collect' || flow.flowType === 'query') {
    const firstStep = flow.steps.find((s) => s.step_order === 1);
    if (!firstStep) return; // 流程沒有設定任何步驟，視為設定異常，不處理
    await saveBookingSession(userId, { flowId: flow.id, stepIndex: 0, collected: {}, bookingId: null, phase: 'in_flow', quote: null });
    const firstMessage = await renderFlowMessage(firstStep.message_template, settings, userId, nickname, null);
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: firstMessage });
    await logConversation(userId, nickname, 'outbound', firstMessage, 'system');
    return;
  }

  // 用資料庫的實際訂單狀態判斷是否接續舊訂單，不能只看 session——
  // session 30 分鐘沒回覆就會過期消失，但客人的舊訂單可能還卡在
  // inquiring/quoted，這時若客人重新輸入關鍵字，
  // 只憑 session 判斷會誤判成全新訂單，產生同一位客人重複的訂單編號。
  let bookingId: string | null = null;
  const { data: latestBooking } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('line_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestBooking && (latestBooking.status === 'inquiring' || latestBooking.status === 'quoted')) {
    bookingId = latestBooking.id;
  }

  let resolvedNickname = nickname;
  if (!bookingId) {
    try {
      const p = await lineClient.getProfile(userId);
      resolvedNickname = p.displayName;
    } catch {}
    const data = await insertNewBooking({ line_user_id: userId, nickname: resolvedNickname, flow_id: flow.id, status: 'inquiring', collected_answers: {} });
    bookingId = data.id;
    mirrorBookingToSheet(settings, data).catch(() => {});
  } else {
    await supabase.from('bookings').update({ flow_id: flow.id, status: 'inquiring' }).eq('id', bookingId);
  }

  const firstStep = flow.steps.find((s) => s.step_order === 1);
  if (!firstStep) return; // 流程沒有設定任何步驟，視為設定異常，不處理

  await saveBookingSession(userId, { flowId: flow.id, stepIndex: 0, collected: {}, bookingId: bookingId as string, phase: 'in_flow', quote: null });
  const firstMessage = await renderFlowMessage(firstStep.message_template, settings, userId, resolvedNickname, bookingId);
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: firstMessage });
  await logConversation(userId, resolvedNickname, 'outbound', firstMessage, 'system');
}

// 訂房流程進行到一半時，如果流程本身或當下步驟被後台異動掉（刪除流程／改步驟順序）導致對不上，
// 不能悄悄清空 session 就不回話——客人會覺得系統掛了。比照關鍵字轉真人的完整流程處理，
// 讓真人接手，而不是讓客人已讀不回。
async function handoverBrokenFlowSession(lineClient: Client, lineEvent: any, settings: any, userId: string, nickname: string | null) {
  await clearBookingSession(userId);
  const startedAt = new Date().toISOString();
  await supabase.from('user_states').upsert({ line_user_id: userId, nickname, is_human_mode: true, last_human_interaction: startedAt });
  await supabase.from('handover_logs').insert({
    line_user_id: userId,
    nickname,
    triggered_keyword: '訂房流程設定異動中斷',
    started_at: startedAt,
    status: 'open',
  });
  const replyText = '不好意思，這個詢問需要真人為您確認，已經為您轉接真人客服，請稍候 🙏';
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
  await logConversation(userId, nickname, 'outbound', replyText, 'system');
  for (const id of parseCsvKeywords(settings.agent_user_ids)) {
    try {
      await lineClient.pushMessage(id, { type: 'text', text: `⚠️ 訂房流程設定跟客人進度對不上（可能是後台異動了流程步驟）：【${nickname || '匿名用戶'}】，已自動轉真人，請盡快接手。` });
    } catch {}
  }
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
  if (session.phase === 'awaiting_remittance') {
    await handleRemittanceReport(lineClient, lineEvent, settings, userId, nickname, userMessage, session);
    return;
  }

  const flow = await fetchFlowById(session.flowId);
  if (!flow) {
    await handoverBrokenFlowSession(lineClient, lineEvent, settings, userId, nickname);
    return;
  }
  const currentStep = flow.steps.find((s) => s.step_order === session.stepIndex + 1);
  if (!currentStep) {
    await handoverBrokenFlowSession(lineClient, lineEvent, settings, userId, nickname);
    return;
  }

  // 系統模式不呼叫 AI，直接用純程式解析顧客回覆（省 token）；AI 模式維持原本的 LLM 擷取。
  const extracted =
    flow.replyMode === 'system'
      ? extractStepFieldsWithoutAi(userMessage, currentStep.fields)
      : await extractStepFields(settings, userMessage, currentStep.fields).catch((e: any) => {
          console.error('[Booking] step extraction failed:', e.message);
          return {} as Record<string, string>;
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

  // collect 型流程沒有 bookingId 可以更新——這類流程完全不碰 bookings 表。
  if (session.bookingId) {
    await supabase.from('bookings').update({ collected_answers: collected, updated_at: new Date().toISOString() }).eq('id', session.bookingId);
  }

  const nextStepOrder = session.stepIndex + 2;
  const nextStep = flow.steps.find((s) => s.step_order === nextStepOrder);
  if (nextStep) {
    await saveBookingSession(userId, { ...session, stepIndex: session.stepIndex + 1, collected });
    const nextMessage = await renderFlowMessage(nextStep.message_template, settings, userId, nickname, session.bookingId);
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: nextMessage });
    await logConversation(userId, nickname, 'outbound', nextMessage, 'system');
    return;
  }

  if (flow.flowType === 'collect') {
    await finishCollectFlow(lineClient, lineEvent, settings, userId, nickname, flow, collected);
    return;
  }
  if (flow.flowType === 'query') {
    await finishQueryFlow(lineClient, lineEvent, settings, userId, nickname, flow, collected);
    return;
  }
  // quote 型流程走到這裡，session.bookingId 一定存在——startBookingFlow() 的 quote 分支
  // 一律先建立/接續一筆 bookings 才會進到收集步驟，不會有 quote 型流程沒有 bookingId 的情況。
  await finishBookingFlow(lineClient, lineEvent, settings, userId, nickname, flow, collected, session.bookingId!);
}

// collect 型流程的結尾：不管有沒有收集到什麼，走完最後一步就直接送完成訊息結束。
// 完全不碰 bookings 表——這類流程本來就不是訂房，硬塞進 bookings 只會在「訂單管理」
// 留下一堆沒有入住日期的空白列。要不要通知真人客服由 flow.notifyAgentOnComplete 這個
// 每個流程各自的開關決定，不是全站統一行為（「特殊需求登記」想馬上知道，
// 「入住須知查詢」通常不用驚動真人）。
async function finishCollectFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  flow: FlowDef,
  collected: Record<string, string>
) {
  const DEFAULT_COMPLETION_MESSAGE = '感謝您提供的資訊，我們已經收到了！';
  const replyText = await renderFlowMessage(flow.completionMessage || DEFAULT_COMPLETION_MESSAGE, settings, userId, nickname, null);
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
  await logConversation(userId, nickname, 'outbound', replyText, 'system');

  if (flow.notifyAgentOnComplete) {
    const allFields = flow.steps.flatMap((s) => s.fields);
    const summary = allFields.map((f) => `${f.label}: ${collected[f.key] || ''}`).join('\n') || '（這個流程沒有設定要收集的答案欄位）';
    for (const id of parseCsvKeywords(settings.agent_user_ids)) {
      try {
        await lineClient.pushMessage(id, {
          type: 'text',
          text: `📋 ${flow.name} 已完成：【${nickname || '匿名用戶'}】\n${summary}`,
        });
      } catch {}
    }
  }

  await clearBookingSession(userId);
}

// query 型流程的結尾：純查詢既有訂單，只讀不寫。用顧客提供的訂單編號去 bookings 查，
// 同時比對 line_user_id——只有訂單本人的 LINE 帳號能查到自己的訂單，避免顧客拿到
// 別人的訂單編號（親友轉發、猜號碼）就能看到別人的訂房資料。查到就用那筆訂單的實際
// 資料組回覆（沿用既有的 [狀態]/[入住日期]/[訂單總額] 等變數）；查不到就回 not_found_message。
async function finishQueryFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  flow: FlowDef,
  collected: Record<string, string>
) {
  const allFields = flow.steps.flatMap((s) => s.fields);
  const orderNumberField = allFields.find((f) => f.quote_field === 'order_number');
  const orderNumber = orderNumberField ? (collected[orderNumberField.key] || '').trim() : '';

  let booking: any = null;
  if (orderNumber) {
    const { data } = await supabase.from('bookings').select('*').eq('order_number', orderNumber).eq('line_user_id', userId).maybeSingle();
    booking = data;
  }

  const DEFAULT_FOUND_MESSAGE = '您的訂單狀態：[訂單狀態]\n入住日期：[入住日期]\n退房日期：[退房日期]\n總金額：[總金額]';
  const DEFAULT_NOT_FOUND_MESSAGE = '不好意思，查無這筆訂單資料，請確認訂單編號是否正確，或點選「真人客服」協助查詢。';

  const replyText = booking
    ? await renderFlowMessage(flow.foundMessage || DEFAULT_FOUND_MESSAGE, settings, userId, nickname, booking.id)
    : await renderFlowMessage(flow.notFoundMessage || DEFAULT_NOT_FOUND_MESSAGE, settings, userId, nickname, null);

  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
  await logConversation(userId, nickname, 'outbound', replyText, 'system');
  await clearBookingSession(userId);
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

    const DEFAULT_INCOMPLETE_MESSAGE = '感謝您提供的資訊！我們已經收到，將由客服人員盡快為您確認詳細報價，謝謝您的耐心等候 🙏';
    const replyText = await renderFlowMessage(flow.incompleteMessage || DEFAULT_INCOMPLETE_MESSAGE, settings, userId, nickname, bookingId);
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
    // 客人在「幾人房要開幾間」欄位裡指定的房型組合，包棟報價要用這個去挑對應方案，
    // 價格才會跟 resolveOpenedRooms() 實際開的房間一致。
    const requestedLayout = deriveRequestedLayout(collected, allFields);

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
      packageRooms: data.packageRooms,
      requestedLayout: Object.keys(requestedLayout).length ? requestedLayout : null,
      specialPrices: data.specialPrices,
      specialPriceStacksWithDiscounts: settings.special_price_stacks_with_discounts !== false,
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

    // 包棟且客人沒指定房型組合時，要開報價當下實際選中的那個方案的房間——用第一晚的
    // packageUsed 當代表（同一趟住宿理論上每晚應該選到同一個方案，除非中間跨到不同 tier
    // 剛好讓「升等方案」變得比較划算，這是既有邏輯本來就有的極少數情況，這裡不特別處理）。
    const wholeHousePackageId = result.wholeHouse.nights[0]?.packageUsed?.id || null;
    const wholeHouseDefaultRoomIds = wholeHousePackageId
      ? data.packageRooms.filter((pr: any) => pr.package_id === wholeHousePackageId).map((pr: any) => pr.room_type_id)
      : [];

    // 決定這張訂單實際開哪幾間房。價格已經在上面算完了，這一段不會動到金額，
    // 只負責「開哪幾間」——預訂單要列房型、布巾成本要知道間數、房況要標記佔用。
    const openedRooms = await resolveOpenedRooms({
      collected,
      allFields,
      roomTypes: data.roomTypes,
      useWholeHouse,
      engineRooms: result.individual.nights.flatMap((n) => n.roomsUsed || []),
      wholeHouseDefaultRoomIds,
      checkinIso,
      checkoutIso,
      bookingId,
    });

    // 排不出客人指定的房型組合就轉真人：默默改成別的房型，客人到現場才發現不對。
    if (openedRooms.shortfall.length) {
      await supabase.from('bookings').update({ collected_answers: collected, status: 'pending_manual_conflict', updated_at: new Date().toISOString() }).eq('id', bookingId);
      const replyText = `不好意思，您指定的房型組合目前排不出來（${describeShortfall(openedRooms.shortfall)}），已經請真人客服為您確認實際空房，我們會盡快與您聯繫 🙏`;
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      for (const id of parseCsvKeywords(settings.agent_user_ids)) {
        try {
          await lineClient.pushMessage(id, { type: 'text', text: `⚠️ 房型排不出來：【${nickname || '匿名用戶'}】${toSlashDate(checkinIso)}~${toSlashDate(checkoutIso)}，${describeShortfall(openedRooms.shortfall)}，請人工確認。` });
        } catch {}
      }
      await clearBookingSession(userId);
      return;
    }

    // 房型摘要，供訂單管理/客製訊息發送列表快速顯示，不用每次都 join。
    // 包棟也照實列出房間名稱（不再只寫「包棟」）——包棟只是使用權的名稱，
    // 客人還是想知道自己拿到哪幾間房，布巾成本也要算。
    const roomTypeLabel = openedRooms.rooms.length
      ? openedRooms.rooms.map((r) => roomLabel(r)).join('、')
      : useWholeHouse
        ? '包棟'
        : null;

    await saveBookingRooms(bookingId, openedRooms.rooms.map((r) => r.id));

    const name = pickByLabelHeuristic(collected, allFields, ['姓名', '名字']) || nickname;
    const phone = pickByLabelHeuristic(collected, allFields, ['電話', '手機', '聯絡']);

    // 報價引擎算出來的 total 是「房價」，押金與訂金在這裡一次算齊，
    // 不再等到確認訂房時去 Google 試算表撈人工填的訂金。
    // 押金依實際開的房間數調整：個別租房是這張訂單開的每間房押金加總；包棟是另外設的固定金額
    // （包棟的清潔/損壞責任是整棟的，不是把各房間押金加起來）。
    const roomDepositById = new Map(data.roomTypes.map((rt: any) => [rt.id, Number(rt.security_deposit ?? 0)]));
    const securityDeposit = useWholeHouse
      ? Number(settings.whole_house_security_deposit ?? 0)
      : openedRooms.rooms.reduce((sum, r) => sum + (roomDepositById.get(r.id) ?? 0), 0);
    const amounts = computeOrderAmounts(total, securityDeposit, Number(settings.deposit_percent ?? 0));

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
        room_amount: amounts.room_amount,
        security_deposit: amounts.security_deposit,
        total_amount: amounts.total_amount,
        deposit: amounts.deposit,
        room_type_label: roomTypeLabel,
        status: 'quoted',
        collected_answers: collected,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .select()
      .single();
    if (updateError) throw updateError;

    mirrorBookingToSheet(settings, updatedBooking).catch(() => {});

    const quoteVariables = await fetchMessageVariables();
    // 優先用流程自己的報價確認訊息；還沒設定（例如剛升級、欄位是 NULL）就退回 settings 的舊值。
    const quoteMessage = mergeTemplate(
      flow.quoteMessage ?? settings.booking_quote_message ?? '',
      buildMergeFields(quoteVariables, {
        booking: updatedBooking,
        customer: { nickname, line_user_id: userId },
        settings,
      })
    );

    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: quoteMessage });
    await logConversation(userId, nickname, 'outbound', quoteMessage, 'system');

    await saveBookingSession(userId, {
      flowId: flow.id,
      stepIndex: -1,
      collected,
      bookingId,
      phase: 'awaiting_confirmation',
      quote: { total, useWholeHouse, roomNights, roomIds: openedRooms.rooms.map((r) => r.id) },
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
          text: `⚠️ 檔期衝突通知：【${booking.name || ''}】想確認 ${toSlashDate(booking.checkin_date)}~${toSlashDate(booking.checkout_date)} 訂房，但已有其他訂單日期/房型重疊，請人工核實實際空房狀況並跟客人聯繫。`,
        });
      } catch {}
    }
    await clearBookingSession(userId);
    return;
  }

  // 客戶口頭確認、房間鎖定、匯款資訊已送出，但實際匯款尚未核實，所以是「待預定」不是「已預定」；
  // 之後管理員核對到真的收到訂金匯款，要在「訂單管理」手動改成「已預定」並填入匯款末5碼。
  const nowIso = new Date().toISOString();
  // payment_deadline_at 存真實時間戳（跟訊息裡 [匯款日時間] 顯示的是同一個截止時間），
  // 供「排程管理」的自動取消逾期未匯款訂單使用。
  const { data: confirmed } = await supabase
    .from('bookings')
    .update({ status: 'awaiting_deposit', reserved_at: nowIso, payment_deadline_at: computePaymentDeadlineDate(settings).toISOString(), updated_at: nowIso })
    .eq('id', booking.id)
    .select()
    .single();

  if (!quote.useWholeHouse && quote.roomNights?.length) {
    const rows = quote.roomNights.flatMap((rn) => rn.roomTypeIds.map((roomTypeId) => ({ booking_id: booking.id, night_date: rn.date, room_type_id: roomTypeId })));
    if (rows.length) {
      const { error: roomNightsError } = await supabase.from('booking_room_nights').insert(rows);
      if (roomNightsError) console.error('[Booking] insert room nights failed:', roomNightsError.message);
    }
  }

  // 訂房確認的當下就把布巾洗滌成本帶出來，管理員之後在訂單管理可以再調整。
  // 包棟訂單一樣有——成本看的是開了幾間房，跟是不是包棟無關。
  // 包棟不寫 booking_room_nights（衝突檢查與行事曆靠 whole_house 旗標處理，寫了會重複佔位），
  // 但 booking_rooms 兩種都有，所以布巾成本兩種都算得出來。
  await generateLinenUsage(booking.id, quote.roomIds || [], booking.linen_change_count ?? 1);

  if (confirmed) mirrorBookingToSheet(settings, confirmed).catch(() => {});

  // 房價／押金／訂單總額／訂金在報價當下就一起算好寫進 bookings 了（見 finishBookingFlow），
  // 這裡直接沿用，不需要再去 Google 試算表撈人工填的訂金。
  const confirmVariables = await fetchMessageVariables();
  const confirmFields = buildMergeFields(confirmVariables, {
    booking: { ...booking, whole_house: quote.useWholeHouse },
    customer: { nickname, line_user_id: userId },
    settings,
  });
  // 匯款日時間是系統即時算出來的截止時間，不是任何資料表的欄位，永遠由這裡直接帶入，
  // 不受「訊息變數資料維護」頁面的設定影響（就算被刪除或改名也一樣會生效）。
  confirmFields['匯款日時間'] = computePaymentDeadline(settings);

  // 同報價確認：優先用流程自己的付款確認訊息，沒有才退回 settings 的舊值。
  const flowForConfirm = await fetchFlowById(session.flowId).catch(() => null);
  const confirmMessage = mergeTemplate(flowForConfirm?.confirmMessage ?? settings.booking_confirm_message ?? '', confirmFields);

  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: confirmMessage });
  await logConversation(userId, nickname, 'outbound', confirmMessage, 'system');

  // 訂房這條路還沒走完——顧客接下來要匯款、回報末五碼，session 留著轉成
  // awaiting_remittance，這樣他之後傳的第一句話（不管是「轉帳成功12345」還是隨便講什麼）
  // 都會被 handleRemittanceReport() 接住，而不是掉進一般 AI 回覆或被當成新的訂房流程開始。
  await saveBookingSession(userId, { ...session, phase: 'awaiting_remittance' });
}

// 顧客在 awaiting_remittance 階段傳的第一句話：能抓到末五碼就先寫進訂單，
// 不管抓不抓得到都直接轉真人——這個階段收到任何訊息，代表顧客覺得他該通知我們了
// （已經匯款、或有匯款相關的問題），交給真人核對最保險，不要再由 AI 猜測回覆。
async function handleRemittanceReport(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  session: BookingSession
) {
  const last5Match = userMessage.match(/\d{5}/); // 抓第一組連續 5 位數字當作匯款帳號後五碼
  const remit_last5 = last5Match ? last5Match[0] : null;

  const { data: booking } = await supabase
    .from('bookings')
    .update({ ...(remit_last5 ? { remit_last5 } : {}), updated_at: new Date().toISOString() })
    .eq('id', session.bookingId)
    .select()
    .single();
  if (booking) mirrorBookingToSheet(settings, booking).catch(() => {});

  const startedAt = new Date().toISOString();
  await supabase.from('user_states').upsert({ line_user_id: userId, nickname, is_human_mode: true, last_human_interaction: startedAt });
  await supabase.from('handover_logs').insert({
    line_user_id: userId,
    nickname,
    triggered_keyword: '匯款回報',
    started_at: startedAt,
    status: 'open',
  });

  const replyText = '好的請稍等，已轉接給真人確認請稍等。';
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
  await logConversation(userId, nickname, 'outbound', replyText, 'system');

  const orderNumber = booking?.order_number || '';
  const last5Text = remit_last5 ? `末五碼 ${remit_last5}` : '（訊息中沒有抓到 5 碼數字，請自行確認原文）';
  for (const id of parseCsvKeywords(settings.agent_user_ids)) {
    try {
      await lineClient.pushMessage(id, {
        type: 'text',
        text: `💰 匯款回報：【${nickname || '匿名用戶'}】訂單 ${orderNumber} 回報${last5Text}\n原文：${userMessage}\n查帳無誤後請至「訂單管理」將狀態改為已預定，或用「客製訊息發送」送出【訂房成功通知】自動改狀態。`,
      });
    } catch {}
  }

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

// 註：原本還有一個 getQuoteSheetRow()，用途是確認訂房時回試算表撈人工填的訂金。
// 訂金改成由 computeOrderAmounts() 直接算（房價 × 訂金比例），那個函式就沒有呼叫者了，一併移除。
// 試算表現在只剩「盡力鏡射寫入」這一個方向的用途。

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

// 知識庫邊界：不管管理員在「系統指令」裡怎麼寫，客服回答一律不能超出知識庫範圍——
// 沒寫的問題如果讓 AI 憑常識回答，遇到退房政策、寵物政策這類「猜錯代價很高」的問題會很危險。
// 固定寫死在這裡（不是 settings.system_prompt 的一部分），管理員改系統指令也不會不小心把這條規則改掉。
const KB_BOUNDARY_INSTRUCTION =
  '重要規則：只能根據下面「參考資料」裡的內容回答問題。參考資料沒有提到的事情，一律誠實回答「不好意思，這個問題我不清楚，建議您聯繫真人客服協助」，絕對不要用自己的知識猜測或編造答案，即使聽起來很合理也一樣。';

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
    systemContent = `${settings.system_prompt}\n\n${KB_BOUNDARY_INSTRUCTION}\n\n參考資料：\n${textBlock}${fileContent}`;
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
  const userParts: any[] = [{ text: `System: ${settings.system_prompt}\n\n${KB_BOUNDARY_INSTRUCTION}\n\nReference: ${textBlock}` }];

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

import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { computeUnifiedMultiNightQuote } from '../../src/lib/bookingEngine';
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

// 收尾寫入佇列：對話記錄、聯絡人 last_message_at 這類「沒有人在等結果」的資料庫寫入，
// 過去是 await 在回覆客人之前，等於每則訊息都讓客人多等好幾個資料庫來回。改成先丟進佇列，
// 等回覆送出後、函式結束前一次平行 flush。
// 注意：serverless 容器在 handler return 之後就被凍結，所以不能真的 fire-and-forget，
// 一定要在 return 前 await 完，否則寫入會被中途砍掉（這也是為什麼不直接用裸 promise）。
let pendingWrites: Promise<unknown>[] = [];

function deferWrite(label: string, run: () => PromiseLike<unknown>) {
  pendingWrites.push(
    Promise.resolve()
      .then(run)
      .catch((e) => console.error(`[DeferredWrite] ${label} failed:`, e))
  );
}

async function flushPendingWrites() {
  while (pendingWrites.length) {
    const queued = pendingWrites;
    pendingWrites = [];
    await Promise.allSettled(queued);
  }
}

function logConversation(userId: string, nickname: string | null, direction: 'inbound' | 'outbound', content: string, source: string) {
  deferWrite('conversations.insert', () =>
    supabase.from('conversations').insert({ line_user_id: userId, nickname, direction, content, source })
  );
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

// settings 每次 webhook 呼叫都要讀（簽章驗證、AI 開關、系統指令都在裡面），但內容改動不頻繁。
// 短 TTL 記憶體快取：後台改設定最多晚 30 秒生效，換來每則訊息少一次資料庫來回。
// 30 秒是刻意選的——包含 is_ai_enabled 這種「出事要馬上關掉」的開關，不能設太長。
const SETTINGS_CACHE_TTL_MS = 30 * 1000;
let settingsCache: { data: any; fetchedAt: number } | null = null;

async function fetchSettings(): Promise<any | null> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.fetchedAt < SETTINGS_CACHE_TTL_MS) return settingsCache.data;
  const { data, error } = await supabase.from('settings').select('*').single();
  if (error || !data) return null;
  settingsCache = { data, fetchedAt: now };
  return data;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const settings = await fetchSettings();
  if (!settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const lineClient = new Client({
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  });

  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', settings.line_channel_secret, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const events: WebhookEvent[] = JSON.parse(event.body || '').events;

  // LINE 在多位客人差不多時間傳訊息時，會把多筆事件包在同一次 webhook 呼叫的 events 陣列裡送過來。
  // 不同客人之間彼此獨立、互不相關，用 Promise.allSettled 平行處理，不要讓前面的人卡住後面的人
  // （否則排隊等到 Netlify function 逾時或 LINE replyToken 過期，後面的客人會完全收不到回覆）。
  // 但同一位客人在同一批裡出現多筆事件時，仍照原始順序依序處理——訂房流程的 session 是「讀出來改一改寫回去」，
  // 平行處理同一人的兩筆事件會互相覆蓋彼此的寫入，所以同一 userId 的事件要序列化。
  const eventsByUser = new Map<string, WebhookEvent[]>();
  events.forEach((lineEvent, idx) => {
    const key = (lineEvent as any).source?.userId || `__no-user-${idx}`;
    if (!eventsByUser.has(key)) eventsByUser.set(key, []);
    eventsByUser.get(key)!.push(lineEvent);
  });

  await Promise.allSettled(
    Array.from(eventsByUser.values()).map(async (userEvents) => {
      for (const lineEvent of userEvents) {
        await processLineEvent(lineEvent, settings, lineClient);
      }
    })
  );

  // 客人的回覆此時已經送出，這裡才把累積的收尾寫入一次做完。一定要在 return 之前，
  // 容器 return 後就凍結了（見 deferWrite 的說明）。
  await flushPendingWrites();

  return { statusCode: 200, body: 'OK' };
};

async function processLineEvent(lineEvent: WebhookEvent, settings: any, lineClient: Client): Promise<void> {
  if (!(lineEvent.type === 'message' && lineEvent.message.type === 'text')) return;

  const userId = lineEvent.source.userId!;
  const userMessage = (lineEvent.message.text || '').trim();
  const eventId = (lineEvent as any).webhookEventId;

  if (!userMessage || !eventId) return;

  try {
    // 1. 強制去重 (關鍵防禦) ＋ 2. 獲取當前狀態
    // 兩者沒有先後依賴（狀態查詢是唯讀的，就算是重複事件也只是白查一次），平行發出省一個來回。
    const [dedupeRes, userStateRes] = await Promise.all([
      supabase.from('processed_events').insert({ event_id: eventId }),
      supabase.from('user_states').select('*').eq('line_user_id', userId).single(),
    ]);

    if (dedupeRes.error) {
      console.log(`[Dedupe] Skipping already processed event: ${eventId}`);
      return;
    }

    const userState = userStateRes.data;
    let nickname = userState?.nickname || null;
    let avatarUrl = userState?.avatar_url || null;

    // 聯絡人紀錄：暱稱/大頭貼只在還沒抓過時才呼叫 LINE Profile API（之後都沿用快取，避免每則訊息都打 API），
    // 但每則訊息都更新 last_message_at，讓「客製訊息發送」/「客戶資料」能查到所有聊過天的人，不限於有轉真人/訂房過的。
    if (!nickname) {
      try { const p = await lineClient.getProfile(userId); nickname = p.displayName; avatarUrl = p.pictureUrl || null; } catch (e) {}
    }
    // 這筆 upsert 的結果沒有任何後續邏輯在等（下面用的是上面already查好的 userState），
    // 延後到回覆送出後再寫，不要卡在客人前面。
    const isFirstEverMessage = !userState;
    deferWrite('user_states.upsert', () =>
      supabase.from('user_states').upsert({
        line_user_id: userId,
        nickname,
        avatar_url: avatarUrl,
        last_message_at: new Date().toISOString(),
        // first_message_at 只在第一次見到這個 userId 時寫入一次，之後 upsert 不會再覆蓋
        ...(isFirstEverMessage ? { first_message_at: new Date().toISOString() } : {}),
      })
    );

    logConversation(userId, nickname, 'inbound', userMessage, 'user');

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
      return;
    }

    // 4. 真人模式判斷
    if (userState?.is_human_mode) {
      const lastInteraction = new Date(userState.last_human_interaction).getTime();
      const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
      if (new Date().getTime() - lastInteraction < timeoutMs) {
        // 客人還在互動就延後計時——真人客服是直接在 LINE 官方帳號 App 裡回覆客人，這個系統
        // 看不到真人本人有沒有在處理，只能靠客人是否還在傳訊息判斷「這通還沒結束」。
        await supabase.from('user_states').update({ last_human_interaction: new Date().toISOString() }).eq('line_user_id', userId);
        return;
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
        return;
      }
      if (existingSession) {
        try {
          await continueBookingFlow(lineClient, lineEvent, settings, userId, nickname, userMessage, existingSession);
        } catch (e: any) {
          console.error('[Booking] continue flow failed:', e.message);
        }
        return;
      }
      // session 曾經存在、但已經逾時被 loadBookingSession() 判定過期（不是這位客人從沒問過）：
      // 不能悄悄把這句回覆丟給下面的 AI/知識庫，客人會覺得系統在答非所問，要明確告知重新開始。
      if (userState?.booking_session) {
        await clearBookingSession(userId);
        const replyText = '不好意思，這次詢問已逾時，請重新輸入一次，謝謝您 🙏';
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
        await logConversation(userId, nickname, 'outbound', replyText, 'system');
        return;
      }
    }

    // 5. 呼叫 AI
    if (!settings.is_ai_enabled) return;

    const [{ data: kbItemsData }, conversationContext] = await Promise.all([
      supabase.from('knowledge_base_items').select('*').eq('is_active', true),
      fetchConversationContext(userId, userMessage),
    ]);
    const kbItems = kbItemsData || [];

    let aiResult = '';
    try {
      if (settings.active_ai === 'gpt') {
        aiResult = (await callGPT(settings, userMessage, kbItems, undefined, conversationContext.history, conversationContext.recentBooking)).text;
      } else {
        aiResult = await callGemini(settings, userMessage, kbItems, undefined, conversationContext.history, conversationContext.recentBooking);
      }
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
  } catch (e: any) {
    console.error(`[Event] Unhandled error processing event ${eventId}:`, e.message);
  }
}

// 一般 AI 問答（非訂房流程）本身不是多輪對話 API，每次呼叫都是獨立的——沒有這段，客人問完報價
// 後續再問其他問題，AI 完全不知道剛剛聊過什麼。這裡把最近幾筆對話紀錄（conversations 表，本來就有
// 記，只是沒被讀回來用）和這位客人最近一筆未取消的訂單/報價摘要（bookings 表）一起帶進去，
// 讓 AI 至少能接得上「剛剛的報價」「訂單狀態」這類後續問題。
const CONVERSATION_HISTORY_LIMIT = 10;

async function fetchConversationContext(userId: string, currentMessage: string): Promise<{
  history: { direction: string; content: string }[];
  recentBooking: any | null;
}> {
  const [historyRes, bookingRes] = await Promise.all([
    supabase
      .from('conversations')
      .select('direction, content')
      .eq('line_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(CONVERSATION_HISTORY_LIMIT + 1),
    supabase
      .from('bookings')
      .select('order_number, checkin_date, checkout_date, headcount, whole_house, total_amount, status, room_type_label')
      .eq('line_user_id', userId)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const rows = (historyRes.data || []).reverse();
  // 客人這句話本身的 inbound 記錄現在是延後寫入（見 deferWrite），正常情況還沒進資料庫，
  // 所以不能無條件砍掉最後一筆。但萬一時序上它已經寫進去了，尾端就會多一筆跟當下訊息一模一樣的
  // inbound——那才要拿掉，否則等於把同一句話重複塞兩次進 prompt。
  while (rows.length) {
    const last = rows[rows.length - 1];
    if (last.direction === 'inbound' && last.content === currentMessage) rows.pop();
    else break;
  }
  return { history: rows.slice(-CONVERSATION_HISTORY_LIMIT), recentBooking: bookingRes.data || null };
}

// ========================================================================
// 動態訂房流程
// 設計原則：日期判斷、晚數計算、金額計算全部交給 computeUnifiedMultiNightQuote()（純程式碼），
// AI 只負責①依每個步驟定義的欄位擷取顧客回答、②把算好的報價結果包裝成罐頭訊息，絕不讓 AI 自己算晚數或金額。
// 訂房紀錄一律以 Supabase `bookings` 表為唯一來源（原本另外鏡射一份到 Google「報價」試算表，該功能已移除）。
// ========================================================================

const BOOKING_SESSION_TTL_MS = 30 * 60 * 1000; // in_flow／awaiting_confirmation：30 分鐘沒有新回覆，視為放棄這次詢問
// awaiting_remittance 的存活時間要蓋過匯款截止時間（settings.payment_deadline_hours，見 computePaymentDeadline()），
// 不然設定的小時數一拉長，session 會比匯款期限還早過期。多留 24 小時當緩衝，客人晚點才回也還接得住。
const REMITTANCE_SESSION_BUFFER_MS = 24 * 60 * 60 * 1000;
const BOOKING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 答案欄位設成「日期」格式時，接受這些寫法（民國年可以帶分隔符也可以不帶；沒有年份就
// 直接帶入今年，不像算價欄位的 checkin/checkout 會有「已過today就推到明年」那套邏輯——
// 這裡是通用格式檢查，不是訂房日期本身，不需要那個假設）：
//   20260601／2026/06/01／2026-06-01（西元）
//   115/06/01／1150601（民國，年份 1~3 碼，換算西元 ＝ 民國年 + 1911）
//   0601／06/01（只有月日，年份帶入今年）
// 驗證失敗（月份超過 12、日期超過當月天數等）一律回傳 null，呼叫端會當作格式錯誤重新請顧客輸入。
function buildValidatedIsoDate(year: number, month: number, day: number): string | null {
  if (!(month >= 1 && month <= 12)) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null; // 例如 2/30 會被 JS 自動進位，視為無效
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeDateInput(raw: string): string | null {
  const trimmed = raw.trim();
  const todayYear = taiwanToday().getFullYear();

  // 有分隔符（/、-、.）：年/月/日 或 月/日
  const withSeparator = trimmed.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (withSeparator) {
    const [, yStr, mStr, dStr] = withSeparator;
    const year = yStr.length === 4 ? Number(yStr) : Number(yStr) + 1911; // 4 碼＝西元，1~3 碼＝民國
    return buildValidatedIsoDate(year, Number(mStr), Number(dStr));
  }
  const monthDayOnly = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})$/);
  if (monthDayOnly) {
    const [, mStr, dStr] = monthDayOnly;
    return buildValidatedIsoDate(todayYear, Number(mStr), Number(dStr));
  }

  // 純數字、無分隔符：8 碼＝西元 YYYYMMDD，7 碼＝民國 YYYMMDD，4 碼＝ MMDD（今年）
  if (/^\d{8}$/.test(trimmed)) {
    return buildValidatedIsoDate(Number(trimmed.slice(0, 4)), Number(trimmed.slice(4, 6)), Number(trimmed.slice(6, 8)));
  }
  if (/^\d{7}$/.test(trimmed)) {
    return buildValidatedIsoDate(Number(trimmed.slice(0, 3)) + 1911, Number(trimmed.slice(3, 5)), Number(trimmed.slice(5, 7)));
  }
  if (/^\d{4}$/.test(trimmed)) {
    return buildValidatedIsoDate(todayYear, Number(trimmed.slice(0, 2)), Number(trimmed.slice(2, 4)));
  }

  return null;
}

// 答案欄位的格式檢查／正規化：value_type 沒設定＝不限，只要有擷取到內容就算通過、原樣帶回。
// 'date' 會把上面接受的各種寫法統一轉成 YYYY-MM-DD 存進 collected，不是只驗證格式；
// 'number' 檢查是否為純數字；'string' 只要求非空白文字，不額外限制內容。
// 回傳 null 代表格式不符，呼叫端要當作沒收集到、請顧客重新輸入。
function normalizeFieldValue(valueType: FlowFieldDef['value_type'], raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  if (valueType === 'date') return normalizeDateInput(trimmed);
  if (valueType === 'number') return Number.isNaN(Number(trimmed)) ? null : trimmed;
  return trimmed;
}

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
  // 顧客回覆的格式限制：null/undefined＝不限（沿用既有行為）。擷取到的值不符合格式時，
  // 不會當作已收集，會回「OO格式錯誤，請重新輸入」讓顧客重打，不會進到下一步。
  value_type?: 'date' | 'number' | 'string' | null;
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
  roomNights: { date: string; roomTypeIds: string[] }[]; // 供確認訂房時的衝突檢查/寫入用
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

// 訂房流程設定改動不頻繁，但過去每一則訊息都重新查兩次 DB（booking_flows + booking_flow_steps）。
// 短 TTL 記憶體快取：同一個 Netlify function container 在 TTL 內重複用同一份結果，
// 管理員改了流程設定最多晚 30 秒生效，換來每則訊息少兩次 DB 往返。
const ACTIVE_FLOWS_CACHE_TTL_MS = 30 * 1000;
let activeFlowsCache: { data: FlowDef[]; fetchedAt: number } | null = null;

async function fetchActiveFlows(): Promise<FlowDef[]> {
  const now = Date.now();
  if (activeFlowsCache && now - activeFlowsCache.fetchedAt < ACTIVE_FLOWS_CACHE_TTL_MS) {
    return activeFlowsCache.data;
  }
  const { data: flows } = await supabase.from('booking_flows').select('*').eq('is_active', true).order('display_order');
  if (!flows || !flows.length) {
    activeFlowsCache = { data: [], fetchedAt: now };
    return [];
  }
  const { data: steps } = await supabase.from('booking_flow_steps').select('*').in('flow_id', flows.map((f: any) => f.id)).order('step_order');
  const result = flows.map((f: any) => mapFlowRow(f, (steps || []).filter((s: any) => s.flow_id === f.id)));
  activeFlowsCache = { data: result, fetchedAt: now };
  return result;
}

async function fetchFlowById(flowId: string): Promise<FlowDef | null> {
  // 進行中的流程幾乎一定就在剛剛查過的「啟用中流程」快取裡（processLineEvent 一定先呼叫過
  // fetchActiveFlows()），直接命中就省掉兩次資料庫來回。
  // 找不到時仍然照舊查資料庫，不能直接回 null——fetchActiveFlows() 只收 is_active=true，
  // 而「流程進行到一半被後台停用」必須維持原本的行為（繼續走完，不是判定成流程壞掉轉真人）。
  const cacheIsFresh = activeFlowsCache && Date.now() - activeFlowsCache.fetchedAt < ACTIVE_FLOWS_CACHE_TTL_MS;
  const cached = cacheIsFresh ? activeFlowsCache!.data.find((f) => f.id === flowId) : undefined;
  if (cached) return cached;

  const [flowRes, stepsRes] = await Promise.all([
    supabase.from('booking_flows').select('*').eq('id', flowId).single(),
    supabase.from('booking_flow_steps').select('*').eq('flow_id', flowId).order('step_order'),
  ]);
  if (!flowRes.data) return null;
  return mapFlowRow(flowRes.data, stepsRes.data || []);
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
    // 變數定義與訂單資料互不相依，平行取，不要一個等一個（這段在每則流程訊息都會跑到）。
    const [variables, bookingRes] = await Promise.all([
      fetchMessageVariables(),
      bookingId ? supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const booking: any = bookingRes.data;
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
  const [rt, dr, promo, sp, cp] = await Promise.all([
    // 只抓「房間」類型：其他類型（例如公共空間）不能訂房，不該進到報價引擎
    supabase.from('room_types').select('*').eq('type', '房間'),
    supabase.from('booking_date_ranges').select('*'),
    supabase.from('promotions').select('*'),
    supabase.from('special_prices').select('*'),
    supabase.from('room_capacity_pricing').select('*'),
  ]);
  return {
    roomTypes: rt.data || [],
    dateRanges: (dr.data || []).map((d: any) => ({ range_type: d.range_type, start_date: d.start_date, end_date: d.end_date })),
    promotions: promo.data || [],
    specialPrices: (sp.data || []).map((s: any) => ({ start_date: s.start_date, end_date: s.end_date, occupancy: s.occupancy, price: s.price })),
    capacityFees: (cp.data || []).map((c: any) => ({ capacity: c.capacity, extra_room_fee: c.extra_room_fee })),
  };
}

// 目前有效啟用的房間，依容量分組計數，供純公式計價（computeStandardRoomLayout）使用。
function toRoomCapacityCounts(roomTypes: any[]): { capacity: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const r of roomTypes) {
    if (r.is_active === false || !r.capacity) continue;
    counts.set(r.capacity, (counts.get(r.capacity) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([capacity, count]) => ({ capacity, count }));
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

function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.split(`[${key}]`).join(value);
  }
  return result;
}

// 變數定義表（[訂單編號] 這類佔位符對應到哪個欄位）幾乎不會變動，但每則要套版的流程訊息都會讀一次。
// 比照 settings／流程設定用同一套短 TTL 記憶體快取。
const MESSAGE_VARIABLES_CACHE_TTL_MS = 5 * 60 * 1000;
let messageVariablesCache: { data: MessageVariable[]; fetchedAt: number } | null = null;

async function fetchMessageVariables(): Promise<MessageVariable[]> {
  const now = Date.now();
  if (messageVariablesCache && now - messageVariablesCache.fetchedAt < MESSAGE_VARIABLES_CACHE_TTL_MS) {
    return messageVariablesCache.data;
  }
  const { data } = await supabase.from('message_variables').select('variable_name, source, field_key').order('display_order');
  const result = (data as MessageVariable[]) || [];
  messageVariablesCache = { data: result, fetchedAt: now };
  return result;
}

function toSlashDate(isoDate: string | null | undefined): string {
  return (isoDate || '').replace(/-/g, '/');
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

// 決定這張訂單實際開哪幾間房：顧客有指定「幾人房各要幾間」就照他指定的挑，
// 沒指定就用系統算出的標準房型（standardLayout，來自 computeStandardRoomLayout）。
// 不分個別租房／包棟——這個模型下所有訂單都是「開了哪幾間房」。
async function resolveOpenedRooms(input: {
  collected: Record<string, string>;
  allFields: FlowFieldDef[];
  roomTypes: any[];
  standardLayout: Record<number, number>;
  checkinIso: string;
  checkoutIso: string;
  bookingId: string;
}): Promise<{ rooms: SelectableRoom[]; shortfall: RoomCountRequest[] }> {
  const selectable: SelectableRoom[] = (input.roomTypes || [])
    .filter((r: any) => r.is_active !== false)
    .map((r: any) => ({ id: r.id, name: r.name, capacity: r.capacity, display_order: r.display_order ?? 0, floor: r.floor ?? '' }));

  const countsByCapacity = deriveRequestedLayout(input.collected, input.allFields);
  const finalCounts = Object.keys(countsByCapacity).length ? countsByCapacity : input.standardLayout;
  const requests = toRoomCountRequests(finalCounts);
  const occupied = await fetchOccupiedRoomIds(input.checkinIso, input.checkoutIso, input.bookingId);
  return selectRoomsByRequest(requests, selectable, occupied);
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
  // 格式不符的欄位當作沒收集到（從 extracted 移除，不會寫進 collected），跟「完全沒提到」
  // 分開回覆，讓顧客知道是格式錯誤要重打，不是漏答。'date' 類型會順便把值正規化成 YYYY-MM-DD
  // 存回 extracted，後面算價/確認訊息用到的就是統一格式，不管顧客當初打哪種寫法。
  const invalidFields: FlowFieldDef[] = [];
  for (const f of currentStep.fields) {
    if (extracted[f.key] === undefined) continue;
    const normalized = normalizeFieldValue(f.value_type, extracted[f.key]);
    if (normalized === null) {
      invalidFields.push(f);
      delete extracted[f.key];
    } else {
      extracted[f.key] = normalized;
    }
  }

  const collected = { ...session.collected, ...extracted };

  if (invalidFields.length > 0) {
    await saveBookingSession(userId, { ...session, collected });
    const replyText = `${invalidFields.map((f) => f.label).join('、')}格式錯誤，請重新輸入`;
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return;
  }

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

  const hasAllQuoteFields = ['checkin_date', 'checkout_date', 'headcount'].every((k) => quoteValues[k] !== undefined);

  if (!hasAllQuoteFields) {
    const name = pickByLabelHeuristic(collected, allFields, ['姓名', '名字']) || nickname;
    const phone = pickByLabelHeuristic(collected, allFields, ['電話', '手機', '聯絡']);
    await supabase
      .from('bookings')
      .update({ collected_answers: collected, name, phone, updated_at: new Date().toISOString() })
      .eq('id', bookingId);

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
    const consecutiveStayDiscountPerNight =
      settings.consecutive_stay_default_option === 'cleaning'
        ? settings.consecutive_stay_discount_cleaning || 0
        : settings.consecutive_stay_discount_no_cleaning || 0;
    const activePromotion = settings.active_promotion_id ? data.promotions.find((p: any) => p.id === settings.active_promotion_id) || null : null;
    // 客人在「幾人房要開幾間」欄位裡指定的房型組合，沒指定就用系統自動算出的標準房型。
    const requestedLayout = deriveRequestedLayout(collected, allFields);

    const result = computeUnifiedMultiNightQuote({
      checkInDate: checkinDate,
      nights,
      headcount,
      dateRanges: data.dateRanges,
      roomCapacities: toRoomCapacityCounts(data.roomTypes),
      capacityFees: data.capacityFees,
      bedBaseRate: Number(settings.bed_base_rate ?? 1000),
      fullOccupancyBonus: Number(settings.full_occupancy_bonus ?? 500),
      minGroupHeadcount: Number(settings.min_group_headcount ?? 1),
      dateSurcharge: {
        small_holiday: Number(settings.date_surcharge_small_holiday ?? 0),
        peak: Number(settings.date_surcharge_peak ?? 0),
        long_holiday: Number(settings.date_surcharge_long_holiday ?? 0),
      },
      requestedLayout: Object.keys(requestedLayout).length ? requestedLayout : null,
      promotion: activePromotion,
      consecutiveStayDiscountPerNight,
      specialPrices: data.specialPrices,
      specialPriceStacksWithDiscounts: settings.special_price_stacks_with_discounts !== false,
      peakSeasonWeekdayTier: settings.peak_season_weekday_tier || 'peak',
      weekdayRange: settings.weekday_range || 'sun_thu',
    });

    if (result.total == null) {
      await supabase
        .from('bookings')
        .update({ collected_answers: collected, checkin_date: checkinIso, checkout_date: checkoutIso, nights, headcount, updated_at: new Date().toISOString() })
        .eq('id', bookingId);
      const replyText = '不好意思，這個日期／人數組合目前無法自動試算（可能是超過可接待人數，或低於最少接待人數），麻煩您點選「真人客服」，我們會盡快為您確認房況與價格。';
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      await clearBookingSession(userId);
      return;
    }

    const total = result.total as number;

    // 決定這張訂單實際開哪幾間房。價格已經在上面算完了，這一段不會動到金額，
    // 只負責「開哪幾間」——沒指定房型組合就用系統算出的標準房型（result.standardLayout）。
    const openedRooms = await resolveOpenedRooms({
      collected,
      allFields,
      roomTypes: data.roomTypes,
      standardLayout: result.standardLayout || {},
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
    const roomTypeLabel = openedRooms.rooms.length ? openedRooms.rooms.map((r) => roomLabel(r)).join('、') : null;

    // 每晚都佔用同一批房間（這個模型不會有同一趟住宿中途換房），供衝突檢查/行事曆使用。
    const roomTypeIds = openedRooms.rooms.map((r) => r.id);
    const roomNights = Array.from({ length: nights }, (_, i) => ({ date: dateToIso(new Date(checkinDate.getTime() + i * 86400000)), roomTypeIds }));

    await saveBookingRooms(bookingId, openedRooms.rooms.map((r) => r.id));

    const name = pickByLabelHeuristic(collected, allFields, ['姓名', '名字']) || nickname;
    const phone = pickByLabelHeuristic(collected, allFields, ['電話', '手機', '聯絡']);

    // 報價引擎算出來的 total 是「房價」，押金與訂金在這裡一次算齊。
    // 押金＝這張訂單開的每間房押金加總（不再分個別租房/包棟，這個模型下所有訂單都是「開了哪幾間房」）。
    const roomDepositById = new Map(data.roomTypes.map((rt: any) => [rt.id, Number(rt.security_deposit ?? 0)]));
    const securityDeposit = openedRooms.rooms.reduce((sum, r) => sum + (roomDepositById.get(r.id) ?? 0), 0);
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
        whole_house: false,
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
      quote: { total, roomNights, roomIds: openedRooms.rooms.map((r) => r.id) },
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
    await supabase.from('bookings').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', session.bookingId);
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
      { checkin_date: booking.checkin_date, checkout_date: booking.checkout_date, whole_house: false, roomTypeIdsByNight },
      booking.id
    );
  } catch (e: any) {
    console.error('[Booking] conflict check failed:', e.message);
  }

  if (hasConflict) {
    await supabase.from('bookings').update({ status: 'pending_manual_conflict', updated_at: new Date().toISOString() }).eq('id', booking.id);
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
  await supabase
    .from('bookings')
    .update({ status: 'awaiting_deposit', reserved_at: nowIso, payment_deadline_at: computePaymentDeadlineDate(settings).toISOString(), updated_at: nowIso })
    .eq('id', booking.id);

  if (quote.roomNights?.length) {
    const rows = quote.roomNights.flatMap((rn) => rn.roomTypeIds.map((roomTypeId) => ({ booking_id: booking.id, night_date: rn.date, room_type_id: roomTypeId })));
    if (rows.length) {
      const { error: roomNightsError } = await supabase.from('booking_room_nights').insert(rows);
      if (roomNightsError) console.error('[Booking] insert room nights failed:', roomNightsError.message);
    }
  }

  // 訂房確認的當下就把布巾洗滌成本帶出來，管理員之後在訂單管理可以再調整。
  await generateLinenUsage(booking.id, quote.roomIds || [], booking.linen_change_count ?? 1);

  // 房價／押金／訂單總額／訂金在報價當下就一起算好寫進 bookings 了（見 finishBookingFlow），這裡直接沿用。
  const confirmVariables = await fetchMessageVariables();
  const confirmFields = buildMergeFields(confirmVariables, {
    booking,
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
// 不強制轉真人——這個階段收到任何訊息，代表顧客覺得他該通知我們了（已經匯款、或有匯款相關的問題），
// 但不需要因此讓 is_human_mode 卡住這位客人後續的訊息：真人會自己去「訂單管理」核對這筆訂單，
// 核對後在「訂單管理」把狀態改成已預定即可，不需要透過即時對話接手。這裡只推播通知＋回覆客人，
// 讓客人接下來仍然可以正常使用 AI／知識庫問答，不會被晾在旁邊沒人理。
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

  const replyText = '好的，已收到您的匯款回報，我們核對後會盡快為您確認訂房，謝謝您的耐心等候 🙏';
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
// AI 呼叫 (GPT / Gemini)
// overrideSystemPrompt：訂房流程的欄位擷取／內部任務用，會完全取代知識庫 system prompt。
// ========================================================================

// 知識庫邊界：不管管理員在「系統指令」裡怎麼寫，客服回答一律不能超出知識庫範圍——
// 沒寫的問題如果讓 AI 憑常識回答，遇到退房政策、寵物政策這類「猜錯代價很高」的問題會很危險。
// 固定寫死在這裡（不是 settings.system_prompt 的一部分），管理員改系統指令也不會不小心把這條規則改掉。
const KB_BOUNDARY_INSTRUCTION =
  '重要規則：只能根據下面「參考資料」裡的內容回答問題。參考資料沒有提到的事情，一律誠實回答「不好意思，這個問題我不清楚，建議您聯繫真人客服協助」，絕對不要用自己的知識猜測或編造答案，即使聽起來很合理也一樣。';

// 知識庫檔案型附件過去每一則訊息都重新下載一次內容，短 TTL 記憶體快取避免重複下載
// （管理員換檔案後最多晚 5 分鐘生效，跟 quote sheet header 快取用同一個 TTL）。
const KB_FILE_CACHE_TTL_MS = 5 * 60 * 1000;
const kbFileTextCache = new Map<string, { text: string; fetchedAt: number }>();
const kbFileBinaryCache = new Map<string, { data: string; mimeType: string; fetchedAt: number }>();

async function fetchKbFileText(url: string): Promise<string> {
  const cached = kbFileTextCache.get(url);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < KB_FILE_CACHE_TTL_MS) return cached.text;
  try {
    const r = await fetch(url);
    const text = r.ok ? await r.text() : '';
    kbFileTextCache.set(url, { text, fetchedAt: now });
    return text;
  } catch (e) {
    return '';
  }
}

async function fetchKbFileBinary(url: string): Promise<{ data: string; mimeType: string } | null> {
  const cached = kbFileBinaryCache.get(url);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < KB_FILE_CACHE_TTL_MS) return cached;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const b = await r.arrayBuffer();
    const result = { data: Buffer.from(b).toString('base64'), mimeType: url.endsWith('.pdf') ? 'application/pdf' : 'text/plain', fetchedAt: now };
    kbFileBinaryCache.set(url, result);
    return result;
  } catch (e) {
    return null;
  }
}

// 一般問答（非流程內欄位擷取）用：把最近幾筆對話記錄接到 chat-completion 的訊息陣列裡，
// 讓 AI 有「上一輪聊過什麼」的記憶，不再是每則訊息都當作全新的獨立對話。
function buildHistoryMessages(history?: { direction: string; content: string }[]): { role: 'user' | 'assistant'; content: string }[] {
  return (history || []).map((h) => ({ role: h.direction === 'inbound' ? 'user' as const : 'assistant' as const, content: h.content }));
}

// 把客人最近一筆未取消的訂單/報價摘要整理成一段話塞進 system prompt，讓 AI 回答「我的訂單」
// 「剛剛算的價格」這類後續問題時有東西可以參考，而不是只能回「不清楚」。純參考用途，
// 明確告訴 AI 不要拿這個當作要重新確認或重新計價的依據，避免它自作主張又跑一次訂房流程的邏輯。
function bookingSummaryBlock(recentBooking: any | null | undefined): string {
  if (!recentBooking) return '';
  const parts = [
    recentBooking.order_number ? `訂單編號 ${recentBooking.order_number}` : null,
    recentBooking.checkin_date && recentBooking.checkout_date ? `入住 ${recentBooking.checkin_date} 至 ${recentBooking.checkout_date}` : null,
    recentBooking.headcount ? `人數 ${recentBooking.headcount}` : null,
    recentBooking.whole_house ? '包棟' : (recentBooking.room_type_label || null),
    recentBooking.total_amount != null ? `總價 NT$${recentBooking.total_amount}` : null,
    recentBooking.status ? `狀態 ${bookingStatusLabel(recentBooking.status)}` : null,
  ].filter(Boolean).join('、');
  if (!parts) return '';
  return `這位客人最近一筆詢問／訂單資料（僅供回答問題時參考背景，不代表要重新確認或重新計價）：${parts}\n\n`;
}

async function callGPT(
  settings: any,
  currentMessage: string,
  kbItems: any[],
  overrideSystemPrompt?: string,
  history?: { direction: string; content: string }[],
  recentBooking?: any | null,
) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');

  let systemContent: string;
  if (overrideSystemPrompt) {
    systemContent = overrideSystemPrompt;
  } else {
    const textBlock = kbItems.filter((i) => i.type === 'text' && i.content).map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
    let fileContent = '';
    for (const item of kbItems.filter((i) => i.type === 'file' && i.file_url)) {
      const text = await fetchKbFileText(item.file_url);
      if (text) fileContent += `\n\n【${item.title}】\n${text}`;
    }
    systemContent = `${settings.system_prompt}\n\n${KB_BOUNDARY_INSTRUCTION}\n\n${bookingSummaryBlock(recentBooking)}參考資料：\n${textBlock}${fileContent}`;
  }

  const historyMessages = overrideSystemPrompt ? [] : buildHistoryMessages(history);

  if (isGPT5) {
    const transcript = [...historyMessages, { role: 'user' as const, content: currentMessage }]
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const body: any = {
      model: settings.gpt_model_name,
      input: `System: ${systemContent}\n${transcript}`,
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
  const messages: any[] = [{ role: 'system', content: systemContent }, ...historyMessages, { role: 'user', content: currentMessage }];
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

async function callGemini(
  settings: any,
  currentMessage: string,
  kbItems: any[],
  overrideSystemPrompt?: string,
  history?: { direction: string; content: string }[],
  recentBooking?: any | null,
) {
  if (overrideSystemPrompt) {
    const contents = [{ role: 'user', parts: [{ text: overrideSystemPrompt }, { text: `User: ${currentMessage}` }] }];
    return callGeminiRaw(settings, contents);
  }

  const textBlock = kbItems.filter((i) => i.type === 'text' && i.content).map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
  const systemParts: any[] = [{ text: `System: ${settings.system_prompt}\n\n${KB_BOUNDARY_INSTRUCTION}\n\n${bookingSummaryBlock(recentBooking)}Reference: ${textBlock}` }];

  for (const item of kbItems.filter((i) => i.type === 'file' && i.file_url)) {
    const file = await fetchKbFileBinary(item.file_url);
    if (file) systemParts.push({ inline_data: { data: file.data, mime_type: file.mimeType } });
  }

  const contents: any[] = [{ role: 'user', parts: systemParts }];
  for (const h of history || []) {
    contents.push({ role: h.direction === 'inbound' ? 'user' : 'model', parts: [{ text: h.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: `User: ${currentMessage}` }] });
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

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
      // 嘗試寫入 event_id，如果重複，資料庫會報錯
      const { error: eventError } = await supabase
        .from('processed_events')
        .insert({ event_id: eventId });

      if (eventError) {
        console.log(`[Dedupe] Skipping already processed event: ${eventId}`);
        continue; // 這是重複請求，直接跳過，不進行任何狀態更新
      }

      // 2. 獲取當前狀態
      const { data: userState } = await supabase.from('user_states').select('*').eq('line_user_id', userId).single();

      // 3. 關鍵字偵測 (轉真人客服)
      const handoverKeywords = parseCsvKeywords(settings.handover_keywords);
      const matchedKeyword = matchKeyword(userMessage, handoverKeywords);

      if (matchedKeyword) {
        console.log(`[Handover] Triggered by keyword: ${matchedKeyword}`);
        let nickname = userState?.nickname || '匿名用戶';
        try { const p = await lineClient.getProfile(userId); nickname = p.displayName; } catch (e) {}

        await supabase.from('user_states').upsert({
          line_user_id: userId,
          nickname,
          is_human_mode: true,
          last_human_interaction: new Date().toISOString()
        });

        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: '已為您轉接真人客服，請稍候。' });

        const agentIds = settings.agent_user_ids?.split(',').map((id: string) => id.trim()).filter(Boolean);
        if (agentIds) {
          for (const id of agentIds) {
            try { await lineClient.pushMessage(id, { type: 'text', text: `🔔 真人通知：【${nickname}】正在呼叫專人。\n觸發字：${matchedKeyword}\n原文：${userMessage}` }); } catch (e) {}
          }
        }
        continue;
      }

      // 3.5 已由 LINE 官方帳號原生「自動回應/圖文選單」處理過的訊息，AI 直接略過不重複回覆
      // （避免同一則訊息同時觸發 LINE 原生自動回應 + 本系統 AI 回覆，造成重複甚至矛盾的兩則訊息）
      const skipAiKeywords = parseCsvKeywords(settings.skip_ai_keywords);
      const matchedSkipKeyword = matchKeyword(userMessage, skipAiKeywords);
      if (matchedSkipKeyword) {
        console.log(`[SkipAI] Message already handled by LINE native auto-reply: ${matchedSkipKeyword}`);
        continue;
      }

      // 4. 真人模式判斷
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
        if (new Date().getTime() - lastInteraction < timeoutMs) continue;
        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
      }

      // 4.5 訂房對話流程（Phase 3）：偵測「我要訂房」觸發詞、或延續進行中的訂房詢問。
      // 日期/晚數/金額一律由 computeMultiNightQuote() 確定性計算，AI 只負責從對話中擷取欄位與潤飾回覆文字，
      // 避免像一般問答那樣讓 AI 自己算晚數/金額，容易算錯（例如把 7/30 入住 7/31 退房誤算成兩晚）。
      if (settings.is_ai_enabled) {
        const bookingTriggerKeywords = parseCsvKeywords(settings.booking_trigger_keywords || '我要訂房,訂房');
        const isBookingTrigger = !!matchKeyword(userMessage, bookingTriggerKeywords);
        const existingBookingSession = loadBookingSession(userState);
        // 重打觸發關鍵字一律視為「重新開始一次新的訂房詢問」，即使前一次還卡在等「是/否」確認也一樣蓋掉，
        // 避免「我要訂房」這句話裡的「要」被 handleBookingConfirmation 誤判成確認前一筆報價。
        // 但如果先前已經在「報價」試算表記錄過列號，沿用同一列，不要重新開一列造成重複紀錄
        // （例如客人或 LINE App 網路重試把觸發詞送了兩次）。
        const isFirstTurn = isBookingTrigger;
        const activeBookingSession = isBookingTrigger
          ? { phase: 'collecting' as const, collected: { ...EMPTY_BOOKING_FIELDS }, quote: null, sheetRowNumber: existingBookingSession?.sheetRowNumber ?? null, updatedAt: Date.now() }
          : existingBookingSession;

        if (activeBookingSession) {
          try {
            await handleBookingFlow(lineClient, lineEvent, settings, userId, userMessage, activeBookingSession, isFirstTurn);
          } catch (e: any) {
            console.error('[Booking] flow failed:', e.message);
          }
          continue;
        }
      }

      // 5. 呼叫 AI（先比對 Google 試算表知識庫意圖，命中則 AI 潤飾固定答案；未命中才走一般 QA）
      if (!settings.is_ai_enabled) continue;

      // 帶入最近的對話紀錄，避免 AI 每則訊息都當成獨立問題，答非所問（例如顧客回「好」卻不知道在回應什麼）
      const history = loadConversationHistory(userState);

      let aiResult = '';
      let aiError = false;
      try {
        let knowledgeRows: KnowledgeRow[] = [];
        if (settings.knowledge_sheet_id) {
          try {
            knowledgeRows = await fetchKnowledgeSheet(settings.knowledge_sheet_id, settings.knowledge_sheet_gid || '0');
          } catch (sheetErr: any) {
            // 試算表讀取失敗不應讓整個客服中斷，記錄錯誤後退回一般 QA（無知識庫 FAQ）
            console.error('[KnowledgeSheet] fetch failed:', sheetErr.message);
          }
        }

        let matched = knowledgeRows.length ? matchKnowledgeIntent(userMessage, knowledgeRows) : null;
        if (matched) {
          console.log(`[KnowledgeSheet] Exact match: [${matched.category}] ${matched.question}`);
        } else if (knowledgeRows.length) {
          // Tier 1 精準比對沒命中時，改用一次額外的 AI 語意路由呼叫，
          // 從試算表中挑出語意最相符的一筆；命中就強制走 answerWithPolish（保證不竄改事實），
          // 避免完全交給一般問答的自由生成、單靠 prompt 指令卻不一定被遵守。
          try {
            matched = await routeKnowledgeMatch(settings, userMessage, knowledgeRows);
            if (matched) console.log(`[KnowledgeSheet] Semantic route match: [${matched.category}] ${matched.question}`);
          } catch (routeErr: any) {
            console.error('[KnowledgeSheet] route failed:', routeErr.message);
          }
        }

        if (matched) {
          aiResult = await answerWithPolish(settings, matched.answer);
        } else {
          const faqContext = buildSheetFaqContext(knowledgeRows);
          if (settings.active_ai === 'gpt') aiResult = (await callGPT(settings, userMessage, faqContext, undefined, history)).text;
          else aiResult = await callGemini(settings, userMessage, faqContext, undefined, history);
        }
      } catch (e: any) {
        aiResult = `❌ AI 錯誤：\n${e.message}`;
        aiError = true;
      }

      if (aiResult) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult });
        // AI 錯誤訊息不存入歷史，避免污染後續對話上下文
        if (!aiError) {
          await saveConversationHistory(userId, history, userMessage, aiResult);
        }
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

// ========================================================================
// 關鍵字比對共用工具
// ========================================================================

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

// ========================================================================
// 訂房對話流程（Phase 3）
// 設計原則：日期判斷、晚數計算、金額計算全部交給 computeMultiNightQuote()（純程式碼），
// AI 只負責①從對話中擷取結構化欄位、②把算好的報價結果包裝成罐頭訊息，
// 絕對不讓 AI 自己計算晚數或金額——這正是實測發現「7/30 入住 7/31 退房被算成兩晚」的root cause。
//
// 流程分兩個階段（session.phase），全程只在「報價」試算表同一列上分批補欄位（用 session.sheetRowNumber
// 記住是哪一列，不靠試算表裡的任何欄位反查）：
// 'collecting'：一開始（isFirstTurn）先寫入 LINE_USER_ID/LINE_NAME；還在收集姓名/電話/入住退房日期/
//               人數/大人小孩/是否包棟，收齊後立刻算報價、更新同一列、回覆罐頭報價訊息，轉入 'awaiting_confirmation'。
// 'awaiting_confirmation'：等顧客回「是」或「否」。回「是」會把預定日期（今天）寫回那一列，
//               並重新讀一次（可能已經被填上訂金等後台欄位），套用付款確認罐頭訊息回覆。
// ========================================================================

const BOOKING_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分鐘沒有新回覆，視為放棄這次詢問（與對話記憶 TTL 一致）

interface BookingCollectedFields {
  name: string | null;
  phone: string | null;
  checkin_date: string | null; // YYYY-MM-DD
  checkout_date: string | null; // YYYY-MM-DD
  headcount: number | null; // 入住總人數
  adults: number | null; // 大人
  kids: number | null; // 小孩
  infants: number | null; // 3 歲以下幼兒
  whole_house: boolean | null;
}

interface BookingQuoteInfo {
  total: number;
  useWholeHouse: boolean;
}

interface BookingSession {
  phase: 'collecting' | 'awaiting_confirmation';
  collected: BookingCollectedFields;
  quote: BookingQuoteInfo | null;
  sheetRowNumber: number | null; // 這次詢問在「報價」試算表對應的列號，三個階段（聯絡/報價/確認）都更新同一列
  updatedAt: number;
}

const EMPTY_BOOKING_FIELDS: BookingCollectedFields = {
  name: null,
  phone: null,
  checkin_date: null,
  checkout_date: null,
  headcount: null,
  adults: null,
  kids: null,
  infants: null,
  whole_house: null,
};

const BOOKING_FIELD_LABELS: Record<string, string> = {
  checkin_date: '入住日期',
  checkout_date: '退房日期',
  headcount: '入住人數',
  whole_house: '是否包棟',
};

function loadBookingSession(userState: any): BookingSession | null {
  if (!userState?.booking_session) return null;
  try {
    const parsed = JSON.parse(userState.booking_session);
    if (!parsed || Date.now() - parsed.updatedAt > BOOKING_SESSION_TTL_MS) return null;
    return {
      phase: parsed.phase === 'awaiting_confirmation' ? 'awaiting_confirmation' : 'collecting',
      collected: { ...EMPTY_BOOKING_FIELDS, ...parsed.collected },
      quote: parsed.quote || null,
      sheetRowNumber: parsed.sheetRowNumber || null,
      updatedAt: parsed.updatedAt,
    };
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

// 只做欄位擷取，不作答、不計算，避免跟一般問答一樣被誤導去自由發揮。
// 顧客回覆可能有兩種格式（都要能辨識）：(1) 有欄位名稱標記，例如「姓名 :小明」；
// (2) 沒有欄位名稱，依「姓名/電話/入住日期/退房日期/入住人數/大人小孩/是否包棟」固定順序一行一個欄位。
function buildBookingExtractionPrompt(todayIso: string, collected: BookingCollectedFields): string {
  return (
    `你是專門負責「訂房資訊擷取」的助手，這個步驟不需要回答問題、不需要計算晚數或金額，只需要從對話中擷取欄位。\n` +
    `今天的日期是 ${todayIso}。\n\n` +
    `顧客的回覆可能有兩種格式，都要能辨識：\n` +
    `(1) 有欄位名稱標記，例如：「姓名 :小明」「入住日期：8/10」\n` +
    `(2) 沒有欄位名稱，純粹依照「姓名／電話／入住日期／退房日期／入住人數／大人小孩／是否包棟」這個固定順序，一行對應一個欄位。\n\n` +
    `需要擷取的欄位（JSON 格式）：\n` +
    `- name：姓名，字串。\n` +
    `- phone：電話，字串。\n` +
    `- checkin_date：入住日期，轉換成 YYYY-MM-DD。若使用者只寫月/日（如「7/30」），用今天日期推算最合理的年份：日期還沒過就用今年，已經過了就用明年。\n` +
    `- checkout_date：退房日期，格式同上。\n` +
    `- headcount：入住總人數，純數字。\n` +
    `- adults：大人人數，純數字，從「大人小孩」欄位解析（例如「10大2小」→ adults=10）。\n` +
    `- kids：小孩人數，純數字，同上（例如「10大2小」→ kids=2）。\n` +
    `- infants：3 歲以下幼兒人數，純數字，沒提到就是 0（例如「10大2小1幼」→ infants=1）。\n` +
    `- whole_house：是否包棟，true/false，從「是」「否」或包棟／不包棟等文字判斷。\n\n` +
    `目前已經確認的欄位：${JSON.stringify(collected)}\n\n` +
    `規則：\n` +
    `1. 只回傳一個 JSON 物件，包含以上 9 個欄位，不要加任何其他文字、不要用 markdown code block。\n` +
    `2. 從對話中能確定的欄位才填值，不確定或沒提到的欄位維持已知欄位的值（已知也是 null 就填 null），絕對不要自己猜測。\n` +
    `3. 不要計算入住晚數或任何金額，那不是這個步驟的工作。`
  );
}

const BOOKING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// AI 回傳的 JSON 型別不一定可靠（例如把人數寫成字串「15人」而不是數字 15），
// 型別不對的欄位直接丟掉、維持原本已知值，不要讓髒資料流進報價計算——空值至少會被
// 「缺欄位」擋下來繼續追問，型別錯的髒資料卻會默默算出錯誤金額，更難察覺。
function coerceBookingFieldValue(key: keyof BookingCollectedFields, value: unknown): BookingCollectedFields[typeof key] | undefined {
  switch (key) {
    case 'checkin_date':
    case 'checkout_date':
      return typeof value === 'string' && BOOKING_DATE_RE.test(value) ? value : undefined;
    case 'headcount':
    case 'adults':
    case 'kids':
    case 'infants': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
    }
    case 'whole_house':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    case 'name':
    case 'phone':
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    default:
      return undefined;
  }
}

function parseBookingExtraction(raw: string, collected: BookingCollectedFields): BookingCollectedFields {
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
    const parsed = JSON.parse(cleaned);
    const merged: BookingCollectedFields = { ...collected };
    (Object.keys(EMPTY_BOOKING_FIELDS) as (keyof BookingCollectedFields)[]).forEach((key) => {
      if (parsed[key] === undefined || parsed[key] === null) return;
      const coerced = coerceBookingFieldValue(key, parsed[key]);
      if (coerced !== undefined) {
        (merged as any)[key] = coerced;
      }
    });
    return merged;
  } catch {
    return collected; // 解析失敗就維持原本已知欄位，不覆蓋、不中斷
  }
}

async function extractBookingFields(settings: any, userMessage: string, collected: BookingCollectedFields): Promise<BookingCollectedFields> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const prompt = buildBookingExtractionPrompt(todayIso, collected);
  let raw = '';
  if (settings.active_ai === 'gpt') {
    raw = (await callGPT(settings, userMessage, undefined, prompt)).text;
  } else {
    raw = await callGemini(settings, userMessage, undefined, prompt);
  }
  return parseBookingExtraction(raw, collected);
}

function getMissingRequiredBookingFields(collected: BookingCollectedFields): string[] {
  const required: (keyof BookingCollectedFields)[] = ['checkin_date', 'checkout_date', 'headcount', 'whole_house'];
  return required.filter((k) => collected[k] === null || collected[k] === undefined).map((k) => BOOKING_FIELD_LABELS[k]);
}

function buildAskMissingFieldsMessage(missing: string[]): string {
  return `謝謝您提供的資訊！還需要麻煩您補充以下資訊，我們才能幫您試算：\n${missing.map((m) => `・${m}`).join('\n')}`;
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

// 「大人小孩」欄位的顯示格式，跟客人回覆時用的格式一致：10大2小、10大2小1幼
function formatAdultsKids(adults: number | null, kids: number | null, infants: number | null): string {
  const a = adults ?? 0;
  const k = kids ?? 0;
  const i = infants ?? 0;
  return `${a}大${k}小${i > 0 ? `${i}幼` : ''}`;
}

// 匯款截止時間：現在（台灣時間）18:00 前 → 今天 21:00；18:00（含）以後 → 明天 21:00。
// 用 UTC+8 手動位移計算，不依賴伺服器時區設定（Netlify Functions 預設是 UTC）。
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

// 台灣時間的「今天」，yyyy/MM/dd 格式，寫進「報價」試算表的 [預定日期] 欄位用。
function todayTaiwanSlash(): string {
  const taiwanMs = Date.now() + 8 * 60 * 60 * 1000;
  const d = new Date(taiwanMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// 罐頭訊息合併欄位：把範本裡的 [欄位名稱] 換成實際值
function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.split(`[${key}]`).join(value);
  }
  return result;
}

// 內部計算一律用 YYYY-MM-DD（Date 建構子看得懂），但試算表欄位與客人看到的訊息用 yyyy/MM/dd 比較好讀。
function toSlashDate(isoDate: string | null | undefined): string {
  return (isoDate || '').replace(/-/g, '/');
}

// 剛觸發這次訂房詢問：先找這個 LINE_USER_ID 有沒有「還沒算出總金額」的既有列可以沿用
// （降低併發或網路重試造成重複列的機會），真的找不到才新增一列，寫入 LINE_USER_ID／暱稱／狀態。
async function createOrReuseContactRow(settings: any, userId: string, lineClient: Client): Promise<number | null> {
  try {
    const existing = await findOpenQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', userId);
    if (existing) return existing;
    let nickname = '';
    try {
      const profile = await lineClient.getProfile(userId);
      nickname = profile.displayName;
    } catch {
      // 抓不到暱稱不影響流程，留空即可
    }
    return await appendQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', {
      LINE_USER_ID: userId,
      LINE_NAME: nickname,
      狀態: '詢問中',
    });
  } catch (e: any) {
    console.error('[Booking] create contact row failed:', e.message);
    return null;
  }
}

async function handleBookingFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  userMessage: string,
  session: BookingSession,
  isFirstTurn: boolean
) {
  if (session.phase === 'awaiting_confirmation') {
    await handleBookingConfirmation(lineClient, lineEvent, settings, userId, userMessage, session);
    return;
  }

  // 平行處理三件互不依賴的事：AI 擷取欄位、預先抓訂房計算會用到的資料、（第一次觸發時）建立/沿用
  // 「報價」試算表的聯絡列。原本是依序一個一個 await（AI 呼叫 + 好幾次 Google Sheets 來回），
  // 客人在 LINE 上會等比較久；平行跑可以省下不少等待時間。
  const extractionPromise = extractBookingFields(settings, userMessage, session.collected).catch((e: any) => {
    console.error('[Booking] field extraction failed:', e.message);
    return session.collected;
  });
  const bookingDataPromise = fetchBookingData();
  const contactRowPromise: Promise<number | null> =
    isFirstTurn && settings.quote_sheet_id && !session.sheetRowNumber
      ? createOrReuseContactRow(settings, userId, lineClient)
      : Promise.resolve(session.sheetRowNumber ?? null);

  const [collected, contactRowResult] = await Promise.all([extractionPromise, contactRowPromise]);
  let sheetRowNumber = contactRowResult;

  const missing = getMissingRequiredBookingFields(collected);
  if (missing.length > 0) {
    await saveBookingSession(userId, { phase: 'collecting', collected, quote: null, sheetRowNumber });
    // 第一次觸發（顧客剛打「我要訂房」，這則訊息本身通常還沒附資訊）就送出可自訂的歡迎詢問罐頭訊息；
    // 後續回覆仍缺欄位的少見情況，才用「還需要補充」的提示，避免整段罐頭訊息重複洗版。
    const replyText = isFirstTurn ? settings.booking_welcome_message || buildAskMissingFieldsMessage(missing) : buildAskMissingFieldsMessage(missing);
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    return;
  }

  const checkinDate = new Date(`${collected.checkin_date}T00:00:00`);
  const checkoutDate = new Date(`${collected.checkout_date}T00:00:00`);
  const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

  if (!Number.isFinite(nights) || nights <= 0) {
    await saveBookingSession(userId, { phase: 'collecting', collected: { ...collected, checkin_date: null, checkout_date: null }, quote: null, sheetRowNumber });
    await lineClient.replyMessage(lineEvent.replyToken, {
      type: 'text',
      text: '不好意思，入住日期與退房日期看起來有點對不上（退房日期需要晚於入住日期），麻煩您再提供一次正確的入住與退房日期喔。',
    });
    return;
  }

  try {
    const data = await bookingDataPromise; // 前面已經平行開始抓了，這裡通常立即就有結果
    const maxOccupancy = data.packages.length ? Math.max(...data.packages.map((p: any) => p.occupancy)) : 0;
    // 連住折扣是民宿自訂政策、不是詢問顧客的選項，依後台設定的預設類型自動套用，
    // 確保跟後台「試算報價」選同一種類型時算出來的金額一致。
    const consecutiveStayDiscountPerNight =
      settings.consecutive_stay_default_option === 'cleaning'
        ? settings.consecutive_stay_discount_cleaning || 0
        : settings.consecutive_stay_discount_no_cleaning || 0;
    // 促銷方案同理：後台在「訂房設定」選定「目前生效的促銷方案」，LINE 對話流程自動套用同一個，
    // 不用顧客自己提，也不用另外詢問，確保跟後台選同一個方案試算出來的金額一致。
    const activePromotion = settings.active_promotion_id
      ? data.promotions.find((p: any) => p.id === settings.active_promotion_id) || null
      : null;
    const result = computeMultiNightQuote({
      checkInDate: checkinDate,
      nights,
      headcount: collected.headcount as number,
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

    const useWholeHouse = collected.whole_house === true;
    const chosenOption = useWholeHouse ? result.wholeHouse : result.individual;

    if (chosenOption.total == null) {
      await lineClient.replyMessage(lineEvent.replyToken, {
        type: 'text',
        text: '不好意思，這個日期／人數組合目前無法自動試算（可能是該時段未開放此方案，或超過可接待人數），麻煩您點選「真人客服」，我們會盡快為您確認房況與價格。',
      });
      await clearBookingSession(userId);
      return;
    }

    let name = collected.name;
    if (!name) {
      try {
        const profile = await lineClient.getProfile(userId);
        name = profile.displayName;
      } catch {
        name = '';
      }
    }

    const total = chosenOption.total as number;

    // 客人送出資料、算完報價當下就把這些欄位補進「報價」試算表同一列（不管最後回「是」或「否」都會留紀錄，
    // 方便之後用「客製訊息發送」追蹤/促銷還沒確認的客人）。欄位一律照試算表標題列的名稱比對寫入，
    // 不寫死欄位順序，之後在試算表加減欄位、調順序都不會壞掉。用「更新同一列」而不是「新增一列」，
    // 避免同一次詢問在表格裡留下兩筆（聯絡資訊那筆＋報價那筆）。
    if (settings.quote_sheet_id) {
      try {
        const fields = {
          LINE_USER_ID: userId,
          訂房姓名: name || '',
          入住日期: toSlashDate(collected.checkin_date),
          退房日期: toSlashDate(collected.checkout_date),
          入住天數: String(nights),
          人數: String(collected.headcount),
          大人小孩: formatAdultsKids(collected.adults, collected.kids, collected.infants),
          是否包棟: useWholeHouse ? '是' : '否',
          總金額: String(total),
          狀態: '待確認',
        };
        if (!sheetRowNumber) {
          // 第一階段沒能拿到列號（例如剛設定好權限那次、或併發時序問題），先找一次有沒有既有的
          // 「還沒算出總金額」的列可以沿用，真的找不到才新增一列，避免重複列。
          sheetRowNumber = await findOpenQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', userId);
        }
        if (sheetRowNumber) {
          await mergeUpdateQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', sheetRowNumber, fields);
        } else {
          sheetRowNumber = await appendQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', fields);
        }
      } catch (e: any) {
        console.error('[Booking] write quote sheet failed:', e.message);
      }
    }

    const quoteMessage = mergeTemplate(settings.booking_quote_message || '', {
      入住日期: toSlashDate(collected.checkin_date),
      退房日期: toSlashDate(collected.checkout_date),
      人數: String(collected.headcount),
      是否包棟: useWholeHouse ? '是' : '否',
      總金額: total.toLocaleString(),
    });

    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: quoteMessage });
    await saveBookingSession(userId, {
      phase: 'awaiting_confirmation',
      collected: { ...collected, name },
      quote: { total, useWholeHouse },
      sheetRowNumber,
    });
  } catch (e: any) {
    console.error('[Booking] quote failed:', e.message);
    await lineClient.replyMessage(lineEvent.replyToken, {
      type: 'text',
      text: '不好意思，剛剛試算報價時出了一點狀況，麻煩您點選「真人客服」按鈕，我們會盡快為您確認房況與價格。',
    });
    await clearBookingSession(userId);
  }
}

// 等顧客回「是」/「否」確認訂房。回「是」會把預定日期寫回那一列，並重新讀一次（訂金欄位
// 可能已經被填上或用公式算好），套用可自訂的付款確認罐頭訊息回覆；回「否」或看不懂就照對應方式處理。
async function handleBookingConfirmation(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  userMessage: string,
  session: BookingSession
) {
  // 用「開頭比對」而不是「包含比對」，避免不相關句子裡剛好出現「要」「好」這類字被誤判成確認/取消
  // （例如「我要訂房」如果用 includes('要') 會被誤判成 isYes；但因為重打觸發關鍵字一律會重置 session，
  // 不會再走到這個函式，所以這裡可以放心把「要」也算進確認語氣裡）。
  const trimmed = userMessage.trim();
  const isNo = /^(否|不要|不需要|取消|no)/i.test(trimmed);
  const isYes = !isNo && /^(是|對|確定|好|要|沒問題|ok|yes)/i.test(trimmed);

  if (!isYes && !isNo) {
    await lineClient.replyMessage(lineEvent.replyToken, {
      type: 'text',
      text: '不好意思，麻煩回覆「是」確認訂房，或「否」取消，謝謝！',
    });
    return; // 停留在 awaiting_confirmation，不清 session
  }

  if (isNo) {
    if (settings.quote_sheet_id && session.sheetRowNumber) {
      try {
        await mergeUpdateQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', session.sheetRowNumber, { 狀態: '已取消' });
      } catch (e: any) {
        console.error('[Booking] update cancel status failed:', e.message);
      }
    }
    await lineClient.replyMessage(lineEvent.replyToken, {
      type: 'text',
      text: '好的，這次先不訂房沒關係！之後想重新試算歡迎再輸入「我要訂房」，或直接點選「真人客服」讓我們協助您。',
    });
    await clearBookingSession(userId);
    return;
  }

  const quote = session.quote;
  if (!quote) {
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: '不好意思，剛剛的報價資訊遺失了，麻煩您重新輸入「我要訂房」再試一次。' });
    await clearBookingSession(userId);
    return;
  }

  // 顧客回「是」確認：把「今天」寫成預定日期，並重新讀一次那一列（訂金欄位可能已經被你手動填上，
  // 或用公式從總金額算好），這樣付款確認訊息裡的 [訂金] 才會是最新資料。
  let sheetRow: Record<string, string> | null = null;
  if (settings.quote_sheet_id && session.sheetRowNumber) {
    try {
      await mergeUpdateQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', session.sheetRowNumber, {
        預定日期: todayTaiwanSlash(),
        狀態: '已確認',
      });
      sheetRow = await getQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', session.sheetRowNumber);
    } catch (e: any) {
      console.error('[Booking] update confirm date failed:', e.message);
    }
  }

  const depositRaw = sheetRow?.['訂金'] || '';
  const depositNumber = depositRaw ? Number(depositRaw) : NaN;
  const collected = session.collected;

  const confirmMessage = mergeTemplate(settings.booking_confirm_message || '', {
    姓名: collected.name || '',
    入住日期: toSlashDate(collected.checkin_date),
    退房日期: toSlashDate(collected.checkout_date),
    是否包棟: quote.useWholeHouse ? '是' : '否',
    人數: String(collected.headcount ?? ''),
    大人小孩: formatAdultsKids(collected.adults, collected.kids, collected.infants),
    總金額: quote.total.toLocaleString(),
    訂金: Number.isFinite(depositNumber) ? depositNumber.toLocaleString() : '（請洽真人客服確認金額）',
    匯款日時間: computePaymentDeadline(),
  });

  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: confirmMessage });
  await clearBookingSession(userId);
}

// ========================================================================
// Google 試算表知識庫（三層比對：精準關鍵字 → AI 語意路由 → 一般 QA fallback）
// 試算表格式（第一列為標題列，從第二列開始為資料）：
//   A欄：category 分類（選填，僅供辨識/顯示用，不參與比對）
//   B欄：question 問題
//        - 若填「完整問句」（如：還有房間嗎？有空房嗎？）→ 當一般 QA 知識庫使用
//        - 若填「逗號分隔的短關鍵字」（如：房型,房型介紹,房間介紹）→ 使用者輸入命中任一關鍵字時，
//          直接使用 C 欄內容並跳過語意判斷（Tier 1，AI 只負責潤飾語氣）
//   C欄：answer 答案（AI 唯一可信任的事實依據）
//
// 比對流程：
//   Tier 1：matchKnowledgeIntent() 精準字串比對（極快、零成本，但只有輸入完整包含問句/關鍵字才會命中）
//   Tier 1.5：routeKnowledgeMatch() 額外一次 AI 呼叫，請 AI 只從清單中挑出語意最相符的一筆編號（不作答）。
//             命中後一樣走 answerWithPolish()，只潤飾語氣、不會竄改事實 —— 確保只要試算表有答案，
//             回覆意思一定與您寫的一致，不會被一般問答的自由生成能力誤導或忽略指令。
//   Tier 2：以上都沒命中，才把整份試算表當參考資料，交給 callGPT/callGemini 自由回答（buildKnowledgeSection
//           仍會附上「意思需一致」的指令作為最後防線，但這一層無法 100% 保證遵守）。
// ========================================================================

interface KnowledgeRow {
  category: string;   // A 欄：分類（純備註用，不參與比對）
  question: string;   // B 欄：完整問題原文（用於一般 QA 的 FAQ 內容顯示）
  keywords: string[]; // 由 B 欄依逗號切出的候選關鍵字（若 B 欄本身沒有逗號，整句就是唯一一個關鍵字）
  answer: string;      // C 欄：答案
}

const SHEET_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘快取，避免每則訊息都重打 Google API

let tokenCache: { token: string; expiresAt: number } | null = null;
// 「報價」試算表的標題列很少變動，短暫快取可以省掉同一次對話裡好幾個步驟（建立聯絡列/更新報價/確認）
// 各自重新讀一次標題列跟工作表名稱的來回，跟下面知識庫試算表快取（SHEET_CACHE_TTL_MS）同樣的做法。
let quoteSheetHeaderCache: { key: string; title: string; headers: string[]; fetchedAt: number } | null = null;
const QUOTE_SHEET_HEADER_CACHE_TTL_MS = 5 * 60 * 1000;
let sheetCache: { key: string; rows: KnowledgeRow[]; fetchedAt: number } | null = null;

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
    // 訂房設定（Phase 3）要把客人資料寫進「報價」試算表，改用可讀寫的完整範圍（原本只有唯讀）。
    // 服務帳號本身的權限仍由試算表的「共用」設定決定：讀知識庫的試算表分享 Viewer 即可，
    // 「報價」試算表要能被寫入，必須把服務帳號的信箱加到該試算表的共用權限並設為 Editor。
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

// ========================================================================
// 「報價」試算表讀寫（Phase 3）：訂房設定 > 流程設定 / 客製訊息發送 共用。
// 不寫死欄位順序——一律先讀第一列（標題列）建立「欄位名稱 → 第幾欄」對照表，
// 之後在試算表加減欄位、調順序都不會壞掉。
// ========================================================================

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

// 找這個 LINE_USER_ID 目前「還沒算出總金額」的既有列（代表還在進行中的詢問），從最後面往前找
// （最新的在最下面）。用來避免併發請求或客人/LINE App 網路重試把同一次詢問拆成兩列。
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
      return i + 2; // values 從 A2 開始（跳過標題列），index 0 對應試算表第 2 列
    }
  }
  return null;
}

// 新增一列，回傳 Sheets API 告訴我們寫到第幾列（從 append 回應的 updatedRange 解析），
// 之後同一次訂房詢問要補其他欄位，就直接更新這個列號，不用另外找。
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

// 把新欄位疊在既有那一列上面再整列寫回，而不是整列覆蓋，避免蓋掉前一個階段（例如聯絡資訊、報價金額）
// 已經寫好的欄位。
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

function parseSheetRows(values: string[][]): KnowledgeRow[] {
  const dataRows = (values || []).slice(1); // 跳過標題列
  return dataRows
    .filter((row) => row && row[1])
    .map((row) => {
      const question = (row[1] || '').trim();
      return {
        category: (row[0] || '').trim(),
        question,
        keywords: question
          .replace(/，/g, ',')
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
        answer: (row[2] || '').trim(),
      };
    })
    .filter((row) => row.question && row.answer);
}

async function fetchKnowledgeSheet(sheetId: string, gid: string): Promise<KnowledgeRow[]> {
  const cacheKey = `${sheetId}:${gid}`;
  const now = Date.now();
  if (sheetCache && sheetCache.key === cacheKey && now - sheetCache.fetchedAt < SHEET_CACHE_TTL_MS) {
    return sheetCache.rows;
  }

  const accessToken = await getGoogleAccessToken();
  const title = await resolveSheetTitle(sheetId, gid, accessToken);
  const range = encodeURIComponent(`${title}!A:C`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '讀取試算表內容失敗');

  const rows = parseSheetRows(result.values || []);
  sheetCache = { key: cacheKey, rows, fetchedAt: now };
  return rows;
}

function matchKnowledgeIntent(userMessage: string, rows: KnowledgeRow[]): KnowledgeRow | null {
  for (const row of rows) {
    for (const kw of row.keywords) {
      if (!kw) continue;
      if (kw.length === 1 ? userMessage === kw : userMessage.includes(kw)) {
        return row;
      }
    }
  }
  return null;
}

// 語意路由：把整份試算表問題列成清單，請 AI「只挑編號、不要作答」，
// 避免像一般問答那樣讓 AI 邊挑邊回答、容易忽略「意思必須一致」的規則。
function buildRoutingPrompt(rows: KnowledgeRow[]): string {
  const list = rows.map((r, i) => `${i + 1}. [${r.category || '一般'}] ${r.question}`).join('\n');
  return `你是專門負責「常見問題比對」的助手，這個步驟不需要回答問題本身，只需要判斷比對結果。\n\n` +
    `常見問題庫清單：\n${list}\n\n` +
    `請判斷使用者訊息在語意上最符合清單中哪一筆（同一件事、用詞或問法不同也算符合，例如「付款方式」符合「怎麼付款？」、「在哪裡」符合「地址在哪裡？」）。\n` +
    `規則：\n` +
    `1. 如果有符合的，只回答該筆前面的編號數字，不要有任何其他文字、標點或說明。\n` +
    `2. 如果都不符合、或使用者只是打招呼、閒聊、語意不明確，只回答：無\n` +
    `3. 絕對不要回答問題本身的答案內容，只需要回答編號或「無」。`;
}

async function routeKnowledgeMatch(settings: any, userMessage: string, rows: KnowledgeRow[]): Promise<KnowledgeRow | null> {
  if (!rows.length) return null;
  const routingPrompt = buildRoutingPrompt(rows);
  let raw = '';
  if (settings.active_ai === 'gpt') {
    raw = (await callGPT(settings, userMessage, undefined, routingPrompt)).text;
  } else {
    raw = await callGemini(settings, userMessage, undefined, routingPrompt);
  }
  const cleaned = (raw || '').trim();
  if (!cleaned || cleaned.includes('無')) return null;
  const numMatch = cleaned.match(/\d+/);
  if (!numMatch) return null;
  const idx = parseInt(numMatch[0], 10) - 1;
  if (idx < 0 || idx >= rows.length) return null;
  return rows[idx];
}

function buildSheetFaqContext(rows: KnowledgeRow[]): string {
  if (!rows.length) return '';
  return rows.map((r) => `[${r.category || '一般'}] Q: ${r.question}\nA: ${r.answer}`).join('\n\n');
}

// 一般 QA fallback 時，把「必須忠於 FAQ 答案意思」的規則包裝起來，避免 AI 自由發揮改變事實
function buildKnowledgeSection(extraKnowledge?: string): string {
  if (!extraKnowledge) return '';
  return `【常見問答知識庫】以下是最可信任的事實依據，請務必遵守：\n` +
    `1. 若使用者的問題與下方任一筆意思相符，你的回答意思必須與該筆「答案」完全一致，只能用自己的話讓語氣更自然、口語化，禁止新增、刪除或竄改任何事實、數字、日期、金額、政策。\n` +
    `2. 若使用者的問題不在下方清單中，才依系統指令與參考資料自由回答；若不確定答案，請誠實告知並建議使用者聯繫真人客服，不要編造內容。\n\n` +
    `${extraKnowledge}\n\n`;
}

// 命中意圖時：不讓 AI 自由發揮，只請它把試算表原文改寫成親切語氣，避免事實被竄改/幻覺
async function answerWithPolish(settings: any, rawAnswer: string): Promise<string> {
  const polishPrompt = `你是民宿的客服助手，請將下方「資訊內容」改寫成親切自然、口語化的繁體中文回覆給顧客。\n規則：\n1. 禁止新增、刪除或修改任何事實內容，只能調整語氣與措辭。\n2. 不要加上「以下是」「根據資料」之類的開場白，直接給出可以傳送給顧客的回覆內容本身。\n\n資訊內容：\n${rawAnswer}`;
  if (settings.active_ai === 'gpt') {
    return (await callGPT(settings, rawAnswer, undefined, polishPrompt)).text;
  }
  return await callGemini(settings, rawAnswer, undefined, polishPrompt);
}

// ========================================================================
// 對話記憶：讓 AI 知道同一位顧客最近說過什麼，避免每則訊息都被當成獨立問題
// （例如顧客回「好」卻答非所問）。只在一般問答（Tier 2）帶入，
// Tier 1/1.5 的 answerWithPolish 與語意路由呼叫是單次任務，不需要對話歷史。
// ========================================================================

const HISTORY_TTL_MS = 30 * 60 * 1000; // 超過 30 分鐘沒互動，視為新話題，不再帶入舊歷史
const HISTORY_MAX_TURNS = 6; // 最多帶入/保留最近 6 則訊息（約 3 輪對話），兼顧上下文與 API 成本

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}

function loadConversationHistory(userState: any): HistoryEntry[] {
  if (!userState?.conversation_history) return [];
  let parsed: HistoryEntry[] = [];
  try {
    parsed = JSON.parse(userState.conversation_history);
  } catch {
    return [];
  }
  const now = Date.now();
  return (parsed || []).filter((h) => h && now - h.ts < HISTORY_TTL_MS).slice(-HISTORY_MAX_TURNS);
}

async function saveConversationHistory(userId: string, priorHistory: HistoryEntry[], userMessage: string, aiResult: string) {
  const now = Date.now();
  const updated: HistoryEntry[] = [
    ...priorHistory,
    { role: 'user', content: userMessage, ts: now },
    { role: 'assistant', content: aiResult, ts: now },
  ].slice(-HISTORY_MAX_TURNS);

  try {
    await supabase.from('user_states').upsert({ line_user_id: userId, conversation_history: JSON.stringify(updated) });
  } catch (e: any) {
    console.error('[History] save failed:', e.message);
  }
}

function formatHistoryText(history: HistoryEntry[]): string {
  if (!history.length) return '';
  return history.map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`).join('\n') + '\n';
}

// ========================================================================
// AI 呼叫 (GPT / Gemini)
// extraKnowledge：一般 QA fallback 時，把試算表整理成 FAQ 塞進去補強知識庫
// overrideSystemPrompt：意圖命中後的「限定改寫」模式，會完全取代 system_prompt/參考文字/檔案內容
// history：最近幾輪對話紀錄，只在一般問答（未帶 overrideSystemPrompt）時使用
// ========================================================================

async function callGPT(settings: any, currentMessage: string, extraKnowledge?: string, overrideSystemPrompt?: string, history: HistoryEntry[] = []) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');

  let systemContent: string;
  if (overrideSystemPrompt) {
    systemContent = overrideSystemPrompt;
  } else {
    let fileContent = '';
    if (settings.reference_file_url) {
      try { const r = await fetch(settings.reference_file_url); if (r.ok) fileContent = await r.text(); } catch (e) {}
    }
    systemContent = `${settings.system_prompt}\n\n${buildKnowledgeSection(extraKnowledge)}參考文字：\n${settings.reference_text}\n\n檔案內容：\n${fileContent}`;
  }

  if (isGPT5) {
    const body: any = {
      model: settings.gpt_model_name,
      input: `System: ${systemContent}\n${formatHistoryText(history)}User: ${currentMessage}`,
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
  const messages: any[] = [
    { role: 'system', content: systemContent },
    ...history.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: currentMessage },
  ];
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

async function callGemini(settings: any, currentMessage: string, extraKnowledge?: string, overrideSystemPrompt?: string, history: HistoryEntry[] = []) {
  if (overrideSystemPrompt) {
    const contents = [{ role: 'user', parts: [{ text: overrideSystemPrompt }, { text: `User: ${currentMessage}` }] }];
    return callGeminiRaw(settings, contents);
  }

  let filePart: any = null;
  if (settings.reference_file_url) {
    try {
      const r = await fetch(settings.reference_file_url);
      if (r.ok) {
        const b = await r.arrayBuffer();
        filePart = { inline_data: { data: Buffer.from(b).toString('base64'), mime_type: settings.reference_file_url.endsWith('.pdf') ? 'application/pdf' : 'text/plain' } };
      }
    } catch (e) {}
  }
  const historyContents = history.map((h) => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] }));
  const userParts: any[] = [{ text: `System: ${settings.system_prompt}\n${buildKnowledgeSection(extraKnowledge)}Reference: ${settings.reference_text}` }];
  if (filePart) userParts.push(filePart);
  userParts.push({ text: `User: ${currentMessage}` });
  const contents = [...historyContents, { role: 'user', parts: userParts }];
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

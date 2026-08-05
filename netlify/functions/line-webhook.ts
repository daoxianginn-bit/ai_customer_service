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

      // 4.5 訂房對話流程：偵測「我要訂房」觸發詞、或延續進行中的訂房詢問。
      // 日期/晚數/金額一律由 computeMultiNightQuote() 確定性計算，AI 只負責從對話中擷取欄位與潤飾回覆文字。
      if (settings.is_ai_enabled) {
        const bookingTriggerKeywords = parseCsvKeywords(settings.booking_trigger_keywords || '我要訂房,訂房');
        const isBookingTrigger = !!matchKeyword(userMessage, bookingTriggerKeywords);
        const existingBookingSession = loadBookingSession(userState);
        // 重打觸發關鍵字一律視為「重新開始一次新的訂房詢問」，但沿用先前已記錄的試算表列號（若有），不重新開一列。
        const isFirstTurn = isBookingTrigger;
        const activeBookingSession = isBookingTrigger
          ? { phase: 'collecting' as const, collected: { ...EMPTY_BOOKING_FIELDS }, quote: null, sheetRowNumber: existingBookingSession?.sheetRowNumber ?? null, updatedAt: Date.now() }
          : existingBookingSession;

        if (activeBookingSession) {
          try {
            await handleBookingFlow(lineClient, lineEvent, settings, userId, nickname, userMessage, activeBookingSession, isFirstTurn);
          } catch (e: any) {
            console.error('[Booking] flow failed:', e.message);
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
// 訂房對話流程
// 設計原則：日期判斷、晚數計算、金額計算全部交給 computeMultiNightQuote()（純程式碼），
// AI 只負責①從對話中擷取結構化欄位、②把算好的報價結果包裝成罐頭訊息，絕對不讓 AI 自己計算晚數或金額。
//
// 流程分兩個階段（session.phase），全程只在「報價」試算表同一列上分批補欄位：
// 'collecting'：收集姓名/電話/入住退房日期/人數/大人小孩/是否包棟，收齊後立刻算報價、回覆罐頭報價訊息，轉入 'awaiting_confirmation'。
// 'awaiting_confirmation'：等顧客回「是」或「否」。回「是」寫回預定日期，套用付款確認罐頭訊息回覆。
// ========================================================================

const BOOKING_SESSION_TTL_MS = 30 * 60 * 1000; // 30 分鐘沒有新回覆，視為放棄這次詢問

interface BookingCollectedFields {
  name: string | null;
  phone: string | null;
  checkin_date: string | null; // YYYY-MM-DD
  checkout_date: string | null; // YYYY-MM-DD
  headcount: number | null;
  adults: number | null;
  kids: number | null;
  infants: number | null;
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
  sheetRowNumber: number | null;
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
    return collected;
  }
}

async function extractBookingFields(settings: any, userMessage: string, collected: BookingCollectedFields): Promise<BookingCollectedFields> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const prompt = buildBookingExtractionPrompt(todayIso, collected);
  let raw = '';
  if (settings.active_ai === 'gpt') {
    raw = (await callGPT(settings, userMessage, [], prompt)).text;
  } else {
    raw = await callGemini(settings, userMessage, [], prompt);
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

function todayTaiwanSlash(): string {
  const taiwanMs = Date.now() + 8 * 60 * 60 * 1000;
  const d = new Date(taiwanMs);
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
  nickname: string | null,
  userMessage: string,
  session: BookingSession,
  isFirstTurn: boolean
) {
  if (session.phase === 'awaiting_confirmation') {
    await handleBookingConfirmation(lineClient, lineEvent, settings, userId, nickname, userMessage, session);
    return;
  }

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
    const replyText = isFirstTurn ? settings.booking_welcome_message || buildAskMissingFieldsMessage(missing) : buildAskMissingFieldsMessage(missing);
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return;
  }

  const checkinDate = new Date(`${collected.checkin_date}T00:00:00`);
  const checkoutDate = new Date(`${collected.checkout_date}T00:00:00`);
  const nights = Math.round((checkoutDate.getTime() - checkinDate.getTime()) / 86400000);

  if (!Number.isFinite(nights) || nights <= 0) {
    await saveBookingSession(userId, { phase: 'collecting', collected: { ...collected, checkin_date: null, checkout_date: null }, quote: null, sheetRowNumber });
    const replyText = '不好意思，入住日期與退房日期看起來有點對不上（退房日期需要晚於入住日期），麻煩您再提供一次正確的入住與退房日期喔。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return;
  }

  try {
    const data = await bookingDataPromise;
    const maxOccupancy = data.packages.length ? Math.max(...data.packages.map((p: any) => p.occupancy)) : 0;
    const consecutiveStayDiscountPerNight =
      settings.consecutive_stay_default_option === 'cleaning'
        ? settings.consecutive_stay_discount_cleaning || 0
        : settings.consecutive_stay_discount_no_cleaning || 0;
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
      const replyText = '不好意思，這個日期／人數組合目前無法自動試算（可能是該時段未開放此方案，或超過可接待人數），麻煩您點選「真人客服」，我們會盡快為您確認房況與價格。';
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
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
    await logConversation(userId, nickname, 'outbound', quoteMessage, 'system');
    await saveBookingSession(userId, {
      phase: 'awaiting_confirmation',
      collected: { ...collected, name },
      quote: { total, useWholeHouse },
      sheetRowNumber,
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
    if (settings.quote_sheet_id && session.sheetRowNumber) {
      try {
        await mergeUpdateQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', session.sheetRowNumber, { 狀態: '已取消' });
      } catch (e: any) {
        console.error('[Booking] update cancel status failed:', e.message);
      }
    }
    const replyText = '好的，這次先不訂房沒關係！之後想重新試算歡迎再輸入「我要訂房」，或直接點選「真人客服」讓我們協助您。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await clearBookingSession(userId);
    return;
  }

  const quote = session.quote;
  if (!quote) {
    const replyText = '不好意思，剛剛的報價資訊遺失了，麻煩您重新輸入「我要訂房」再試一次。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await clearBookingSession(userId);
    return;
  }

  // 檔期防呆（簡化版）：只擋「包棟衝突」——新訂單是包棟、或跟某筆已確認的包棟訂單日期重疊。
  let hasConflict = false;
  if (settings.quote_sheet_id && session.sheetRowNumber) {
    try {
      hasConflict = await checkWholeHouseConflict(
        settings.quote_sheet_id,
        settings.quote_sheet_gid || '0',
        session.sheetRowNumber,
        toSlashDate(session.collected.checkin_date),
        toSlashDate(session.collected.checkout_date),
        quote.useWholeHouse
      );
    } catch (e: any) {
      console.error('[Booking] conflict check failed:', e.message);
    }
  }

  if (hasConflict) {
    if (settings.quote_sheet_id && session.sheetRowNumber) {
      try {
        await mergeUpdateQuoteSheetRow(settings.quote_sheet_id, settings.quote_sheet_gid || '0', session.sheetRowNumber, { 狀態: '待人工確認（檔期衝突）' });
      } catch (e: any) {
        console.error('[Booking] update conflict status failed:', e.message);
      }
    }
    const replyText = '非常抱歉，這個日期範圍目前可能已經有其他包棟訂單，需要請真人客服為您確認實際空房狀況，我們會盡快與您聯繫，謝謝您的耐心等候 🙏';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    const agentIds = (settings.agent_user_ids || '').split(',').map((id: string) => id.trim()).filter(Boolean);
    for (const id of agentIds) {
      try {
        await lineClient.pushMessage(id, {
          type: 'text',
          text: `⚠️ 檔期衝突通知：【${session.collected.name || ''}】想確認 ${toSlashDate(session.collected.checkin_date)}~${toSlashDate(session.collected.checkout_date)} 包棟訂房，但「報價」試算表已有其他「已確認」訂單日期重疊，請人工核實實際空房狀況並跟客人聯繫。`,
        });
      } catch {
        // 通知失敗不影響流程
      }
    }
    await clearBookingSession(userId);
    return;
  }

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
  await logConversation(userId, nickname, 'outbound', confirmMessage, 'system');
  await clearBookingSession(userId);
}

// ========================================================================
// 「報價」試算表讀寫（Google Sheets，服務帳號需為 Editor 權限）
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
    // 要把客人資料寫進「報價」試算表，需要可讀寫的完整範圍（不是唯讀）。
    // 服務帳號本身的權限由試算表的「共用」設定決定：「報價」試算表要能被寫入，必須設為 Editor。
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

function datesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA < endB && startB < endA;
}

async function checkWholeHouseConflict(
  sheetId: string,
  gid: string,
  currentRowNumber: number,
  checkinDate: string,
  checkoutDate: string,
  isWholeHouse: boolean
): Promise<boolean> {
  const accessToken = await getGoogleAccessToken();
  const { title, headers } = await getQuoteSheetHeaders(sheetId, gid, accessToken);
  const checkinIdx = headers.indexOf('入住日期');
  const checkoutIdx = headers.indexOf('退房日期');
  const wholeHouseIdx = headers.indexOf('是否包棟');
  const statusIdx = headers.indexOf('狀態');
  if (checkinIdx === -1 || checkoutIdx === -1 || statusIdx === -1) return false;
  const range = encodeURIComponent(`${title}!A2:Z`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || '讀取「報價」試算表資料失敗');
  const rows: string[][] = result.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (i + 2 === currentRowNumber) continue;
    const r = rows[i];
    if ((r[statusIdx] || '') !== '已確認') continue;
    const otherCheckin = r[checkinIdx];
    const otherCheckout = r[checkoutIdx];
    if (!otherCheckin || !otherCheckout) continue;
    const otherIsWholeHouse = wholeHouseIdx !== -1 && r[wholeHouseIdx] === '是';
    if (!isWholeHouse && !otherIsWholeHouse) continue;
    if (datesOverlap(checkinDate, checkoutDate, otherCheckin, otherCheckout)) return true;
  }
  return false;
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

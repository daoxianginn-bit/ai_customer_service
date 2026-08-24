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
  computeTodayTomorrowFields,
} from '../../src/lib/messageVariables';
import { bookingStatusLabel, OCCUPYING_STATUSES } from '../../src/lib/bookingStatus';
import { writeOperationLog, withErrorLogging, LOG_FEATURES, SYSTEM_ACTOR } from '../../src/lib/operationLog';
import { roomLabel } from '../../src/lib/rooms';
import { generateOrderNumber } from '../../src/lib/orderNumber';
import {
  SelectableRoom, RoomCountRequest, selectRoomsByRequest, toRoomCountRequests, describeShortfall,
} from '../../src/lib/roomSelection';
import { computeUsage, normalizeChangeCount } from '../../src/lib/linenCost';
import { LineChannel, isFullServiceRole, channelRoleLabel } from '../../src/lib/lineChannels';

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

export async function flushPendingWrites() {
  while (pendingWrites.length) {
    const queued = pendingWrites;
    pendingWrites = [];
    await Promise.allSettled(queued);
  }
}

// 這次 webhook 呼叫是哪個官方帳號打進來的。
//
// 一次 webhook POST 只會來自一個官方帳號，所以整個 invocation 期間這個值是固定的——
// 即使 handler 用 Promise.allSettled 平行處理多位客人的事件，大家共用的也是同一個頻道，
// 不會互相污染。相對於把 channel 參數一路穿過二十幾個函式（saveBookingSession、
// logConversation、各流程處理函式…），這個作法侵入性小很多。
// 一定要在 handler 解析出頻道後、開始處理事件前設定。
let activeChannelId: string | null = null;

function logConversation(
  userId: string,
  nickname: string | null,
  direction: 'inbound' | 'outbound',
  content: string,
  source: string,
  channelId: string | null = activeChannelId
) {
  deferWrite('conversations.insert', () =>
    supabase.from('conversations').insert({ channel_id: channelId, line_user_id: userId, nickname, direction, content, source })
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

// 頻道設定變動不頻繁，但每次 webhook 呼叫都要讀（驗簽章、拿 access token）。
// 比照 settings 用同樣的 30 秒 TTL 快取。
const CHANNELS_CACHE_TTL_MS = 30 * 1000;
let channelsCache: { data: LineChannel[]; fetchedAt: number } | null = null;

async function fetchChannels(): Promise<LineChannel[]> {
  const now = Date.now();
  if (channelsCache && now - channelsCache.fetchedAt < CHANNELS_CACHE_TTL_MS) return channelsCache.data;
  const { data } = await supabase
    .from('line_channels')
    .select('*')
    .eq('is_active', true)
    .order('display_order');
  const result = (data || []) as LineChannel[];
  channelsCache = { data: result, fetchedAt: now };
  return result;
}

// 哪個官方帳號打進來的：網址帶 ?channel=<id> 就用那個。
// 沒帶就退回第一個 customer 頻道——升級前設定在 LINE 後台的 webhook 網址沒有這個參數，
// 這個 fallback 讓既有的客戶帳號在還沒去改網址之前照常運作，不會一部署就斷線。
async function resolveChannel(channelId: string | undefined): Promise<LineChannel | null> {
  const channels = await fetchChannels();
  if (channelId) return channels.find((c) => c.id === channelId) || null;
  return channels.find((c) => c.role === 'customer') || null;
}

// 顧客求助真人時的通知。優先送到「系統設定」指定的通知名單——名單自己帶了「用哪個官方帳號發、
// 發給哪些人」，所以可以直接發到團隊內部用帳號，換人只要在後台改名單。
// 沒設定名單就退回舊行為（用客戶用帳號推播給 agent_user_ids），避免既有安裝升級後突然靜悄悄。
// customerClient 是呼叫端已經建好的客戶用帳號 client，退回舊行為時直接沿用，不用重建。
async function notifyHandover(settings: any, customerClient: Client, text: string): Promise<void> {
  const groupId = settings.handover_notification_group_id;
  if (groupId) {
    const { data: group } = await supabase
      .from('notification_recipient_groups')
      .select('channel_id, line_user_ids')
      .eq('id', groupId)
      .maybeSingle();
    const recipients: string[] = group?.line_user_ids || [];
    if (group && recipients.length) {
      const { data: groupChannel } = await supabase.from('line_channels').select('*').eq('id', group.channel_id).maybeSingle();
      if (groupChannel?.channel_access_token) {
        // 名單所屬帳號自己的 client：LINE 的 user ID 是跟著官方帳號綁的，跨帳號推播一定失敗。
        const groupClient = new Client({ channelAccessToken: groupChannel.channel_access_token, channelSecret: groupChannel.channel_secret });
        for (const id of recipients) {
          try { await groupClient.pushMessage(id, { type: 'text', text }); } catch (e: any) { console.error('[Handover] group push failed:', e.message); }
        }
        return;
      }
    }
    console.error('[Handover] 通知名單不存在／沒有聯絡人／帳號憑證未設定，退回 agent_user_ids');
  }

  for (const id of parseCsvKeywords(settings.agent_user_ids)) {
    try { await customerClient.pushMessage(id, { type: 'text', text }); } catch (e: any) { console.error('[Handover] agent push failed:', e.message); }
  }
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const settings = await fetchSettings();
  if (!settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const channel = await resolveChannel(event.queryStringParameters?.channel);
  if (!channel) return { statusCode: 404, body: 'LINE channel not configured' };
  activeChannelId = channel.id;

  const lineClient = new Client({
    channelAccessToken: channel.channel_access_token,
    channelSecret: channel.channel_secret,
  });

  // 簽章一定要用「這個頻道自己的」secret 驗——用錯頻道的 secret 會全部驗不過，
  // 也不能省略：這是唯一能確認請求真的來自 LINE 的機制。
  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', channel.channel_secret, signature)) {
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
        await processLineEvent(lineEvent, settings, lineClient, channel);
      }
    })
  );

  // 客人的回覆此時已經送出，這裡才把累積的收尾寫入一次做完。一定要在 return 之前，
  // 容器 return 後就凍結了（見 deferWrite 的說明）。
  await flushPendingWrites();

  return { statusCode: 200, body: 'OK' };
};

// LINE 群組（機器人被邀進去的群組聊天，例如內部推播通知用的群組）：這裡只負責記錄
// 「這個頻道被邀進了哪些群組」，完全不進客服 AI/訂房流程——群組是多人聊天的地方，
// 裡面任何人講話都不代表「這位客人要訂房」，混進去會被 AI 誤判成客人訊息去回覆
// （這是修這個功能之前真實會發生的問題：group 訊息的 source.userId 常常是 undefined，
// 舊版程式碼直接用 lineEvent.source.userId! 硬轉型，等於把 undefined 當成一個使用者處理）。
//
// LINE 有兩種多人聊天：group（群組，有名稱）與 room（多人聊天室，沒有名稱，是把好友直接拉在一起的
// 那種）。以前只處理 group，room 完全被忽略——機器人明明在裡面、後台卻永遠列不出來，
// 也就永遠沒辦法選它當發送對象。兩者都存進 line_groups，用 chat_type 區分；room 沒有名稱可查，
// 名稱留空由畫面顯示成「多人聊天室」。
async function handleGroupEvent(lineEvent: any, lineClient: Client, channel: LineChannel): Promise<void> {
  const isRoom = lineEvent.source?.type === 'room';
  const groupId: string | undefined = isRoom ? lineEvent.source?.roomId : lineEvent.source?.groupId;
  if (!groupId) return;

  if (lineEvent.type === 'leave') {
    await supabase.from('line_groups')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('channel_id', channel.id).eq('group_id', groupId);
    return;
  }

  // join（機器人被邀進群組）或 message（群組裡有人傳訊息）都當作「這個群組還在使用中」。
  if (lineEvent.type !== 'join' && lineEvent.type !== 'message') return;

  const { data: existing } = await supabase.from('line_groups')
    .select('name').eq('channel_id', channel.id).eq('group_id', groupId).maybeSingle();

  let name = existing?.name || null;
  // room 沒有名稱這個概念，LINE 也沒有對應的查詢端點，只有 group 查得到摘要。
  if (!name && !isRoom) {
    // 拿不到摘要（權限不足／群組已解散）不影響記錄本身，名稱留空，後台顯示群組 ID 代替。
    try { name = (await lineClient.getGroupSummary(groupId)).groupName; } catch {}
  }

  await supabase.from('line_groups').upsert({
    channel_id: channel.id,
    group_id: groupId,
    name,
    chat_type: isRoom ? 'room' : 'group',
    is_active: true,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'channel_id,group_id' });
}

async function processLineEvent(
  lineEvent: WebhookEvent,
  settings: any,
  lineClient: Client,
  channel: LineChannel
): Promise<void> {
  const sourceType = (lineEvent as any).source?.type;
  if (sourceType === 'group' || sourceType === 'room') {
    await handleGroupEvent(lineEvent, lineClient, channel);
    return;
  }

  // 文字以外只處理圖片：預訂單會請顧客回傳「轉帳明細截圖」，那張圖不判讀內容，但至少要
  // 進得來，才能通知客服「有人傳了憑證，請人工核對」，而不是整則訊息被丟掉、沒人知道。
  // 貼圖、影片、語音等仍然略過。
  if (lineEvent.type !== 'message') return;
  const isImageMessage = lineEvent.message.type === 'image';
  if (lineEvent.message.type !== 'text' && !isImageMessage) return;

  const userId = lineEvent.source.userId!;
  // 圖片沒有文字內容，用一個固定字串代表，讓對話記錄看得出顧客傳過一張圖。
  const userMessage = isImageMessage ? '[圖片]' : ((lineEvent.message as any).text || '').trim();
  const eventId = (lineEvent as any).webhookEventId;

  if (!userMessage || !eventId) return;

  try {
    // 1. 強制去重 (關鍵防禦) ＋ 2. 獲取當前狀態
    // 兩者沒有先後依賴（狀態查詢是唯讀的，就算是重複事件也只是白查一次），平行發出省一個來回。
    // 狀態一定要連 channel_id 一起比對：同一組 line_user_id 在不同官方帳號是不同的人。
    const [dedupeRes, userStateRes] = await Promise.all([
      supabase.from('processed_events').insert({ event_id: eventId }),
      supabase.from('user_states').select('*').eq('channel_id', channel.id).eq('line_user_id', userId).maybeSingle(),
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
    // onConflict 要指定複合主鍵，否則 supabase 會用預設的單欄推斷而撞不到既有列。
    const isFirstEverMessage = !userState;
    deferWrite('user_states.upsert', () =>
      supabase.from('user_states').upsert({
        channel_id: channel.id,
        line_user_id: userId,
        nickname,
        avatar_url: avatarUrl,
        last_message_at: new Date().toISOString(),
        // first_message_at 只在第一次見到這個 userId 時寫入一次，之後 upsert 不會再覆蓋
        ...(isFirstEverMessage ? { first_message_at: new Date().toISOString() } : {}),
      }, { onConflict: 'channel_id,line_user_id' })
    );

    logConversation(userId, nickname, 'inbound', userMessage, 'user', channel.id);

    // AI 忽略關鍵字：訊息只要含有其中一個字，整則完全跳過——不進訂房流程、不轉真人、也不呼叫
    // AI，只留一筆對話紀錄。給不該被系統/AI 接住的雜訊訊息用（例如特定貼圖轉出來的固定文字、
    // 測試用字串），跟上面「轉真人客服」的關鍵字用途相反，兩者互相獨立、不要合併判斷。
    if (!isImageMessage && matchKeyword(userMessage, parseCsvKeywords(settings.ai_ignore_keywords))) {
      return;
    }

    // 廠商／團隊內部帳號：不跑訂房流程也不跑知識庫問答，只記錄聯絡人並把回覆轉給客服知道。
    // 這兩種帳號的用途是「接收訂單完成統計」，對方回一句「已備貨」時我們要收得到，
    // 但不該讓 AI 拿民宿的知識庫去回答廠商，那只會答非所問。
    if (!isFullServiceRole(channel.role)) {
      await handleNonCustomerChannelMessage(lineClient, lineEvent, settings, channel, userId, nickname, userMessage);
      return;
    }

    // 3. 關鍵字偵測 (轉真人客服)
    // 圖片沒有文字可以比對關鍵字，userMessage 是固定的「[圖片]」，跳過這一段免得誤觸發。
    const handoverKeywords = isImageMessage ? [] : parseCsvKeywords(settings.handover_keywords);
    const matchedKeyword = matchKeyword(userMessage, handoverKeywords);

    if (matchedKeyword) {
      console.log(`[Handover] Triggered by keyword: ${matchedKeyword}`);
      try { const p = await lineClient.getProfile(userId); nickname = p.displayName; } catch (e) {}

      // 刻意不設 is_human_mode：顧客喊真人客服只是「請人來看一下」，不代表要把 AI 關掉。
      // 舊行為會讓 AI 整個靜音等真人接手，真人沒注意到的話顧客就完全沒人理；現在改成 AI 繼續
      // 正常回答，真人隨時可以在 LINE 官方帳號直接插話。這裡只更新暱稱，狀態完全不動。
      await supabase.from('user_states').upsert({
        channel_id: channel.id,
        line_user_id: userId,
        nickname,
      }, { onConflict: 'channel_id,line_user_id' });

      // 紀錄仍然要留：「AI客服中心」跟「總覽」都會讀這張表統計顧客求助狀況。
      await supabase.from('handover_logs').insert({
        channel_id: channel.id,
        line_user_id: userId,
        nickname,
        triggered_keyword: matchedKeyword,
        started_at: new Date().toISOString(),
        status: 'open',
      });

      const replyText = '已收到您的需求，我們的服務人員會盡快與您聯繫，謝謝您 🙏';
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      logConversation(userId, nickname, 'outbound', replyText, 'system', channel.id);

      await notifyHandover(settings, lineClient, `🔔 真人客服通知：【${nickname || '匿名用戶'}】正在呼叫專人。\n觸發字：${matchedKeyword}\n原文：${userMessage}`);
      return;
    }

    // 4. 真人模式判斷
    if (userState?.is_human_mode) {
      const lastInteraction = new Date(userState.last_human_interaction).getTime();
      const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
      if (new Date().getTime() - lastInteraction < timeoutMs) {
        // 客人還在互動就延後計時——真人客服是直接在 LINE 官方帳號 App 裡回覆客人，這個系統
        // 看不到真人本人有沒有在處理，只能靠客人是否還在傳訊息判斷「這通還沒結束」。
        await supabase.from('user_states').update({ last_human_interaction: new Date().toISOString() })
          .eq('channel_id', channel.id).eq('line_user_id', userId);
        return;
      }

      await supabase.from('user_states').update({ is_human_mode: false })
        .eq('channel_id', channel.id).eq('line_user_id', userId);
      await supabase
        .from('handover_logs')
        .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: 'timeout_auto' })
        .eq('channel_id', channel.id)
        .eq('line_user_id', userId)
        .eq('status', 'open');
    }

    // 4.5 動態訂房流程：管理員在「訂房流程設定」自訂的多步驟對話（最多 5 步，每步最多擷取 3 個答案）。
    //
    // 進行中的 session 一定要先檢查、優先於「這句話符不符合某個流程的觸發關鍵字」——
    // 特別是已經送出報價、正在等客人回「是/否」的 awaiting_confirmation 階段。過去這裡是反過來：
    // 先比對觸發關鍵字，符合就直接開新流程，導致客人明明已經在等報價結果，只要這時候點了
    // 「其他問題」之類剛好也對到某個流程觸發字的自動回覆圖文選單，就會被悄悄開一個全新的空白
    // session，把已經收集好的資訊整個蓋掉——客人會看到報價卡片後面立刻接一句「還需要補充」，
    // 而且怎麼回「是」都卡在同一句，因為當下其實是在回答一個他根本不知道自己開啟的新流程。
    if (settings.is_ai_enabled) {
      // 只有「這位客人本來就有 booking_session」才需要搶鎖——全新客人的第一句話不可能跟自己
      // 的舊 session 競爭。搶到鎖時一併換成當下重新讀到的最新一份 user_states，不能沿用呼叫端
      // 一開始那份：那份如果剛好是在等鎖期間，已經被前一個持鎖者（處理中的另一則訊息）改過了。
      let effectiveUserState = userState;
      let lockAcquired = false;
      if (userState?.booking_session) {
        const claimed = await acquireFlowLock(channel.id, userId);
        if (!claimed) {
          const replyText = '不好意思，您上一句話還在為您處理中，麻煩稍等幾秒後再重新傳一次，謝謝您 🙏';
          await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText }).catch(() => {});
          await logConversation(userId, nickname, 'outbound', replyText, 'system');
          return;
        }
        effectiveUserState = claimed;
        lockAcquired = true;
      }

      try {
        const existingSession = loadBookingSession(effectiveUserState, settings);

        if (existingSession) {
          let handled = true;
          try {
            handled = await continueBookingFlow(lineClient, lineEvent, settings, userId, nickname, userMessage, existingSession, isImageMessage);
          } catch (e: any) {
            console.error('[Booking] continue flow failed:', e.message);
          }
          // handled=false 代表流程判斷這則訊息不歸它管，直接往下走一般 AI／知識庫問答照實回答。
          // 這裡刻意不再比對觸發關鍵字、也不能掉進下面那段「逾時」判斷——session 明明還活著，
          // 被那段清掉的話顧客之後真的要回答流程時就接不住了。
          if (handled) return;
        } else {
          const activeFlows = await fetchActiveFlows();

          // 先試「整組完整訂房資訊」，再比對觸發關鍵字——順序不能顛倒。客人把表單複製填好貼回來時，
          // 那段文字往往連提示語（含觸發字）都一起貼進去了；先比對關鍵字的話會直接開一個全新流程、
          // 送出第一步的問句，把客人已經填好的答案整組丟掉，等於逼他再一步一步重答一次。
          if (!isImageMessage && (await tryStartQuoteFromCompleteInfo(lineClient, lineEvent, settings, userId, nickname, userMessage, activeFlows))) return;

          const matchedFlow = activeFlows.find((f) => matchTriggerRules(userMessage, f.triggerRules));
          if (matchedFlow) {
            try {
              await startBookingFlow(lineClient, lineEvent, settings, userId, nickname, matchedFlow);
            } catch (e: any) {
              console.error('[Booking] start flow failed:', e.message);
            }
            return;
          }

          // session 曾經存在、但已經逾時被 loadBookingSession() 判定過期（不是這位客人從沒問過）：
          // 不能悄悄把這句回覆丟給下面的 AI/知識庫，客人會覺得系統在答非所問，要明確告知重新開始。
          if (effectiveUserState?.booking_session) {
            await clearBookingSession(userId);
            const replyText = '不好意思，這次詢問已逾時，請重新輸入一次，謝謝您 🙏';
            await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
            await logConversation(userId, nickname, 'outbound', replyText, 'system');
            return;
          }
        }
      } finally {
        if (lockAcquired) await releaseFlowLock(channel.id, userId);
      }
    }

    // 5. 呼叫 AI
    if (!settings.is_ai_enabled) return;

    // 圖片走到這裡代表它不屬於任何進行中的訂房流程（例如顧客隔了很久才補傳轉帳截圖、
    // session 已經逾時）。userMessage 只是「[圖片]」這個佔位字串，丟給知識庫問答只會得到
    // 一句莫名其妙的回覆，所以改成轉給真人處理——這種圖十之八九是匯款憑證，不能默默吞掉。
    if (isImageMessage) {
      const replyText = '已收到您傳送的圖片，我們會請專人為您確認，謝謝您的耐心等候 🙏';
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      for (const id of parseCsvKeywords(settings.agent_user_ids)) {
        try {
          await lineClient.pushMessage(id, {
            type: 'text',
            text: `🖼️ 收到顧客圖片（不在訂房流程中，系統未判讀）：【${nickname || '匿名用戶'}】\n請到 LINE 官方帳號查看該圖片並人工處理，可能是匯款憑證。`,
          });
        } catch {}
      }
      return;
    }

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
      .eq('channel_id', activeChannelId)
      .eq('line_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(CONVERSATION_HISTORY_LIMIT + 1),
    supabase
      .from('bookings')
      .select('order_number, checkin_date, checkout_date, headcount, whole_house, total_amount, status, room_type_label')
      .eq('channel_id', activeChannelId)
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

// 廠商／團隊內部帳號收到訊息時的處理。
//
// 這兩種帳號是「我們推播、對方偶爾回一句」的單向為主關係，不需要訂房流程也不需要知識庫問答
// （拿民宿的知識庫回答廠商只會答非所問）。所以這裡只做三件事：留下對話記錄、回一句收到、
// 把原文轉給客服知道。真正的判讀交給人，系統不揣測「已備貨」到底代表什麼。
async function handleNonCustomerChannelMessage(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  channel: LineChannel,
  userId: string,
  nickname: string | null,
  userMessage: string
) {
  const replyText = '收到，謝謝您的回覆！';
  try {
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    logConversation(userId, nickname, 'outbound', replyText, 'system', channel.id);
  } catch (e: any) {
    console.error('[Channel] reply failed:', e.message);
  }

  // 轉給客服。用客戶用帳號推播——agent_user_ids 存的是客服在「客戶用官方帳號」下的 userId，
  // 拿廠商帳號的 client 去推會找不到人（user ID 跨帳號不通用）。
  const customerChannel = (await fetchChannels()).find((c) => c.role === 'customer');
  if (!customerChannel?.channel_access_token) return;
  const notifyClient = new Client({
    channelAccessToken: customerChannel.channel_access_token,
    channelSecret: customerChannel.channel_secret,
  });
  const text = `💬 ${channelRoleLabel(channel.role)}帳號「${channel.name}」收到回覆\n來自：${nickname || '未知'}\n內容：${userMessage}`;
  for (const id of parseCsvKeywords(settings.agent_user_ids)) {
    try { await notifyClient.pushMessage(id, { type: 'text', text }); } catch {}
  }
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
  // quote 型專用，報價之後才會用到的兩則訊息。null＝用內建預設文字。
  // takenMessage：回「是」的當下發現房間已被別人訂走（報價階段不鎖房，所以會有這種情況）。
  // remittanceReceivedMessage：預訂單送出後收到顧客訊息（末五碼或截圖）時的回覆。內容不做
  //   自動判讀，一律轉客服人工核對，所以措辭不要寫死成「已確認收到匯款」。
  takenMessage: string | null;
  remittanceReceivedMessage: string | null;
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
    takenMessage: row.taken_message ?? null,
    remittanceReceivedMessage: row.remittance_received_message ?? null,
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
    await supabase.from('user_states').upsert(
      {
        channel_id: activeChannelId,
        line_user_id: userId,
        booking_session: JSON.stringify({ ...session, updatedAt: Date.now() }),
      },
      { onConflict: 'channel_id,line_user_id' }
    );
  } catch (e: any) {
    console.error('[Booking] save session failed:', e.message);
  }
}

// 系統自動異動的操作紀錄（異動者固定是 'system'）。跟後台各頁面共用同一張 operation_logs，
// 這樣「這張訂單為什麼變成取消」不論是人改的還是流程自己改的，都在同一個地方查得到。
async function logSystemOperation(entry: {
  feature: string;
  action: string;
  target?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}) {
  await writeOperationLog(supabase, { ...entry, actorType: 'system', actorName: SYSTEM_ACTOR });
}

async function clearBookingSession(userId: string) {
  try {
    await supabase.from('user_states').update({ booking_session: null })
      .eq('channel_id', activeChannelId).eq('line_user_id', userId);
  } catch (e: any) {
    console.error('[Booking] clear session failed:', e.message);
  }
}

// 同一位客人幾乎同時傳兩則訊息時，LINE 常常拆成兩次獨立的 webhook 呼叫（不是同一次
// events[] 陣列裡那種、下面已經用同一個 for 迴圈序列化處理的批次），兩次呼叫各自在互不相干的
// function 執行環境平行跑，會同時讀出同一份 booking_session、各自改一改再寫回去，後寫的直接蓋掉
// 先寫的——實測就是「報價收集到最後一步、客人立刻又問一句話」會讓算價算到一半的狀態被蓋掉，
// 送出「試算報價時出了狀況」這句求救訊息。
// 用 user_states.flow_lock_at 當一個帶效期的鎖位：UPDATE ... WHERE 沒鎖或鎖已經過期，
// 靠資料庫本身處理「同時有兩邊在搶」的競態，搶到的那次連同一份最新的 row 一起讀回來
// （不能沿用呼叫端一開始那份，那份在等鎖的期間可能已經被前一個持鎖者改過）。
const FLOW_LOCK_STALE_MS = 20000; // 前一個持鎖者真的當掉、沒釋放鎖時，逾期多久後允許別人搶走
const FLOW_LOCK_RETRY_DELAYS_MS = [0, 300, 600, 1000, 1500]; // 總共約等 3.4 秒；還搶不到就放棄，不要無限等卡住這次 function 執行

async function acquireFlowLock(channelId: string, userId: string): Promise<any | null> {
  const cutoffIso = new Date(Date.now() - FLOW_LOCK_STALE_MS).toISOString();
  for (const delay of FLOW_LOCK_RETRY_DELAYS_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const { data, error } = await supabase
      .from('user_states')
      .update({ flow_lock_at: new Date().toISOString() })
      .eq('channel_id', channelId)
      .eq('line_user_id', userId)
      .or(`flow_lock_at.is.null,flow_lock_at.lt.${cutoffIso}`)
      .select('*')
      .maybeSingle();
    if (!error && data) return data;
  }
  return null;
}

async function releaseFlowLock(channelId: string, userId: string) {
  try {
    await supabase.from('user_states').update({ flow_lock_at: null }).eq('channel_id', channelId).eq('line_user_id', userId);
  } catch (e: any) {
    console.error('[Booking] release flow lock failed:', e.message);
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
// 好處是每則訊息省下一次 LLM 呼叫；代價是只認得具體寫法，「下週五」「明天」這種相對日期讀不出來，
// 讀不出來的欄位會留空，continueBookingFlow() 就會照原本的邏輯再問一次。
// 日期支援西元與民國、有無分隔符共 7 種寫法，見 DATE_SCAN_RE。
// ------------------------------------------------------------------------

// 支援的寫法（依序比對，先長後短，避免長字串被短規則咬掉一半）：
//   ce8  西元 8 碼無分隔  20261003
//   roc7 民國 7 碼無分隔  1151003
//   fy   年月日帶分隔符   2026/10/03、2026-10-03、115/10/03、115-10-03（3 碼＝民國，4 碼＝西元）
//   cm   中文月日        10月3日
//   sm   只有月日        10/3、8/7
//   md4  4 碼月日無分隔  1003（＝10月3日；一定要排在最後，理由見下面）
// 純數字那幾組一定要用 (?<!\d)/(?!\d) 夾住，否則會從電話、金額這類長數字中間切出一段當日期
// （例如 0912345678 會被咬出 09123456）。帶分隔符的那組也夾，避免把 2026/10/03 尾巴的
// 10/03 重複當成第二個日期。
// 這裡認得的寫法必須跟 normalizeDateInput() 對齊——擷取不到的話，後面的驗證再寬鬆也沒用。
// md4（0826 這種 4 碼 MMDD）一定要放在最後一個分支：正規表示式在同一個位置是照分支順序試的，
// 把它排前面的話，「2026/08/26」的開頭「2026」會先被它吃掉（月份 20 不合法而作廢），
// 剩下的「/08/26」再被當成另一個日期，整串日期就被讀歪了。放最後，帶分隔符與 7/8 碼的寫法
// 都會先比對成功，4 碼只會在「真的只有 4 個獨立數字」時才輪到。
const DATE_SCAN_RE =
  /(?<!\d)(?<ce8>\d{8})(?!\d)|(?<!\d)(?<roc7>\d{7})(?!\d)|(?<!\d)(?<fy>\d{3,4})[-/.](?<fm>\d{1,2})[-/.](?<fd>\d{1,2})(?!\d)|(?<cm>\d{1,2})\s*月\s*(?<cd>\d{1,2})\s*[日號]?|(?<!\d)(?<sm>\d{1,2})[-/.](?<sd>\d{1,2})(?!\d)|(?<!\d)(?<md4>\d{4})(?!\d)/g;

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

// 民國年轉西元。民國 115 年＝西元 2026 年，3 碼年份一律當民國——不可能有西元 115 年的訂房。
const ROC_YEAR_OFFSET = 1911;

function scanDates(message: string): string[] {
  const found: string[] = [];
  for (const m of message.matchAll(DATE_SCAN_RE)) {
    const g = m.groups || {};
    let iso: string | null = null;
    if (g.ce8) {
      iso = buildIsoDate(Number(g.ce8.slice(4, 6)), Number(g.ce8.slice(6, 8)), Number(g.ce8.slice(0, 4)));
    } else if (g.roc7) {
      iso = buildIsoDate(Number(g.roc7.slice(3, 5)), Number(g.roc7.slice(5, 7)), Number(g.roc7.slice(0, 3)) + ROC_YEAR_OFFSET);
    } else if (g.fy) {
      iso = buildIsoDate(Number(g.fm), Number(g.fd), g.fy.length === 4 ? Number(g.fy) : Number(g.fy) + ROC_YEAR_OFFSET);
    } else if (g.cm) {
      iso = buildIsoDate(Number(g.cm), Number(g.cd));
    } else if (g.sm) {
      iso = buildIsoDate(Number(g.sm), Number(g.sd));
    } else if (g.md4) {
      // 0826＝8 月 26 日。年份交給 buildIsoDate 用「還沒過就今年、過了就明年」推算，
      // 跟 8/26 這種寫法算出來的結果一致。月份/日期不合法（例如 2612）會回 null 被略過。
      iso = buildIsoDate(Number(g.md4.slice(0, 2)), Number(g.md4.slice(2, 4)));
    }
    // buildIsoDate 會擋掉月份 13、2/30 這種不存在的日期，回 null 就當作沒抓到。
    if (iso && !found.includes(iso)) found.push(iso);
  }
  return found;
}

// 人數擷取的候選寫法，由「最可信」排到「最沒把握」，依序試、先中先用：
//   1. 明確標示的「人數：16」——客人照著問句逐行回答時最常見，也最不可能誤判。
//   2. 帶單位的「16人」「16位」「2大人」——但要排掉「4人房」這種其實在講房型的寫法，
//      否則問人數會抓到房型名稱裡的數字。
//   3. 前兩種都沒有，才退回「訊息裡第一個獨立的數字」（例如整個步驟就只問人數、客人只回一個數字）。
//
// 三個 pattern 的數字都用 (?<!\d)/(?!\d) 夾住，確保抓到的是一整串完整的數字、不是從更長的
// 數字裡切一段出來（跟 DATE_SCAN_RE 同一招）。少了這道邊界，「0902」這種寫壞的日期會被切成
// 「090」當作 90 人——客人完全看不出哪裡錯了，卻會收到一張 90 人的報價。
const HEADCOUNT_PATTERNS = [
  /人數\s*[:：]?\s*(?<!\d)(\d{1,3})(?!\d)/,
  /(?<!\d)(\d{1,3})(?!\d)\s*(?:位|個人|大人|人)(?!房)/,
  /(?<!\d)(\d{1,3})(?!\d)/,
];

function scanHeadcount(message: string): string | undefined {
  // 先把日期字樣挖掉，否則「7/30 入住」的 7 會被誤判成人數
  const withoutDates = message.replace(DATE_SCAN_RE, ' ');
  for (const re of HEADCOUNT_PATTERNS) {
    const m = withoutDates.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return String(n);
  }
  return undefined;
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
    return mergeTemplate(template, {
      ...buildMergeFields(variables, {
        booking: booking || undefined,
        customer: { nickname, line_user_id: userId },
        settings,
      }),
      ...computeTodayTomorrowFields(),
    });
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

// ------------------------------------------------------------------------
// 候補自動回報：訂單被系統擋下（排不出房／檔期衝突）時，除了當下回覆客人，也記一筆
// 「監看對象」，讓「排程管理」的候補排程之後能自動偵測「有結果了」並主動重新試算、推播。
// ------------------------------------------------------------------------

// 挑一筆跟這段日期重疊、目前佔用中的訂單當監看對象——不用精準對應到卡到哪個房型，
// 只要它「有結果」（狀態離開佔用中）就代表值得重新試算一次；抓錯對象頂多晚一點才重新檢查，
// 不影響正確性，因為重新試算時一律用當下即時房況重算，不是照著這筆監看對象本身的房型判斷。
// 挑「最近更新」的一筆，通常也最可能是剛好卡到這次詢問的那一筆。
async function findWaitlistWatchTarget(
  checkinIso: string,
  checkoutIso: string,
  excludeBookingId: string
): Promise<{ id: string; checkin_date: string; checkout_date: string } | null> {
  const { data } = await supabase
    .from('bookings')
    .select('id, checkin_date, checkout_date')
    .in('status', OCCUPYING_STATUSES)
    // 待人工確認的訂單本身沒有真的佔到房間（排不出房的那筆從頭到尾沒登記房間；確認時撞期的
    // 那筆已經把暫時登記的房間放掉了），拿它當監看對象只會讓候補空等一筆永遠不會自然「有結果」
    // 的訂單，所以排除掉，改挑真正握著房間的那筆。
    .neq('status', 'pending_manual_conflict')
    .neq('id', excludeBookingId)
    .lt('checkin_date', checkoutIso)
    .gt('checkout_date', checkinIso)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

// 把「客人想要的區間」跟「卡住他的那筆訂單的區間」交集，換成客人看得懂的日期文字，
// 訊息裡才能明確講出「哪一天」被佔用，不是只講一句空泛的「有衝突」。
function formatOverlapRange(reqStart: string, reqEnd: string, blockStart: string, blockEnd: string): string {
  const start = reqStart > blockStart ? reqStart : blockStart;
  const end = reqEnd < blockEnd ? reqEnd : blockEnd;
  if (start >= end) return `${toSlashDate(reqStart)}~${toSlashDate(reqEnd)}`; // 保底防呆：呼叫端已保證有重疊，理論上不會走到這裡
  return `${toSlashDate(start)}~${toSlashDate(end)}`;
}

// 不同顧客訂到同一天/同房型（或跟包棟）衝突檢查，比對所有「房間已鎖定」的狀態
// （見 OCCUPYING_STATUSES：客人回過「是」以後才算數）。
// excludeBookingIds：這筆訂單自己，加上它取代掉的舊訂單（客人改了日期重新報價的情況，
// 見 bookings.supersedes_booking_id）——舊那筆等一下就會被取消，不該擋住取代它的新訂單。
async function checkBookingConflict(
  target: { checkin_date: string; checkout_date: string; whole_house: boolean; roomTypeIdsByNight: Map<string, string[]> },
  excludeBookingIds: string[]
): Promise<boolean> {
  const excluded = excludeBookingIds.filter(Boolean);
  let query = supabase
    .from('bookings')
    .select('id, whole_house')
    .in('status', OCCUPYING_STATUSES)
    .lt('checkin_date', target.checkout_date)
    .gt('checkout_date', target.checkin_date);
  // 空陣列不能丟給 PostgREST 的 in()——會組出 `id=not.in.()` 這種語法錯誤的條件。
  if (excluded.length) query = query.not('id', 'in', `(${excluded.join(',')})`);
  const { data: overlapping } = await query;

  if (!overlapping || !overlapping.length) return false;

  const overlappingIds = overlapping.map((b: any) => b.id);

  // booking_room_nights（LINE 訂房流程逐晚寫入）跟 booking_rooms（後台人工建單、OTA 匯入寫入）
  // 記錄的來源不同，兩張都要看——只看 booking_room_nights 的話，後台手動建的單跟 Airbnb 之類
  // 匯進來的個別房型訂單在這裡完全是隱形的，客人回「是」就會直接訂到已經有人住的房間。
  // 這裡跟 fetchOccupiedRoomIds() 是同一個判斷，兩邊看的表必須一致。
  const [nightsRes, roomsRes] = await Promise.all([
    supabase.from('booking_room_nights').select('booking_id, night_date, room_type_id').in('booking_id', overlappingIds),
    supabase.from('booking_rooms').select('booking_id, room_type_id').in('booking_id', overlappingIds),
  ]);

  // 擋不擋房一律以「實際佔用了哪幾間房」為準，不看 whole_house 旗標——那個旗標的語意是
  // 「押金算包棟價」，後台每一張新單預設都會勾，拿它當「整棟被佔走」會把所有日期重疊的訂單
  // 全部互相擋死，個別房型的訂單就再也訂不進來了。實際佔房的判斷跟 fetchOccupiedRoomIds() 一致。
  //
  // 唯一的例外是「有包棟旗標、卻查不到任何房間明細」的訂單：OTA 的整棟頻道匯進來的訂單只有
  // 旗標、沒有 booking_rooms（見 syncOneOtaChannel），查不出它佔哪幾間，只能當成整棟都被佔走，
  // 否則那段日期會直接超賣。
  const idsWithRoomDetail = new Set<string>([
    ...(nightsRes.data || []).map((r: any) => r.booking_id),
    ...(roomsRes.data || []).map((r: any) => r.booking_id),
  ]);
  if (overlapping.some((b: any) => b.whole_house && !idsWithRoomDetail.has(b.id))) return true;

  // 這次要成立的訂單自己也查不到房間明細時同理：無從比對是哪幾間，保守視為要整棟。
  if (target.roomTypeIdsByNight.size === 0 && target.whole_house) return true;

  // booking_rooms 沒有逐晚資料，但上面已經先用日期範圍篩過重疊的訂單了，
  // 所以只要房型對上就是衝突，不需要再比對是哪一晚。
  const occupiedRoomTypeIds = new Set((roomsRes.data || []).map((r: any) => r.room_type_id));

  for (const [night, roomTypeIds] of target.roomTypeIdsByNight) {
    for (const roomTypeId of roomTypeIds) {
      if (occupiedRoomTypeIds.has(roomTypeId)) return true;
      if ((nightsRes.data || []).some((r: any) => r.night_date === night && r.room_type_id === roomTypeId)) return true;
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
async function fetchOccupiedRoomIds(checkinIso: string, checkoutIso: string, excludeBookingIds: string[]): Promise<Set<string>> {
  const occupied = new Set<string>();
  const excluded = excludeBookingIds.filter(Boolean);
  let query = supabase
    .from('bookings')
    .select('id')
    .in('status', OCCUPYING_STATUSES)
    .lt('checkin_date', checkoutIso)
    .gt('checkout_date', checkinIso);
  if (excluded.length) query = query.not('id', 'in', `(${excluded.join(',')})`);
  const { data: overlapping } = await query;

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
  // 這筆報價取代掉的舊訂單（客人改日期重新報價時）。舊那筆還鎖著房的話要排除，
  // 否則客人會被自己上一筆訂單擋住，新報價永遠算不出來。
  supersedesBookingId?: string | null;
}): Promise<{ rooms: SelectableRoom[]; shortfall: RoomCountRequest[] }> {
  const selectable: SelectableRoom[] = (input.roomTypes || [])
    .filter((r: any) => r.is_active !== false)
    .map((r: any) => ({ id: r.id, name: r.name, capacity: r.capacity, display_order: r.display_order ?? 0, floor: r.floor ?? '' }));

  const countsByCapacity = deriveRequestedLayout(input.collected, input.allFields);
  const finalCounts = Object.keys(countsByCapacity).length ? countsByCapacity : input.standardLayout;
  const requests = toRoomCountRequests(finalCounts);
  const occupied = await fetchOccupiedRoomIds(input.checkinIso, input.checkoutIso, [input.bookingId, input.supersedesBookingId || '']);
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
    .eq('channel_id', activeChannelId)
    .eq('line_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // quoted（已報價）已併入 inquiring（待報價，見 bookingStatus.ts），所以只需要判斷 inquiring。
  if (latestBooking && latestBooking.status === 'inquiring') {
    bookingId = latestBooking.id;
  }

  let resolvedNickname = nickname;
  if (!bookingId) {
    try {
      const p = await lineClient.getProfile(userId);
      resolvedNickname = p.displayName;
    } catch {}
    const data = await insertNewBooking({ channel_id: activeChannelId, line_user_id: userId, nickname: resolvedNickname, flow_id: flow.id, status: 'inquiring', collected_answers: {} });
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

// 客人沒有進行中的 session，直接把「整組填好的訂房資訊」貼過來——最常見的就是把報價表單範本
// 複製下來、填好再送回來。這種訊息幾乎不會剛好等於流程的觸發關鍵字，過去會一路掉到最下面的
// 一般 AI 問答，由 AI 自己看著知識庫編一段「我們幫您確認」的回覆：實際上完全沒有建立訂單、
// 沒有算過任何價格，也沒有通知任何人，客人卻以為已經送出了。
//
// 判斷標準刻意訂在「會影響算價與開房的欄位（入住/退房/人數/各房型間數）全部解析得到」，
// 而不是「流程定義的每一個欄位」——備註這類純文字欄位客人本來就常常留空，把它算進必要條件
// 會讓正常填好的表單反而不算數。反過來說門檻也不能更低：湊齊兩個日期＋人數＋房數才成立，
// 隨口一句問句幾乎不可能全中，不會亂開單。
//
// 回傳 true 代表已經處理掉了（報價已送出，或試算失敗但也已經回覆顧客），呼叫端不要再動作。
async function tryStartQuoteFromCompleteInfo(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  activeFlows: FlowDef[]
): Promise<boolean> {
  const normalizeInto = (extracted: Record<string, string>, fields: FlowFieldDef[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of fields) {
      if (extracted[f.key] === undefined) continue;
      const normalized = normalizeFieldValue(f.value_type, extracted[f.key]);
      if (normalized !== null) out[f.key] = normalized;
    }
    return out;
  };

  for (const flow of activeFlows) {
    if (flow.flowType !== 'quote') continue;

    const allFields = flow.steps.flatMap((s) => s.fields);
    const quoteFields = allFields.filter((f) => f.quote_field);
    // 這個流程必須真的問得到報價三要素，否則「所有算價欄位都齊了」會變成一句空話
    // （沒設定任何算價欄位的流程，條件會永遠成立、每則訊息都被當成完整訂房資訊）。
    const hasQuoteEssentials = ['checkin_date', 'checkout_date', 'headcount'].every((k) =>
      quoteFields.some((f) => f.quote_field === k)
    );
    if (!hasQuoteEssentials) continue;

    // 便宜的前置關卡：先用純程式擷取（不花 token）。沒有這一關的話，每一則沒有 session 的
    // 閒聊都會多打一次 AI 擷取，等於所有非流程訊息的 AI 成本都翻倍。
    const gate = normalizeInto(extractStepFieldsWithoutAi(userMessage, quoteFields), quoteFields);
    if (quoteFields.some((f) => gate[f.key] === undefined)) continue;

    // 過了關卡才值得問 AI。AI 模式再擷取一次是為了把備註這類自由文字欄位也帶出來；
    // 擷取失敗或結果反而不完整時退回關卡的結果——算價要用的欄位本來就已經齊了，
    // 不該因為 AI 這次抽風就整個放棄、把客人丟回給一般問答。
    let collected = gate;
    if (flow.replyMode !== 'system') {
      const aiExtracted = await extractStepFields(settings, userMessage, allFields).catch((e: any) => {
        console.error('[Booking] direct-info extraction failed:', e.message);
        return {} as Record<string, string>;
      });
      const aiCollected = normalizeInto(aiExtracted, allFields);
      if (quoteFields.every((f) => aiCollected[f.key] !== undefined)) collected = { ...gate, ...aiCollected };
    }

    // 沿用 startBookingFlow 的判斷：客人可能有一筆還停在「待報價」的舊單（session 過期但訂單還在），
    // 接續它而不是再開一筆，否則同一位客人會累積出一堆重複的空訂單。
    let resolvedNickname = nickname;
    const { data: latestBooking } = await supabase
      .from('bookings')
      .select('id, status')
      .eq('channel_id', activeChannelId)
      .eq('line_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let bookingId: string;
    if (latestBooking && latestBooking.status === 'inquiring') {
      bookingId = latestBooking.id;
      await supabase.from('bookings').update({ flow_id: flow.id, collected_answers: collected, updated_at: new Date().toISOString() }).eq('id', bookingId);
    } else {
      try {
        const p = await lineClient.getProfile(userId);
        resolvedNickname = p.displayName;
      } catch {}
      try {
        const created = await insertNewBooking({
          channel_id: activeChannelId,
          line_user_id: userId,
          nickname: resolvedNickname,
          flow_id: flow.id,
          status: 'inquiring',
          collected_answers: collected,
        });
        bookingId = created.id;
      } catch (e: any) {
        console.error('[Booking] direct-info insert failed:', e.message);
        return false; // 開不了單就當作沒處理過，讓呼叫端照原本的邏輯往下走
      }
    }

    const sendReply = (text: string) => lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text }).then(() => {});
    await finishBookingFlow(lineClient, sendReply, settings, userId, resolvedNickname, flow, collected, bookingId);
    return true;
  }

  return false;
}

// 訂房流程進行到一半時，如果流程本身或當下步驟被後台異動掉（刪除流程／改步驟順序）導致對不上，
// 不能悄悄清空 session 就不回話——客人會覺得系統掛了。比照關鍵字轉真人的完整流程處理，
// 讓真人接手，而不是讓客人已讀不回。
async function handoverBrokenFlowSession(lineClient: Client, lineEvent: any, settings: any, userId: string, nickname: string | null) {
  await clearBookingSession(userId);
  const startedAt = new Date().toISOString();
  await supabase.from('user_states').upsert(
    { channel_id: activeChannelId, line_user_id: userId, nickname, is_human_mode: true, last_human_interaction: startedAt },
    { onConflict: 'channel_id,line_user_id' }
  );
  await supabase.from('handover_logs').insert({
    channel_id: activeChannelId,
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

// 回傳 true＝這則訊息已經在流程裡處理完（也已經回覆顧客），呼叫端不要再動作；
// false＝流程判斷這則訊息不歸它管（例如匯款階段收到的其實是一句提問），
// 呼叫端應該讓它繼續往下走一般 AI／知識庫問答。
async function continueBookingFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  session: BookingSession,
  isImage = false
): Promise<boolean> {
  if (session.phase === 'awaiting_confirmation') {
    await handleBookingConfirmation(lineClient, lineEvent, settings, userId, nickname, userMessage, session);
    return true;
  }
  if (session.phase === 'awaiting_remittance') {
    return handleRemittanceReport(lineClient, lineEvent, settings, userId, nickname, userMessage, session, isImage);
  }

  const flow = await fetchFlowById(session.flowId);
  if (!flow) {
    await handoverBrokenFlowSession(lineClient, lineEvent, settings, userId, nickname);
    return true;
  }
  const currentStep = flow.steps.find((s) => s.step_order === session.stepIndex + 1);
  if (!currentStep) {
    await handoverBrokenFlowSession(lineClient, lineEvent, settings, userId, nickname);
    return true;
  }

  // 系統模式不呼叫 AI，直接用純程式解析顧客回覆（省 token）；AI 模式維持原本的 LLM 擷取。
  const stepUsesSystemMode = flow.replyMode === 'system';
  const extracted =
    stepUsesSystemMode
      ? extractStepFieldsWithoutAi(userMessage, currentStep.fields)
      : await extractStepFields(settings, userMessage, currentStep.fields).catch((e: any) => {
          console.error('[Booking] step extraction failed:', e.message);
          return {} as Record<string, string>;
        });

  // system 模式「這一步只問一個自由文字欄位，就把整句話當答案」的捷徑（見
  // extractStepFieldsWithoutAi）沒有任何格式檢查，什麼都會被接受，包含圖文選單按鈕觸發的固定
  // 文字——會把按鈕文字誤存成姓名/電話等欄位的答案，還悄悄推進到下一步，客人完全看不出哪裡錯了。
  // 這裡補一道防線：這句話如果剛好對到「別的」流程的觸發字，就不當作這一欄的答案，讓它照下面
  // missingFields 的邏輯判斷要不要顯示別的流程的自動回覆。順便快取起來，missingFields 那邊
  // 不用再查一次。
  let interruptingFlow: FlowDef | undefined;
  const soleFreeTextKey =
    stepUsesSystemMode && currentStep.fields.length === 1 && !currentStep.fields[0].quote_field
      ? currentStep.fields[0].key
      : null;
  if (soleFreeTextKey && extracted[soleFreeTextKey] !== undefined) {
    interruptingFlow = (await fetchActiveFlows()).find((f) => f.id !== flow.id && matchTriggerRules(userMessage, f.triggerRules));
    if (interruptingFlow) delete extracted[soleFreeTextKey];
  }

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
    return true;
  }

  const missingFields = currentStep.fields.filter((f) => !collected[f.key]);
  if (missingFields.length > 0) {
    // 跟 awaiting_confirmation／awaiting_remittance 同樣的考量：這一步沒抓到欄位，
    // 也可能是客人點了圖文選單之類的按鈕，剛好對到「別的」流程的觸發字，根本不是在回答
    // 這一題。這時候要讓那個自動回覆正常顯示，不要用「還需要補充」卡住客人、也不要把這次
    // 空的擷取結果存回 session——客人晚一點認真回這一題時，原本收集到的資料還在。
    // 排除目前這個流程本身：重複打到同一個流程的觸發字比較像是想重新開始，不是這裡要處理的情境。
    // interruptingFlow 上面可能已經查過（免費文字欄位捷徑那段）就直接沿用，沒有才現查。
    interruptingFlow ??= (await fetchActiveFlows()).find((f) => f.id !== flow.id && matchTriggerRules(userMessage, f.triggerRules));
    const interruptingFirstStep = interruptingFlow?.steps.find((s) => s.step_order === 1);
    if (interruptingFirstStep) {
      const replyText = await renderFlowMessage(interruptingFirstStep.message_template, settings, userId, nickname, null);
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      return true;
    }

    await saveBookingSession(userId, { ...session, collected });
    const replyText = `還需要麻煩您補充：${missingFields.map((f) => f.label).join('、')}`;
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return true;
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
    return true;
  }

  if (flow.flowType === 'collect') {
    await finishCollectFlow(lineClient, lineEvent, settings, userId, nickname, flow, collected);
    return true;
  }
  if (flow.flowType === 'query') {
    await finishQueryFlow(lineClient, lineEvent, settings, userId, nickname, flow, collected);
    return true;
  }
  // quote 型流程走到這裡，session.bookingId 一定存在——startBookingFlow() 的 quote 分支
  // 一律先建立/接續一筆 bookings 才會進到收集步驟，不會有 quote 型流程沒有 bookingId 的情況。
  // 這筆訂單如果是顧客明確要求「重新報價」重啟出來的（見 restartQuoteFlow），要排除掉它取代
  // 的舊訂單，否則舊單如果還鎖著房，顧客會被自己上一筆訂單擋住，新報價永遠算不出來。
  const { data: bookingRow } = await supabase.from('bookings').select('supersedes_booking_id').eq('id', session.bookingId).maybeSingle();
  const sendReply = (text: string) => lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text }).then(() => {});
  await finishBookingFlow(lineClient, sendReply, settings, userId, nickname, flow, collected, session.bookingId!, false, bookingRow?.supersedes_booking_id ?? null);
  return true;
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
    const { data } = await supabase.from('bookings').select('*')
      .eq('order_number', orderNumber)
      .eq('channel_id', activeChannelId)
      .eq('line_user_id', userId)
      .maybeSingle();
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

// sendReply：正常訂房流程從 webhook 事件呼叫時是 lineClient.replyMessage(lineEvent.replyToken, ...)；
// 候補自動重新試算（見 attemptWaitlistRetry）沒有活著的 LINE 事件可以回覆，改用
// lineClient.pushMessage(userId, ...) 主動推播——抽成參數讓兩邊共用同一套報價/開房/寫入邏輯，
// 不用維護兩份幾乎一樣、只有「怎麼送出訊息」不同的程式碼。
async function finishBookingFlow(
  lineClient: Client,
  sendReply: (text: string) => Promise<void>,
  settings: any,
  userId: string,
  nickname: string | null,
  flow: FlowDef,
  collected: Record<string, string>,
  bookingId: string,
  // 候補自動重新試算（attemptWaitlistRetry）呼叫時傳 true：這次如果還是排不出房，
  // 不要再送出「已排入候補」的訊息、也不要再設新的監看對象——呼叫端會統一處理「放棄候補、
  // 轉真人」的訊息與通知，避免同一次重試對客人送出兩則互相矛盾的訊息（先講「已候補」
  // 又馬上講「放棄候補」）。
  isRetry = false,
  // 這筆報價取代掉的舊訂單（顧客明確要求「重新報價」重啟出來的，見 restartQuoteFlow）。
  // 舊那筆如果還鎖著房，算房間時要排除掉，否則顧客會被自己上一筆訂單擋住。
  supersedesBookingId: string | null = null
) {
  const allFields = flow.steps.flatMap((s) => s.fields);
  const quoteValues: Record<string, string> = {};
  for (const f of allFields) {
    if (f.quote_field && collected[f.key] !== undefined) quoteValues[f.quote_field] = collected[f.key];
  }

  // 報價沒算成功時（資料不齊、日期怪怪的、排不出房…），客人最自然的下一步就是把同一張表單
  // 改一改再送一次。過去這些分支都直接 clearBookingSession()，於是那則重送的表單既沒有進行中的
  // session、內容又不含流程觸發關鍵字（客人常常只回填數值、沒帶「我要訂房」那幾個字），
  // 就會一路掉到最下面的一般 AI 問答，由 AI 自己編一句「我們會幫您確認，稍後回覆您」——
  // 實際上完全沒有建立訂單、也沒有通知任何客服，客人卻以為已經送出了，等於直接掉單。
  // 改成把 session 停在最後一個步驟：客人重送表單就會被當成重新回答那一步，直接重算報價。
  // 沒有再送的話，session 自己會在 30 分鐘後逾時，客人會收到「請重新輸入一次」的提示。
  const keepSessionForRetry = () =>
    saveBookingSession(userId, {
      flowId: flow.id,
      stepIndex: Math.max(0, flow.steps.length - 1),
      collected,
      bookingId,
      phase: 'in_flow',
      quote: null,
    });

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
    await sendReply(replyText);
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
    await keepSessionForRetry();
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
    const replyText = '不好意思，入住日期、退房日期或人數看起來有點對不上，麻煩您重新填一次，或點選「真人客服」由專人為您確認。';
    await sendReply(replyText);
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await keepSessionForRetry();
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
      const replyText = '不好意思，這個日期／人數組合目前無法自動試算（可能是超過可接待人數，或低於最少接待人數），您可以改一下人數或日期再試一次，或點選「真人客服」由專人為您確認房況與價格。';
      await sendReply(replyText);
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      await keepSessionForRetry();
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
      supersedesBookingId,
    });

    // 排不出客人指定的房型組合：默默改成別的房型，客人到現場才發現不對，所以不硬湊，轉成候補。
    // 同時間多人詢問到重疊日期時最常見的就是這個分支——先找出是被哪一筆訂單卡住（watchTarget），
    // 排入候補監看，「排程管理」的候補排程之後會在那筆訂單「有結果」時自動重新試算、主動推播，
    // 不用客人自己再問一次，也不用客服每筆都手動盯著。真的找不到重疊訂單（理論上不太會發生）
    // 才維持原本「已經請真人客服為您確認」的做法，直接轉人工。
    if (openedRooms.shortfall.length) {
      if (isRetry) {
        // 候補重新試算還是排不出來：不送候補訊息、不設新的監看對象，交給 attemptWaitlistRetry
        // 統一判斷要不要放棄候補、怎麼通知客人與客服。
        await supabase.from('bookings').update({ collected_answers: collected, status: 'pending_manual_conflict', updated_at: new Date().toISOString() }).eq('id', bookingId);
        return;
      }

      const watchTarget = await findWaitlistWatchTarget(checkinIso, checkoutIso, bookingId);
      await supabase.from('bookings').update({
        collected_answers: collected,
        status: 'pending_manual_conflict',
        waitlist_blocked_by: watchTarget?.id ?? null,
        updated_at: new Date().toISOString(),
      }).eq('id', bookingId);

      // 報價階段不再鎖房之後，會走到這裡就代表房間是被「已經確認要訂」的訂單佔走的，
      // 不是被別人的報價卡住，所以措辭直接講「已經訂滿」，不要含糊說成「有人也在候位」。
      const replyText = watchTarget
        ? `感謝您提供的資訊！您想預訂 ${toSlashDate(checkinIso)}~${toSlashDate(checkoutIso)}、${headcount}人入住，不過 ${formatOverlapRange(checkinIso, checkoutIso, watchTarget.checkin_date, watchTarget.checkout_date)} 的房間目前已經被訂滿了 🙏\n我們先幫您排入候補，如果這段期間有人取消，會第一時間主動通知您；也歡迎您直接改其他日期讓我們重新試算。`
        : `不好意思，您指定的房型組合目前排不出來（${describeShortfall(openedRooms.shortfall)}），已經請真人客服為您確認實際空房，我們會盡快與您聯繫 🙏`;
      await sendReply(replyText);
      await logConversation(userId, nickname, 'outbound', replyText, 'system');

      for (const id of parseCsvKeywords(settings.agent_user_ids)) {
        try {
          await lineClient.pushMessage(id, {
            type: 'text',
            text: watchTarget
              ? `🕒 房型候補中：【${nickname || '匿名用戶'}】${toSlashDate(checkinIso)}~${toSlashDate(checkoutIso)}，${describeShortfall(openedRooms.shortfall)}，已排入自動候補，等卡住的訂單有結果會自動重新試算並通知客人，不用立即處理。`
              : `⚠️ 房型排不出來：【${nickname || '匿名用戶'}】${toSlashDate(checkinIso)}~${toSlashDate(checkoutIso)}，${describeShortfall(openedRooms.shortfall)}，請人工確認。`,
          });
        } catch {}
      }
      await keepSessionForRetry();
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

    // 是否包棟：這欄以前被寫死成 false。它的語意是「押金要用包棟押金，而不是各房押金加總」，
    // 民宿的預設經營方式就是包棟，所以一律寫 true——不論這次開了幾間房。客服如果遇到少數
    // 單賣個別房間的情況，到「訂單管理」把勾選取消即可。
    //
    // 這一欄刻意不參與「開了哪幾間房」的判斷：實際佔房由 booking_rooms／booking_room_nights
    // 決定（見 fetchOccupiedRoomIds 與 checkBookingConflict），跟這個旗標是兩件事。
    const isWholeHouse = quoteValues.whole_house !== 'false';

    const { data: updatedBooking, error: updateError } = await supabase
      .from('bookings')
      .update({
        name,
        phone,
        checkin_date: checkinIso,
        checkout_date: checkoutIso,
        nights,
        headcount,
        whole_house: isWholeHouse,
        room_amount: amounts.room_amount,
        security_deposit: amounts.security_deposit,
        total_amount: amounts.total_amount,
        deposit: amounts.deposit,
        room_type_label: roomTypeLabel,
        // 2026-08 改版：報價算完（AI 卡片送出的當下）狀態就直接進「待預定」，不用等客人回「是」——
        // 「待預定」現在代表「報價已送出，等客人決定是否要訂」；客人回「是」之後轉成「待確認」
        // （見 handleBookingConfirmation()），等客服核對匯款。顯式寫出來是為了防呆：萬一這張訂單
        // 是重新試算（狀態理論上還是 inquiring），也不會不小心被改壞。
        status: 'awaiting_deposit',
        collected_answers: collected,
        // 候補重試成功走到這裡代表已經不再候補了，清掉監看對象，避免留著一個已經沒意義的舊參照。
        waitlist_blocked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bookingId)
      .select()
      .single();
    if (updateError) throw updateError;

    const quoteVariables = await fetchMessageVariables();
    // 優先用流程自己的報價確認訊息；還沒設定（例如剛升級、欄位是 NULL）就退回 settings 的舊值。
    const quoteMessage = mergeTemplate(flow.quoteMessage ?? settings.booking_quote_message ?? '', {
      ...buildMergeFields(quoteVariables, {
        booking: updatedBooking,
        customer: { nickname, line_user_id: userId },
        settings,
      }),
      ...computeTodayTomorrowFields(),
    });

    await sendReply(quoteMessage);
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
    const replyText = '不好意思，剛剛試算報價時出了一點狀況，麻煩您再送一次，或點選「真人客服」按鈕，我們會盡快為您確認房況與價格。';
    await sendReply(replyText);
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await keepSessionForRetry();
  }
}

// 顧客在等回「是/否」的階段明確回覆「重新報價」：清空目前收集到的資料，同一個流程從第一步
// 重新問一次（不是猜他改了什麼，是整個重來）。
//
// 另外開一筆新訂單，而不是把舊那筆改掉——保留舊單才看得出顧客改過什麼、舊單如果已經收過款
// 也才有帳可對。兩筆的關係記在新單的 supersedes_booking_id：
//   舊單還在「待預定」（報價送出、顧客還沒回是）：沒鎖房也沒收錢，當場就取消，留著沒意義。
//   舊單已經是「待確認」（顧客回過是、可能已匯款）：先留著不動，等新報價被接受時才取消
//     （見 handleBookingConfirmation 的 isYes 分支），否則顧客這次重新報價又回「否」的話，
//     兩筆就都沒了。
// 顧客明確要求重填訂房資訊的指令。報價確認與等匯款兩個階段都認得同一組字，
// 顧客不用記在哪個階段該打哪個字。整句話要以這些字開頭才算，避免「我不想修改」被誤判。
function isRestartCommand(message: string): boolean {
  return /^(修改|重新報價|重新試算|重新算|改訂單|改資料)/i.test(message.trim());
}

// 「是/否」的判定：整句話必須就是那個答案，只允許差在標點與語尾助詞。
//
// 原本是用開頭比對（/^(是|對|好|要|...)/），只要句子開頭一個字命中就算數，結果
// 「好啊但我想改成10/10」「好像有點貴」「要再想一下」全部會被判成同意，當場成立訂單、
// 鎖房、送出匯款帳號。這種話真正的意思是「有其他要求」，該由真人接手處理，AI 不能自作主張——
// 訂單一旦成立就牽涉到房間與金流，寧可多問一句，也不要猜錯方向。
const YES_ANSWERS = new Set(['是', '對', '好', '要', '確定', '沒問題', 'ok', 'okay', 'yes', 'y']);
const NO_ANSWERS = new Set(['否', '不', '不要', '不用', '不需要', '取消', 'no', 'n']);

function normalizeShortAnswer(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[\s。，、；：！？!?~～．.…「」『』()（）]/g, '') // 標點與空白
    .replace(/(的|了|啊|阿|喔|噢|唷|呀|吧|囉|嘍|喲|耶|哦|呦)+$/, ''); // 語尾助詞：「好的」「好啊」都還是「好」
}

// 顧客在等回「是/否」的階段，直接把整組新的訂房資訊丟回來（通常是把報價表單重填一次送出）。
// 以新的為準：取消上一筆報價、開一筆新訂單帶著新資料，跳過收集步驟直接進系統試算。
//
// 刻意要求「流程定義的每一個欄位都解析得到」才算數，只有零星幾個欄位不算——那更可能是顧客在
// 問別的事情（例如「2台車可以停嗎」剛好被抽出一個數字），貿然重算會把他原本那筆報價弄不見。
//
// 回傳 true 代表已經處理掉了（新報價已送出，或試算失敗但也已經回覆顧客），呼叫端不要再回。
async function tryRequoteFromCompleteInfo(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  session: BookingSession
): Promise<boolean> {
  if (!session.bookingId) return false;
  const flow = await fetchFlowById(session.flowId);
  if (!flow || flow.flowType !== 'quote') return false;

  const allFields = flow.steps.flatMap((s) => s.fields);
  if (!allFields.length) return false;

  const extracted =
    flow.replyMode === 'system'
      ? extractStepFieldsWithoutAi(userMessage, allFields)
      : await extractStepFields(settings, userMessage, allFields).catch((e: any) => {
          console.error('[Booking] requote extraction failed:', e.message);
          return {} as Record<string, string>;
        });

  const collected: Record<string, string> = {};
  for (const f of allFields) {
    if (extracted[f.key] === undefined) continue;
    const normalized = normalizeFieldValue(f.value_type, extracted[f.key]);
    if (normalized !== null) collected[f.key] = normalized;
  }

  // 少一個欄位就不算「完整訂房資訊」，交回呼叫端照原本的四選一提示處理。
  if (allFields.some((f) => collected[f.key] === undefined)) return false;

  const { data: oldBooking } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('id', session.bookingId)
    .maybeSingle();

  // 上一筆報價直接作廢（顧客已經給了新內容，舊的沒有保留價值）。它還停在「待預定」，
  // 沒鎖房也沒收錢，取消不會有帳務問題。
  const cancelledNow = !!oldBooking && oldBooking.status === 'awaiting_deposit';
  if (cancelledNow) {
    await supabase.from('bookings').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', oldBooking!.id);
    await saveBookingRooms(oldBooking!.id, []);
  }

  let newBooking: any;
  try {
    newBooking = await insertNewBooking({
      channel_id: activeChannelId,
      line_user_id: userId,
      nickname,
      flow_id: flow.id,
      status: 'inquiring',
      collected_answers: collected,
      // 只有「舊單還活著」才需要記這層取代關係（客服在顧客回覆前手動把訂單往前推過的情況）。
      supersedes_booking_id: oldBooking && !cancelledNow && oldBooking.status !== 'cancelled' ? oldBooking.id : null,
    });
  } catch (e: any) {
    console.error('[Booking] requote insert failed:', e.message);
    return false; // 開不了新單就當作沒處理過，讓呼叫端照原本的邏輯回覆
  }

  const sendReply = (text: string) => lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text }).then(() => {});
  await finishBookingFlow(
    lineClient,
    sendReply,
    settings,
    userId,
    nickname,
    flow,
    collected,
    newBooking.id,
    false,
    oldBooking && !cancelledNow && oldBooking.status !== 'cancelled' ? oldBooking.id : null
  );
  return true;
}

async function restartQuoteFlow(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  session: BookingSession
): Promise<void> {
  const flow = await fetchFlowById(session.flowId);
  const firstStep = flow?.steps.find((s) => s.step_order === 1);
  if (!flow || !firstStep || !session.bookingId) {
    await handoverBrokenFlowSession(lineClient, lineEvent, settings, userId, nickname);
    return;
  }

  const { data: oldBooking } = await supabase
    .from('bookings')
    .select('id, status')
    .eq('id', session.bookingId)
    .maybeSingle();

  // 舊單還沒鎖房也沒收錢：當場取消。已經是待確認的（客服在顧客還沒回覆的期間手動把訂單往前推
  // 過，例如直接改成已預定）就先留著，等新報價被接受再說。
  const cancelledNow = !!oldBooking && oldBooking.status === 'awaiting_deposit';
  if (cancelledNow) {
    await supabase.from('bookings').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', oldBooking!.id);
    await saveBookingRooms(oldBooking!.id, []);
  }

  let newBooking: any;
  try {
    newBooking = await insertNewBooking({
      channel_id: activeChannelId,
      line_user_id: userId,
      nickname,
      flow_id: flow.id,
      status: 'inquiring',
      collected_answers: {},
      // 只有「舊單還活著」才需要記這層取代關係——它等一下要被排除在房況之外，新報價被接受時
      // 也要一併取消。上面剛取消掉的那種不用記：oldBooking.status 是更新前讀到的舊值，
      // 拿它直接比對 'cancelled' 會誤判成還活著，所以用 cancelledNow 判斷實際有沒有取消。
      supersedes_booking_id: oldBooking && !cancelledNow && oldBooking.status !== 'cancelled' ? oldBooking.id : null,
    });
  } catch (e: any) {
    console.error('[Booking] restart quote insert failed:', e.message);
    await handoverBrokenFlowSession(lineClient, lineEvent, settings, userId, nickname);
    return;
  }

  await saveBookingSession(userId, { flowId: flow.id, stepIndex: 0, collected: {}, bookingId: newBooking.id, phase: 'in_flow', quote: null });
  const firstMessage = await renderFlowMessage(firstStep.message_template, settings, userId, nickname, newBooking.id);
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: firstMessage });
  await logConversation(userId, nickname, 'outbound', firstMessage, 'system');
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
  const answer = normalizeShortAnswer(trimmed);
  const isNo = NO_ANSWERS.has(answer);
  const isYes = !isNo && YES_ANSWERS.has(answer);

  // 報價確認送出之後，顧客只能回「是」「否」「真人客服」或「修改／重新報價」——
  // 「真人客服」在更上層（handoverKeywords）就攔截掉了，不會走到這裡。
  if (isRestartCommand(trimmed)) {
    await restartQuoteFlow(lineClient, lineEvent, settings, userId, nickname, session);
    return;
  }

  if (!isYes && !isNo) {
    // 顧客直接把整組新的訂房資訊丟回來（例如整張表單重填一次）：以新的為準，取消上一筆報價、
    // 開一筆新訂單，跳過收集步驟直接進系統試算。刻意要求「解析得出完整資訊」才算——
    // 只有零星幾個欄位的話更可能是他在問別的事，貿然重算會把他原本那筆報價弄不見。
    if (await tryRequoteFromCompleteInfo(lineClient, lineEvent, settings, userId, nickname, userMessage, session)) return;

    // 這句話不是在回答是/否/修改，很可能是客人點了圖文選單之類的自動回覆按鈕，剛好在等
    // 報價回覆的當下觸發了另一個流程的關鍵字——這時候該讓那個自動回覆正常顯示，而不是硬用
    // 「請回是/否」卡住客人（客人根本不知道自己在被問是/否，只會覺得 AI 答非所問）。
    // 一定要排除流程自己：顧客打到自己流程的觸發字（例如「價格」）會拿到一張空白表單，
    // 但 session 還停在等是/否，填完送出又被擋回來，繞不出去。
    // 刻意不呼叫 startBookingFlow()：那會建新訂單、覆蓋掉這筆待確認的 session，讓客人之後
    // 真的回「是」或「否」時已經接不回這筆報價了。這裡只送出對方流程的第一句話當作提示，
    // session 完全不動，原本待確認的報價繼續安靜留著。
    const interruptingFlow = (await fetchActiveFlows()).find((f) => f.id !== session.flowId && matchTriggerRules(trimmed, f.triggerRules));
    const interruptingFirstStep = interruptingFlow?.steps.find((s) => s.step_order === 1);
    if (interruptingFirstStep) {
      const replyText = await renderFlowMessage(interruptingFirstStep.message_template, settings, userId, nickname, null);
      await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
      await logConversation(userId, nickname, 'outbound', replyText, 'system');
      return; // 停留在 awaiting_confirmation，不清 session
    }

    // 走到這裡代表顧客回的既不是是/否/修改，也不是完整的新訂房資訊——最常見的就是
    // 「好啊但我想改成10/10」這種「開頭像同意、實際上另有要求」的句子。AI 不猜他的意思，
    // 只回一句可選項目，同時通知真人接手，由真人判斷他到底要什麼。
    // session 完全不動：真人處理完之後，顧客回「是」還是接得回這筆報價。
    const replyText = '不好意思，這部分我們請專人為您確認，稍後會與您聯繫 🙏\n如果您已經確定，也可以直接回覆「是」訂房、「否」取消，或回覆「修改」重新填寫訂房資訊。';
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    await notifyHandover(
      settings,
      lineClient,
      `🙋 報價確認階段需要人工判斷：【${nickname || '匿名用戶'}】\n顧客回覆：${userMessage}\n（不是單純的是/否/修改，系統沒有自行成立訂單，請人工接手回覆）`
    );
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
  const flow = await fetchFlowById(session.flowId);
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
      // 這裡以前也是寫死 false，等於包棟訂單在確認階段拿不到「跟任何重疊訂單都算衝突」那層保護，
      // 只靠逐間房比對。現在 whole_house 會被正確寫入了（見 finishBookingFlow），照實傳。
      { checkin_date: booking.checkin_date, checkout_date: booking.checkout_date, whole_house: !!booking.whole_house, roomTypeIdsByNight },
      // 這筆訂單如果是「客人改了日期重新報價」產生的，它取代掉的舊訂單等一下就會被取消，
      // 不該把自己的替身當成撞期對象。
      [booking.id, booking.supersedes_booking_id || '']
    );
  } catch (e: any) {
    console.error('[Booking] conflict check failed:', e.message);
  }

  if (hasConflict) {
    // 報價階段不鎖房（見 bookingStatus.ts 的 OCCUPYING_STATUSES），所以兩位客人有可能同時拿到
    // 同一批房的報價；先回「是」的人在這裡把房間鎖走，後回的人就會走到這個分支。
    //
    // 這種情況刻意「不排候補」：客人是在明確要下訂的當下被擋，含糊地說「幫您排候補」會讓他
    // 以為還有機會、繼續空等，不如直接講清楚已經被訂走了，他才能馬上決定要不要改日期。
    // watchTarget 這裡只拿來算出「是哪幾天」被訂走，不寫進 waitlist_blocked_by。
    const watchTarget = await findWaitlistWatchTarget(booking.checkin_date, booking.checkout_date, booking.id);
    // 房間已經被別人拿走，這筆就是訂不成了，直接取消、不留「待人工確認」——留著只會是一筆
    // 永遠不會成立的訂單，而且待人工確認算佔用中，等於用一筆沒訂成的訂單把房間鎖住擋到別人。
    // 報價當下暫時登記的房間也要一併放掉。
    await saveBookingRooms(booking.id, []);
    await supabase.from('bookings').update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    }).eq('id', booking.id);
    await logSystemOperation({
      feature: LOG_FEATURES.lineBooking,
      action: '狀態變更',
      target: booking.order_number || booking.id,
      before: { 訂單狀態: booking.status },
      after: { 訂單狀態: 'cancelled', 說明: '顧客確認訂房時房間已被其他訂單佔用，自動取消' },
    });

    const takenRange = watchTarget
      ? formatOverlapRange(booking.checkin_date, booking.checkout_date, watchTarget.checkin_date, watchTarget.checkout_date)
      : `${toSlashDate(booking.checkin_date)}~${toSlashDate(booking.checkout_date)}`;
    const DEFAULT_TAKEN_MESSAGE = '非常抱歉，[已被預訂日期] 剛剛已經被其他客人預訂走了，這次沒辦法為您保留 🙏\n如果您想改其他日期，直接把新的日期與人數傳給我們就可以重新為您試算，或點選「真人客服」由專人協助您。';
    const replyText = (await renderFlowMessage(flow?.takenMessage || DEFAULT_TAKEN_MESSAGE, settings, userId, nickname, booking.id))
      .split('[已被預訂日期]').join(takenRange);
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    const agentIds = parseCsvKeywords(settings.agent_user_ids);
    for (const id of agentIds) {
      try {
        await lineClient.pushMessage(id, {
          type: 'text',
          text: `⚠️ 檔期被搶先預訂：【${booking.name || nickname || ''}】想確認 ${toSlashDate(booking.checkin_date)}~${toSlashDate(booking.checkout_date)} 訂房，但 ${takenRange} 已被其他客人先行預訂，該筆訂單已自動取消並如實告知客人。如要協助改期請主動跟進。`,
        });
      } catch {}
    }
    await clearBookingSession(userId);
    return;
  }

  // 客戶口頭確認要訂房了，房間鎖定、匯款資訊已送出，但實際匯款尚未核實，所以是「待確認」
  // 不是「已預定」；之後管理員核對到真的收到訂金匯款，要在「訂單管理」手動改成「已預定」並填入匯款末5碼。
  const nowIso = new Date().toISOString();
  // payment_deadline_at 存真實時間戳（跟訊息裡 [匯款日時間] 顯示的是同一個截止時間），
  // 供「排程管理」的自動取消逾期未匯款訂單使用——「訂單自動取消」現在對應的是「待確認」狀態
  // （見 scheduled-tasks-run.ts 的 cancelUnpaidBookings），不是「待預定」，因為「待預定」現在
  // 代表「報價已送出、還在等客人回是否要訂」，客人根本還沒確認要訂，不該被當成逾期未匯款取消。
  await supabase
    .from('bookings')
    .update({ status: 'awaiting_confirmation', reserved_at: nowIso, payment_deadline_at: computePaymentDeadlineDate(settings).toISOString(), updated_at: nowIso })
    .eq('id', booking.id);
  await logSystemOperation({
    feature: LOG_FEATURES.lineBooking,
    action: '狀態變更',
    target: booking.order_number || booking.id,
    before: { 訂單狀態: booking.status },
    after: { 訂單狀態: 'awaiting_confirmation', 說明: '顧客回覆「是」確認訂房' },
  });

  // 這筆是「客人改了日期重新報價」產生的新訂單，而且客人現在確認要訂它了——被它取代的舊訂單
  // 到這一刻才真的可以取消。刻意等到現在才取消，而不是重新報價的當下：舊訂單如果已經是
  // 「待確認」代表客人先前就確認過、甚至可能已經匯款，在新報價還沒被接受之前就先取消掉，
  // 萬一客人最後回「否」，他手上兩筆就都沒了。
  if (booking.supersedes_booking_id) {
    const { data: superseded } = await supabase
      .from('bookings')
      .select('id, order_number, status')
      .eq('id', booking.supersedes_booking_id)
      .maybeSingle();
    if (superseded && superseded.status !== 'cancelled') {
      await supabase.from('bookings').update({ status: 'cancelled', updated_at: nowIso }).eq('id', superseded.id);
      await saveBookingRooms(superseded.id, []);
      await supabase.from('booking_room_nights').delete().eq('booking_id', superseded.id);
      // 舊單有可能已經收過訂金，取消一定要讓客服知道，不能只有系統自己默默改掉。
      for (const id of parseCsvKeywords(settings.agent_user_ids)) {
        try {
          await lineClient.pushMessage(id, {
            type: 'text',
            text: `🔄 客人改期，舊訂單已自動取消：【${booking.name || nickname || ''}】原訂單 ${superseded.order_number || superseded.id}（原狀態：${bookingStatusLabel(superseded.status)}）已被新訂單 ${booking.order_number || ''} 取代。如果舊訂單已經收過款項，請人工確認是否需要退款或轉抵。`,
          });
        } catch {}
      }
    }
  }

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
  Object.assign(confirmFields, computeTodayTomorrowFields());

  // 同報價確認：優先用流程自己的付款確認訊息，沒有才退回 settings 的舊值。
  const confirmMessage = mergeTemplate(flow?.confirmMessage ?? settings.booking_confirm_message ?? '', confirmFields);

  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: confirmMessage });
  await logConversation(userId, nickname, 'outbound', confirmMessage, 'system');

  // 訂房這條路還沒走完——顧客接下來要匯款、回報末五碼，session 留著轉成
  // awaiting_remittance，這樣他之後傳的第一句話（不管是「轉帳成功12345」還是隨便講什麼）
  // 都會被 handleRemittanceReport() 接住，而不是掉進一般 AI 回覆或被當成新的訂房流程開始。
  await saveBookingSession(userId, { ...session, phase: 'awaiting_remittance' });
}

// 預訂單送出之後顧客傳來的第一則訊息。
//
// 這個階段「不做任何自動判定」——文字不再抓連續 5 位數字當末五碼、圖片也不再送視覺模型判讀，
// 一律推播原文給客服人工核對。原本的自動判定誤判率太高：任何含 5 位數字的句子都會成立，
// 「我的電話0912345678」會被抓成末五碼 09123、「總共25000元對嗎」會被抓成 25000，
// 顧客收到「已收到您的匯款回報」、客服還被通知一筆根本不存在的匯款去查帳。
// 匯款金額是真金白銀，寧可每一筆都讓人看一眼，也不要自動放行。
//
// 唯一的例外是顧客回「修改」／「重新報價」：那是明確的指令，直接清空重走報價流程。
//
// 回傳值固定是 true（一定會回覆顧客），保留 boolean 是為了跟 continueBookingFlow 的其他分支一致。
async function handleRemittanceReport(
  lineClient: Client,
  lineEvent: any,
  settings: any,
  userId: string,
  nickname: string | null,
  userMessage: string,
  session: BookingSession,
  isImage = false
): Promise<boolean> {
  // 顧客要改訂房內容：明確指令才算，不猜。清空重走，跟報價確認階段同一套。
  if (!isImage && isRestartCommand(userMessage)) {
    await restartQuoteFlow(lineClient, lineEvent, settings, userId, nickname, session);
    return true;
  }

  const currentFlowId = session.flowId;
  const activeFlows = isImage ? [] : await fetchActiveFlows();

  // 顧客在等匯款的階段打了「這個流程自己」的觸發字（例如「我要訂房」）：那是在開新的一筆，
  // 不是在回報匯款。以前這裡把流程自己排除掉，於是這句話一路掉到下面的「已收到您的訊息」，
  // 系統回了一句像是收到匯款的話、通知客服有一筆待核對（其實沒有），還順手把 session 清掉——
  // 顧客接著送出的訂房資訊就再也沒有 session 可以接住，只能掉到一般 AI 讓它自由發揮。
  //
  // 排除自己原本是為了避免死循環：只把第一步的問句再顯示一次、session 卻沒有前進，
  // 顧客怎麼打都停在原地。正解不是忽略這個意圖，而是真的替他重開一筆——session 會前進到
  // 新訂單的第一步，循環自然不存在。
  //
  // 這樣做不會弄丟他正在付款的那一筆：restartQuoteFlow 只有在舊單還停在「待預定」
  // （沒鎖房也沒收錢）時才當場取消；這個階段的舊單是「待確認」，只會被記成 supersedes，
  // 要等新報價真的被接受才取消。
  const ownFlowTriggered = !isImage && activeFlows.some((f) => f.id === currentFlowId && matchTriggerRules(userMessage, f.triggerRules));
  if (ownFlowTriggered) {
    await restartQuoteFlow(lineClient, lineEvent, settings, userId, nickname, session);
    return true;
  }

  // 客人點了圖文選單之類的按鈕，剛好觸發「別的」流程的關鍵字：讓那個自動回覆正常顯示。
  const interruptingFlow = isImage
    ? undefined
    : activeFlows.find((f) => f.id !== currentFlowId && matchTriggerRules(userMessage, f.triggerRules));
  const interruptingFirstStep = interruptingFlow?.steps.find((s) => s.step_order === 1);
  if (interruptingFirstStep) {
    const replyText = await renderFlowMessage(interruptingFirstStep.message_template, settings, userId, nickname, null);
    await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
    await logConversation(userId, nickname, 'outbound', replyText, 'system');
    return true; // 停留在 awaiting_remittance，不清 session
  }

  const flow = await fetchFlowById(session.flowId);
  const { data: booking } = await supabase
    .from('bookings')
    .select('order_number')
    .eq('id', session.bookingId)
    .maybeSingle();

  const DEFAULT_RECEIVED_MESSAGE = '好的，已收到您的訊息，我們核對後會盡快為您確認訂房，謝謝您的耐心等候 🙏';
  const replyText = await renderFlowMessage(flow?.remittanceReceivedMessage || DEFAULT_RECEIVED_MESSAGE, settings, userId, nickname, session.bookingId);
  await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
  await logConversation(userId, nickname, 'outbound', replyText, 'system');

  // 客服要自己去 LINE 官方帳號看顧客傳了什麼（截圖只能在那邊看），核對到帳後在「訂單管理」
  // 填末五碼、把狀態改成已預定。系統不再代為判讀，也不再自動寫入 remit_last5。
  const orderNumber = booking?.order_number || '';
  const sourceText = isImage ? '內容：顧客傳了一張圖片（請到 LINE 官方帳號查看）' : `原文：${userMessage}`;
  for (const id of parseCsvKeywords(settings.agent_user_ids)) {
    try {
      await lineClient.pushMessage(id, {
        type: 'text',
        text: `💰 待核對匯款：【${nickname || '匿名用戶'}】訂單 ${orderNumber}\n${sourceText}\n請人工核對是否到帳，無誤後至「訂單管理」填寫匯款末五碼並將狀態改為已預定。`,
      });
    } catch {}
  }

  await clearBookingSession(userId);
  return true;
}


// ========================================================================
// 候補自動回報（排程管理的「候補自動配對」排程呼叫 processWaitlist()）
//
// finishBookingFlow／handleBookingConfirmation 排不出房或發現撞期時，除了回覆客人，
// 也會記一筆 waitlist_blocked_by（監看哪一筆訂單）。這裡定期掃描這些候補中的訂單，
// 只要監看對象「有結果」了（不再是佔用中狀態），就重新試算一次、主動推播給客人——
// 只重試這一次，不管成功或還是排不出來，都會清空 waitlist_blocked_by，不會無限重試。
// ========================================================================

async function notifyWaitlistGiveUp(lineClient: Client, settings: any, booking: any, reason: string) {
  for (const id of parseCsvKeywords(settings.agent_user_ids)) {
    try {
      await lineClient.pushMessage(id, {
        type: 'text',
        text: `🔔 候補放棄：【${booking.nickname || booking.name || '匿名用戶'}】訂單 ${booking.order_number || ''} 的自動候補已重試過但仍無法安排（${reason}），請人工確認實際空房並跟客人聯繫。`,
      });
    } catch {}
  }
}

// 單一候補訂單的重新試算。沿用 finishBookingFlow 同一套算價/開房邏輯，只是資料來源
// 從「當下客人打的訊息」改成這筆訂單先前存好的 collected_answers，送出方式也從
// replyMessage 改成 pushMessage——候補排程執行時客人並沒有活著的 LINE 事件可以回覆。
async function attemptWaitlistRetry(booking: any, settings: any, lineClient: Client): Promise<string> {
  const label = booking.order_number || booking.id;
  const flow = booking.flow_id ? await fetchFlowById(booking.flow_id) : null;
  if (!flow) {
    // 流程被刪了，或這筆訂單根本不是動態流程建立的：沒辦法自動重新試算，放棄候補、轉真人。
    await supabase.from('bookings').update({ waitlist_blocked_by: null, updated_at: new Date().toISOString() }).eq('id', booking.id);
    await notifyWaitlistGiveUp(lineClient, settings, booking, '找不到對應的訂房流程，無法自動重新試算');
    return `${label}：找不到對應流程，已放棄候補並通知客服`;
  }

  activeChannelId = booking.channel_id || null;
  const collected = booking.collected_answers || {};
  const sendReply = (text: string) => lineClient.pushMessage(booking.line_user_id, { type: 'text', text }).then(() => {});

  try {
    await finishBookingFlow(lineClient, sendReply, settings, booking.line_user_id, booking.nickname, flow, collected, booking.id, true);
  } catch (e: any) {
    console.error('[Waitlist] retry failed:', e.message);
    return `${label}：候補重試時發生錯誤（${e.message}）`;
  }

  const { data: after } = await supabase.from('bookings').select('status').eq('id', booking.id).maybeSingle();
  if (after?.status === 'pending_manual_conflict') {
    // 重試過還是排不出來：只重試這一次，不繼續無限重試，清空監看對象、轉真人一次性處理。
    await supabase.from('bookings').update({ waitlist_blocked_by: null, updated_at: new Date().toISOString() }).eq('id', booking.id);
    await notifyWaitlistGiveUp(lineClient, settings, booking, '重新試算後這個時段仍然排不出房或有衝突');
    try {
      await lineClient.pushMessage(booking.line_user_id, {
        type: 'text',
        text: '不好意思，重新為您確認後，這個時段目前仍無法安排，已經請真人客服為您確認實際空房狀況，我們會盡快與您聯繫 🙏',
      });
      await logConversation(booking.line_user_id, booking.nickname, 'outbound', '（候補重試仍無法安排，已轉真人）', 'system', booking.channel_id);
    } catch {}
    return `${label}：候補重試仍無法安排，已轉真人`;
  }

  return `${label}：候補重試成功，已推播新報價給客人`;
}

// 掃描所有候補中的訂單，只處理「監看對象已經有結果」的——監看對象不存在了（例如被刪除）
// 也視為有結果，一併觸發重試，避免永遠卡住。同一批一次有多筆準備好重試時，人數較多的優先，
// 讓大團體優先卡到剛釋出的房間。
export async function processWaitlist(): Promise<{ ok: boolean; summary: string }> {
  const settings = await fetchSettings();
  if (!settings) return { ok: false, summary: '讀取系統設定失敗' };

  const customerChannel = await resolveChannel(undefined);
  if (!customerChannel?.channel_access_token) return { ok: false, summary: '找不到客戶用官方帳號憑證，無法推播候補結果' };
  const lineClient = new Client({ channelAccessToken: customerChannel.channel_access_token, channelSecret: customerChannel.channel_secret });

  const { data: waiting, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'pending_manual_conflict')
    .not('waitlist_blocked_by', 'is', null);
  if (error) return { ok: false, summary: `查詢候補名單失敗：${error.message}` };
  if (!waiting || !waiting.length) return { ok: true, summary: '目前沒有候補中的訂單' };

  const blockerIds = [...new Set(waiting.map((b: any) => b.waitlist_blocked_by))];
  const { data: blockers } = await supabase.from('bookings').select('id, status').in('id', blockerIds);
  const blockerStatusById = new Map((blockers || []).map((b: any) => [b.id, b.status]));

  const ready = waiting.filter((b: any) => {
    const blockerStatus = blockerStatusById.get(b.waitlist_blocked_by);
    return blockerStatus === undefined || !OCCUPYING_STATUSES.includes(blockerStatus);
  });
  if (!ready.length) return { ok: true, summary: `${waiting.length} 筆候補中，監看對象都還沒有結果` };

  ready.sort((a: any, b: any) => (b.headcount ?? 0) - (a.headcount ?? 0));

  const results: string[] = [];
  try {
    for (const booking of ready) {
      try {
        results.push(await attemptWaitlistRetry(booking, settings, lineClient));
      } catch (e: any) {
        results.push(`${booking.order_number || booking.id}：候補重試發生未預期錯誤（${e.message}）`);
      }
    }
  } finally {
    // logConversation 等寫入是延後排隊的（deferWrite），平常靠 handler 在 return 前 flush；
    // 這裡是從另一支 function（scheduled-tasks-run.ts）呼叫進來，沒有人會自動幫忙 flush，
    // 容器一凍結這些排隊中的寫入就會被砍掉，一定要在這裡自己收尾。
    await flushPendingWrites();
  }
  return { ok: true, summary: results.join('；') };
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

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」。這支特別重要：webhook 是在沒有人看著的時候被
// LINE 呼叫的，簽章驗不過（401）或處理到一半炸掉（500）時，客人只會感覺到「機器人已讀不回」，
// 沒有這層紀錄根本查不出那則訊息發生了什麼事。回應內容與狀態碼完全不變——LINE 會依狀態碼
// 決定要不要重送，改動它會造成訊息遺失或重複處理。
export const handler: Handler = withErrorLogging(supabase, 'line-webhook', rawHandler);

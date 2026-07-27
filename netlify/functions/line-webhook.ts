import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import crypto from 'crypto';

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
      const handoverKeywords = settings.handover_keywords
        ?.replace(/，/g, ',')
        .split(',')
        .map((k: string) => k.trim())
        .filter((k: string) => k.length > 0) || [];

      const matchedKeyword = handoverKeywords.find((k: string) => {
        if (k.length === 1) return userMessage === k;
        return userMessage.includes(k);
      });

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
      const skipAiKeywords = settings.skip_ai_keywords
        ?.replace(/，/g, ',')
        .split(',')
        .map((k: string) => k.trim())
        .filter((k: string) => k.length > 0) || [];

      if (skipAiKeywords.includes(userMessage)) {
        console.log(`[SkipAI] Message already handled by LINE native auto-reply: ${userMessage}`);
        continue;
      }

      // 4. 真人模式判斷
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
        if (new Date().getTime() - lastInteraction < timeoutMs) continue;
        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
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
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

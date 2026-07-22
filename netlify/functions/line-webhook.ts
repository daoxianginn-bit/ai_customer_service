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

      // 4. 真人模式判斷
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
        if (new Date().getTime() - lastInteraction < timeoutMs) continue;
        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
      }

      // 5. 呼叫 AI（先比對 Google 試算表知識庫意圖，命中則 AI 潤飾固定答案；未命中才走一般 QA）
      if (!settings.is_ai_enabled) continue;

      let aiResult = '';
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

        const matched = knowledgeRows.length ? matchKnowledgeIntent(userMessage, knowledgeRows) : null;

        if (matched) {
          console.log(`[KnowledgeSheet] Intent matched: ${matched.intent || matched.keywords[0]}`);
          aiResult = await answerWithPolish(settings, matched.answer);
        } else {
          const faqContext = buildSheetFaqContext(knowledgeRows);
          if (settings.active_ai === 'gpt') aiResult = (await callGPT(settings, userMessage, faqContext)).text;
          else aiResult = await callGemini(settings, userMessage, faqContext);
        }
      } catch (e: any) {
        aiResult = `❌ AI 錯誤：\n${e.message}`;
      }

      if (aiResult) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult });
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

// ========================================================================
// Google 試算表知識庫（意圖比對 + 一般 QA 資料來源）
// 試算表格式（第一列為標題列，從第二列開始為資料）：
//   A欄：意圖代碼（例如 room_intro，選填，僅供辨識用）
//   B欄：關鍵字（逗號分隔，例如：房型,房型介紹,房間介紹）
//   C欄：回覆內容（AI 會以此為事實依據潤飾語氣後回覆）
// ========================================================================

interface KnowledgeRow {
  intent: string;
  keywords: string[];
  answer: string;
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
    .map((row) => ({
      intent: (row[0] || '').trim(),
      keywords: (row[1] || '')
        .replace(/，/g, ',')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
      answer: (row[2] || '').trim(),
    }))
    .filter((row) => row.keywords.length > 0 && row.answer);
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

function buildSheetFaqContext(rows: KnowledgeRow[]): string {
  if (!rows.length) return '';
  return rows.map((r) => `Q: ${r.keywords.join('、')}\nA: ${r.answer}`).join('\n\n');
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
// AI 呼叫 (GPT / Gemini)
// extraKnowledge：一般 QA fallback 時，把試算表整理成 FAQ 塞進去補強知識庫
// overrideSystemPrompt：意圖命中後的「限定改寫」模式，會完全取代 system_prompt/參考文字/檔案內容
// ========================================================================

async function callGPT(settings: any, currentMessage: string, extraKnowledge?: string, overrideSystemPrompt?: string) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');

  let systemContent: string;
  if (overrideSystemPrompt) {
    systemContent = overrideSystemPrompt;
  } else {
    let fileContent = '';
    if (settings.reference_file_url) {
      try { const r = await fetch(settings.reference_file_url); if (r.ok) fileContent = await r.text(); } catch (e) {}
    }
    systemContent = `${settings.system_prompt}\n\n${extraKnowledge ? `知識庫 FAQ（Google 試算表）：\n${extraKnowledge}\n\n` : ''}參考文字：\n${settings.reference_text}\n\n檔案內容：\n${fileContent}`;
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

async function callGemini(settings: any, currentMessage: string, extraKnowledge?: string, overrideSystemPrompt?: string) {
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
  const userParts: any[] = [{ text: `System: ${settings.system_prompt}\n${extraKnowledge ? `知識庫 FAQ（Google 試算表）：\n${extraKnowledge}\n` : ''}Reference: ${settings.reference_text}` }];
  if (filePart) userParts.push(filePart);
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

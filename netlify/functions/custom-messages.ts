import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import crypto from 'crypto';

// ========================================================================
// 客製訊息發送（訂房設定 > 客製訊息發送）專用 function：
// - list：依入住日期區間，從「報價」試算表查出符合的客人清單
// - quota：查詢 LINE 官方帳號本月訊息額度（用/剩），發送前讓後台先看到還剩多少
// - send：把合併好欄位的訊息，用 push message 實際發送給勾選的客人
//
// 跟 line-webhook.ts 用同一份 LINE 頻道金鑰／Google 服務帳號，但這是「後台主動發起」的動作，
// 所以額外要求呼叫者帶有效的 Supabase 登入 token，避免被匿名呼叫濫用（會員傳訊息會消耗 LINE 免費額度）。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// 單次發送人數上限：同步逐一 push，人太多容易超過 Netlify function 執行時間上限被砍掉，
// 前端跟後端都用這個常數擋，超過就請對方分批送。
const MAX_BATCH_SEND = 50;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return { statusCode: 401, body: JSON.stringify({ error: '登入已過期，請重新整理頁面' }) };

  let body: any;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) };
  }

  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').single();
  if (settingsError || !settings) return { statusCode: 500, body: JSON.stringify({ error: '讀取系統設定失敗' }) };

  try {
    if (body.action === 'quota') {
      const quota = await getLineQuota(settings.line_channel_access_token);
      return { statusCode: 200, body: JSON.stringify(quota) };
    }

    if (body.action === 'list') {
      if (!settings.quote_sheet_id) return { statusCode: 400, body: JSON.stringify({ error: '尚未在「流程設定」設定「報價」試算表' }) };
      const { headers, rows } = await listQuoteSheetRows(settings.quote_sheet_id, settings.quote_sheet_gid || '0', body.startDate, body.endDate);
      return { statusCode: 200, body: JSON.stringify({ headers, rows }) };
    }

    if (body.action === 'send') {
      const recipients: { lineUserId: string; fields: Record<string, string> }[] = Array.isArray(body.recipients) ? body.recipients : [];
      const template: string = body.template || '';
      if (!recipients.length) return { statusCode: 400, body: JSON.stringify({ error: '沒有選擇收件人' }) };
      if (!template.trim()) return { statusCode: 400, body: JSON.stringify({ error: '訊息內容是空的' }) };
      // 同步逐一 push，人數太多容易超過 function 執行時間上限，中途被砍掉會不知道實際送到誰；
      // 分批送，每批數量可控，失敗也只影響一小批，前端也會依這個上限擋住一次選太多人。
      if (recipients.length > MAX_BATCH_SEND) {
        return { statusCode: 400, body: JSON.stringify({ error: `一次最多發送 ${MAX_BATCH_SEND} 位，請分批發送（這次選了 ${recipients.length} 位）` }) };
      }

      const lineClient = new Client({
        channelAccessToken: settings.line_channel_access_token,
        channelSecret: settings.line_channel_secret,
      });

      const results: { lineUserId: string; ok: boolean; error?: string }[] = [];
      for (const r of recipients) {
        const message = mergeTemplate(template, r.fields || {});
        try {
          await lineClient.pushMessage(r.lineUserId, { type: 'text', text: message });
          results.push({ lineUserId: r.lineUserId, ok: true });
        } catch (e: any) {
          results.push({ lineUserId: r.lineUserId, ok: false, error: e.message });
        }
      }
      return { statusCode: 200, body: JSON.stringify({ results }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `未知的 action: ${body.action}` }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || '未知錯誤' }) };
  }
};

function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.split(`[${key}]`).join(value ?? '');
  }
  return result;
}

// ========================================================================
// LINE 訊息額度查詢
// ========================================================================

async function getLineQuota(channelAccessToken: string): Promise<{ limit: number | null; used: number; remaining: number | null }> {
  const headers = { Authorization: `Bearer ${channelAccessToken}` };
  const [quotaRes, consumptionRes] = await Promise.all([
    fetch('https://api.line.me/v2/bot/message/quota', { headers }),
    fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers }),
  ]);
  const quota: any = await quotaRes.json();
  const consumption: any = await consumptionRes.json();
  if (!quotaRes.ok) throw new Error(quota.message || '查詢 LINE 訊息額度失敗');
  const limit = quota.type === 'limited' ? quota.value : null; // null＝無上限（付費方案）
  const used = consumption.totalUsage || 0;
  const remaining = limit == null ? null : Math.max(0, limit - used);
  return { limit, used, remaining };
}

// ========================================================================
// Google 試算表讀取（跟 line-webhook.ts 各自獨立一份，因為 Netlify Functions 各自獨立打包）
// ========================================================================

let tokenCache: { token: string; expiresAt: number } | null = null;

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

// 查詢符合入住日期區間的客人清單，回傳每一列的完整欄位（key 是試算表標題列的欄位名稱），
// 讓前端可以直接拿 LINE_USER_ID／訂房姓名／LINE_NAME 顯示與勾選，也把整列資料留著給發送時當合併欄位用。
async function listQuoteSheetRows(
  sheetId: string,
  gid: string,
  startDate?: string, // YYYY-MM-DD（畫面上的日期輸入格式）
  endDate?: string
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const accessToken = await getGoogleAccessToken();
  const title = await resolveSheetTitle(sheetId, gid, accessToken);

  const headerRange = encodeURIComponent(`${title}!1:1`);
  const headerRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${headerRange}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const headerResult: any = await headerRes.json();
  if (!headerRes.ok || headerResult.error) throw new Error(headerResult.error?.message || '讀取「報價」試算表標題列失敗');
  const headers: string[] = (headerResult.values?.[0] || []).map((h: string) => (h || '').trim());

  const dataRange = encodeURIComponent(`${title}!A2:Z`);
  const dataRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${dataRange}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const dataResult: any = await dataRes.json();
  if (!dataRes.ok || dataResult.error) throw new Error(dataResult.error?.message || '讀取「報價」試算表資料失敗');

  const rows: string[][] = dataResult.values || [];
  const objs = rows
    .filter((r) => r.some((cell) => cell))
    .map((r) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = r[i] ?? '';
      });
      return obj;
    });

  if (!startDate && !endDate) return { headers, rows: objs };

  // 試算表存的是 yyyy/MM/dd，畫面查詢用的是 yyyy-MM-dd，統一換成 yyyy-MM-dd 再比較。
  const toIso = (slashDate: string) => (slashDate || '').replace(/\//g, '-');
  const filtered = objs.filter((o) => {
    const checkinIso = toIso(o['入住日期'] || '');
    if (!checkinIso) return false;
    if (startDate && checkinIso < startDate) return false;
    if (endDate && checkinIso > endDate) return false;
    return true;
  });
  return { headers, rows: filtered };
}

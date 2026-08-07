import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ========================================================================
// 客製訊息發送（客製訊息發送頁）專用 function：
// - list：查詢所有跟 LINE 官方帳號聊過天的聯絡人（不限於有訂房），可依暱稱搜尋，依最近互動時間排序
// - quota：查詢 LINE 官方帳號本月訊息額度（用/剩），發送前讓後台先看到還剩多少
// - send：把合併好欄位的訊息，用 push message 實際發送給勾選的客人
//
// 跟 line-webhook.ts 用同一份 LINE 頻道金鑰，但這是「後台主動發起」的動作，
// 所以額外要求呼叫者帶有效的 Supabase 登入 token，避免被匿名呼叫濫用（會消耗 LINE 免費額度）。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// 單次發送人數上限：同步逐一 push，人太多容易超過 Netlify function 執行時間上限被砍掉，
// 前端跟後端都用這個常數擋，超過就請對方分批送。
const MAX_BATCH_SEND = 50;

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
      const { headers, rows } = await listContacts(body.search);
      return { statusCode: 200, body: JSON.stringify({ headers, rows }) };
    }

    if (body.action === 'send') {
      const recipients: { lineUserId: string; fields: Record<string, string> }[] = Array.isArray(body.recipients) ? body.recipients : [];
      const template: string = body.template || '';
      if (!recipients.length) return { statusCode: 400, body: JSON.stringify({ error: '沒有選擇收件人' }) };
      if (!template.trim()) return { statusCode: 400, body: JSON.stringify({ error: '訊息內容是空的' }) };
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
// 聯絡人清單查詢：以 `user_states`（所有跟 LINE 官方帳號聊過天的人）為主要來源，
// 每位聯絡人再帶入他最近一筆訂房紀錄（如果有）供訊息合併欄位使用。
// ========================================================================

const MAX_CONTACTS = 200; // 避免一次查太多筆，之後若要看更多可以再加分頁

async function listContacts(search?: string): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  let query = supabase
    .from('user_states')
    .select('line_user_id, nickname, last_message_at')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(MAX_CONTACTS);
  if (search && search.trim()) query = query.ilike('nickname', `%${search.trim()}%`);

  const { data: contacts, error } = await query;
  if (error) throw new Error(error.message || '查詢聯絡人清單失敗');

  const userIds = (contacts || []).map((c: any) => c.line_user_id);
  const latestBookingByUser: Record<string, any> = {};
  if (userIds.length) {
    const { data: bookingsData } = await supabase.from('bookings').select('*').in('line_user_id', userIds).order('created_at', { ascending: false });
    for (const b of bookingsData || []) {
      if (!latestBookingByUser[b.line_user_id]) latestBookingByUser[b.line_user_id] = b; // 已依 created_at desc 排序，第一筆遇到的就是最新一筆
    }
  }

  const headers = ['LINE_USER_ID', 'LINE_NAME', '最近互動時間', '訂房姓名', '入住日期', '退房日期', '入住天數', '人數', '大人小孩', '是否包棟', '總金額', '訂金', '狀態'];
  const rows = (contacts || []).map((c: any) => {
    const b = latestBookingByUser[c.line_user_id];
    return {
      LINE_USER_ID: c.line_user_id || '',
      LINE_NAME: c.nickname || '',
      最近互動時間: c.last_message_at ? new Date(c.last_message_at).toLocaleString('zh-TW') : '',
      訂房姓名: b?.name || '',
      入住日期: b?.checkin_date ? String(b.checkin_date).replace(/-/g, '/') : '',
      退房日期: b?.checkout_date ? String(b.checkout_date).replace(/-/g, '/') : '',
      入住天數: b?.nights != null ? String(b.nights) : '',
      人數: b?.headcount != null ? String(b.headcount) : '',
      大人小孩: b ? `${b.adults ?? 0}大${b.kids ?? 0}小${b.infants ? `${b.infants}幼` : ''}` : '',
      是否包棟: b?.whole_house == null ? '' : b.whole_house ? '是' : '否',
      總金額: b?.total_amount != null ? String(b.total_amount) : '',
      訂金: b?.deposit != null ? String(b.deposit) : '',
      狀態: b ? bookingStatusLabel(b.status) : '',
    };
  });

  return { headers, rows };
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

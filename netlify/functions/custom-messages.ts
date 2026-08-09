import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { buildMergeFields, MessageVariable } from '../../src/lib/messageVariables';

// ========================================================================
// 客製訊息發送（客製訊息發送頁）專用 function：
// - list：依關鍵字/入住日期區間/訂單狀態/房型查詢訂單清單
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
      const { variables, rows } = await listOrders(settings, {
        keyword: body.keyword,
        startDate: body.startDate,
        endDate: body.endDate,
        status: body.status,
        roomType: body.roomType,
      });
      return { statusCode: 200, body: JSON.stringify({ variables, rows }) };
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
// 訂單清單查詢：以 `bookings` 為主要來源，供「客製訊息發送」共用的查詢邏輯。
// 每一列同時回傳：
// - 固定的顯示/識別欄位（id/line_user_id/name/checkin_date/...）：table 欄位跟發送對象一定要靠這些穩定
//   的 key 才找得到，不會因為管理員在「訊息變數資料維護」改名/刪除變數而跟著壞掉。
// - fields：依「訊息變數資料維護」目前設定的變數清單，動態算出來的合併欄位（給範本 [變數名稱] 套用）。
// ========================================================================

const MAX_ORDERS = 200; // 避免一次查太多筆，之後若要看更多可以再加分頁

interface OrderFilters {
  keyword?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  roomType?: string;
}

async function fetchMessageVariables(): Promise<MessageVariable[]> {
  const { data } = await supabase.from('message_variables').select('variable_name, source, field_key').order('display_order');
  return (data as MessageVariable[]) || [];
}

async function listOrders(settings: any, filters: OrderFilters): Promise<{ variables: string[]; rows: any[] }> {
  let query = supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(MAX_ORDERS);

  if (filters.startDate) query = query.gte('checkin_date', filters.startDate);
  if (filters.endDate) query = query.lte('checkin_date', filters.endDate);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.roomType === '包棟') query = query.eq('whole_house', true);
  else if (filters.roomType) query = query.ilike('room_type_label', `%${filters.roomType}%`);
  if (filters.keyword && filters.keyword.trim()) {
    const kw = filters.keyword.trim().replace(/[%,()]/g, '');
    query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message || '查詢訂單清單失敗');

  const bookings = data || [];
  const variables = await fetchMessageVariables();

  const userIds = Array.from(new Set(bookings.map((b: any) => b.line_user_id).filter(Boolean)));
  let customerByUser: Record<string, any> = {};
  if (userIds.length) {
    const { data: states } = await supabase.from('user_states').select('line_user_id, nickname, last_message_at, first_message_at').in('line_user_id', userIds);
    for (const s of states || []) customerByUser[s.line_user_id] = s;
  }

  const rows = bookings.map((b: any) => {
    const balanceDue = b.total_amount != null ? b.total_amount - (b.deposit ?? 0) : null;
    const fields = buildMergeFields(variables, {
      booking: b,
      customer: customerByUser[b.line_user_id] || { nickname: b.nickname, line_user_id: b.line_user_id },
      settings,
    });
    return {
      id: b.id,
      line_user_id: b.line_user_id || '',
      order_number: b.order_number || '',
      name: b.name || b.nickname || '',
      checkin_date: b.checkin_date ? String(b.checkin_date).replace(/-/g, '/') : '',
      checkout_date: b.checkout_date ? String(b.checkout_date).replace(/-/g, '/') : '',
      headcount: b.headcount != null ? String(b.headcount) : '',
      room_type_label: b.room_type_label || (b.whole_house ? '包棟' : ''),
      status: b.status,
      total_amount: b.total_amount != null ? String(b.total_amount) : '',
      deposit: b.deposit != null ? String(b.deposit) : '',
      balance_due: balanceDue != null ? String(balanceDue) : '',
      fields,
    };
  });

  return { variables: variables.map((v) => v.variable_name), rows };
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

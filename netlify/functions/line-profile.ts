import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ========================================================================
// 即時查詢單一顧客的 LINE 大頭貼與狀態消息（客戶資料頁「LINE 資訊查詢」用）。
// 只能查得到「已經是官方帳號好友」的用戶，如果對方封鎖/取消好友，LINE 會回錯誤。
// 需要呼叫者帶有效的 Supabase 登入 token，避免被匿名呼叫濫用。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

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

  const lineUserId: string = body.lineUserId || '';
  if (!lineUserId) return { statusCode: 400, body: JSON.stringify({ error: '缺少 lineUserId' }) };

  const { data: settings, error: settingsError } = await supabase.from('settings').select('line_channel_access_token').single();
  if (settingsError || !settings?.line_channel_access_token) return { statusCode: 500, body: JSON.stringify({ error: '尚未設定 LINE Channel Access Token' }) };

  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
      headers: { Authorization: `Bearer ${settings.line_channel_access_token}` },
    });
    const result: any = await res.json();
    if (!res.ok) throw new Error(result.message || '查詢失敗，對方可能已封鎖或取消加入官方帳號好友');
    return {
      statusCode: 200,
      body: JSON.stringify({
        userId: result.userId,
        displayName: result.displayName,
        pictureUrl: result.pictureUrl || '',
        statusMessage: result.statusMessage || '',
        language: result.language || '',
      }),
    };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || '查詢失敗' }) };
  }
};

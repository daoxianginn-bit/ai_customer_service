import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { withErrorLogging } from '../../src/lib/operationLog';

// ========================================================================
// 即時查詢單一顧客的 LINE 大頭貼與狀態消息（客戶資料頁「LINE 資訊查詢」用）。
// 只能查得到「已經是官方帳號好友」的用戶，如果對方封鎖/取消好友，LINE 會回錯誤。
// 需要呼叫者帶有效的 Supabase 登入 token，避免被匿名呼叫濫用。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const rawHandler: Handler = async (event) => {
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

  // 憑證改存 line_channels 之後，要用「這位聯絡人所屬官方帳號」的 token 查——
  // LINE 的 profile API 只查得到自己帳號底下的好友，用錯帳號一律回 404。
  // 前端沒指定 channelId 時退回客戶用帳號（客戶資料頁的主要使用情境）。
  const channelId: string = body.channelId || '';
  let channelQuery = supabase.from('line_channels').select('channel_access_token').eq('is_active', true);
  channelQuery = channelId ? channelQuery.eq('id', channelId) : channelQuery.eq('role', 'customer');
  const { data: channel } = await channelQuery.order('display_order').limit(1).maybeSingle();

  if (!channel?.channel_access_token) {
    return { statusCode: 500, body: JSON.stringify({ error: '找不到對應的 LINE 官方帳號憑證，請至系統設定 → LINE 串接設定確認' }) };
  }

  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
      headers: { Authorization: `Bearer ${channel.channel_access_token}` },
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

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabase, 'line-profile', rawHandler);

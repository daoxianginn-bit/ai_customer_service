import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ========================================================================
// 直接呼叫 LINE API 取得「加官方帳號好友」的使用者清單（不依賴本地資料庫）：
// 1. GET /v2/bot/followers/ids 分頁抓出所有好友的 userId
// 2. 對每個 userId 呼叫 /v2/bot/profile/{userId} 取得暱稱/大頭貼
// 供「客戶資料」頁「LINE 資訊查詢」的聯絡人下拉選單使用，這樣即使本地
// user_states 表是空的（例如尚未重跑最新 schema、或還沒同步過），也能查到
// 已經加好友、聊過天的真實 LINE 使用者。
//
// 限制：LINE 只會回傳「目前尚未封鎖官方帳號」的好友 userId，剛加好友可能有
// 短暫延遲才會出現在清單中；已經封鎖的使用者不會出現。
// 需要呼叫者帶有效的 Supabase 登入 token，避免被匿名呼叫濫用。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// 好友數上限：抓好友清單很快，但逐一查大頭貼要一直打 API，數量太多會超過
// function 執行時間上限被砍掉，所以先抓好友 ID 到這個上限為止。
const MAX_FOLLOWERS = 500;
// 查大頭貼一次併發幾筆，太高容易被 LINE 限流、太低會太慢。
const PROFILE_BATCH_SIZE = 20;

interface FollowerProfile {
  userId: string;
  displayName: string;
  pictureUrl: string;
  statusMessage: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return { statusCode: 401, body: JSON.stringify({ error: '登入已過期，請重新整理頁面' }) };

  const { data: settings, error: settingsError } = await supabase.from('settings').select('line_channel_access_token').single();
  if (settingsError || !settings?.line_channel_access_token) return { statusCode: 500, body: JSON.stringify({ error: '尚未設定 LINE Channel Access Token' }) };

  const authHeaders = { Authorization: `Bearer ${settings.line_channel_access_token}` };

  try {
    // 1. 分頁抓出所有好友 userId
    const userIds: string[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL('https://api.line.me/v2/bot/followers/ids');
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('start', cursor);

      const res = await fetch(url.toString(), { headers: authHeaders });
      const result: any = await res.json();
      if (!res.ok) throw new Error(result.message || '查詢好友清單失敗');

      userIds.push(...(result.userIds || []));
      cursor = result.next;
    } while (cursor && userIds.length < MAX_FOLLOWERS);

    const truncated = userIds.length > MAX_FOLLOWERS;
    const targetIds = userIds.slice(0, MAX_FOLLOWERS);

    // 2. 分批併發查每個人的暱稱/大頭貼；查失敗（例如剛好被封鎖）就跳過，不中斷整批
    const profiles: FollowerProfile[] = [];
    for (let i = 0; i < targetIds.length; i += PROFILE_BATCH_SIZE) {
      const batch = targetIds.slice(i, i + PROFILE_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (userId): Promise<FollowerProfile | null> => {
          try {
            const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers: authHeaders });
            if (!res.ok) return null;
            const p: any = await res.json();
            return {
              userId: p.userId,
              displayName: p.displayName || '',
              pictureUrl: p.pictureUrl || '',
              statusMessage: p.statusMessage || '',
            };
          } catch {
            return null;
          }
        })
      );
      profiles.push(...batchResults.filter((p): p is FollowerProfile => p !== null));
    }

    profiles.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hant'));

    return { statusCode: 200, body: JSON.stringify({ contacts: profiles, totalFollowers: userIds.length, truncated }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || '查詢失敗' }) };
  }
};

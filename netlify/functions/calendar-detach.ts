import { Handler } from '@netlify/functions';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { getGoogleAccessToken, deleteGoogleEvent } from './scheduled-tasks-run';

const supabaseAdmin = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// 刪訂單之前，先把它在 Google 行事曆上的事件收掉。
//
// 【為什麼要獨立一支】
// 事件 ID 存在 bookings.google_event_id，訂單一刪就跟著消失，Google 上那個事件從此
// 沒有任何東西指向它——不會被更新也不會被刪除，就留在行事曆上變成殘影。所以「刪事件」
// 一定要發生在「刪訂單」之前，而刪事件需要服務帳號金鑰，金鑰只能放在後端，前端拿不到。
//
// 【順序不能顛倒】
// 先刪事件、再刪訂單。萬一刪完事件、訂單卻沒刪成功，下一次同步會因為 patch 收到 404
// 而重新建一個事件，自己補回來；反過來先刪訂單的話，事件就永遠沒人認領了。
// 兩種失敗的代價差很多，所以順序是這個設計的重點，不是風格問題。
//
// 【刪不掉的時候不擋訂單刪除】
// Google 掛掉或金鑰過期時，如果連帶讓「刪訂單」整個失敗，等於第三方服務的狀況會卡住
// 日常營運。這裡選擇讓訂單照常刪除，把失敗寫進回應讓呼叫端記錄下來；真的有漏網的，
// 「串接管理 → Google 行事曆 → 檢查行事曆」會把它列出來。
// ========================================================================

export interface DetachResult {
  /** 實際從 Google 刪掉的事件數 */
  removed: number;
  /** 有事件 ID 但沒刪成功的數量 */
  failed: number;
  /** 需要讓人知道的原因（沒設定、授權失敗、個別刪除失敗）；沒有問題時是空字串 */
  note: string;
}

const EMPTY: DetachResult = { removed: 0, failed: 0, note: '' };

/**
 * 把這些訂單對應的 Google 行事曆事件刪掉。沒有事件 ID 的訂單直接略過。
 * 後端的個資清除流程直接呼叫這個函式；前端走下面的 HTTP 端點。
 */
export async function removeCalendarEventsForBookings(client: SupabaseClient, bookingIds: string[]): Promise<DetachResult> {
  if (!bookingIds.length) return EMPTY;

  const { data: rows } = await client
    .from('bookings')
    .select('id, google_event_id')
    .in('id', bookingIds)
    .not('google_event_id', 'is', null);

  const eventIds = (rows || []).map((r: any) => r.google_event_id).filter(Boolean);
  if (!eventIds.length) return EMPTY; // 這批訂單從來沒推上行事曆，沒有殘影問題

  const { data: settings } = await client
    .from('settings')
    .select('google_calendar_id, google_service_account_json')
    .limit(1)
    .maybeSingle();
  const calendarId = settings?.google_calendar_id;
  const serviceAccountJson = settings?.google_service_account_json;
  if (!calendarId || !serviceAccountJson) {
    return { removed: 0, failed: eventIds.length, note: 'Google 行事曆尚未設定，事件沒有被刪除' };
  }

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(serviceAccountJson);
  } catch (e: any) {
    return { removed: 0, failed: eventIds.length, note: `Google 授權失敗，事件沒有被刪除：${e.message}` };
  }

  let removed = 0;
  const errors: string[] = [];
  for (const id of eventIds) {
    try {
      await deleteGoogleEvent(accessToken, calendarId, id);
      removed++;
    } catch (e: any) {
      errors.push(e.message);
    }
  }

  return {
    removed,
    failed: errors.length,
    // 同一種錯誤通常會重複很多次，只留前兩個就足以判斷原因，不要把紀錄塞爆。
    note: errors.length ? `${errors.length} 筆事件刪除失敗：${errors.slice(0, 2).join('；')}` : '',
  };
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: '只接受 POST' }) };

  // 這支只刪 Google 上的事件、不碰資料庫，但它永遠是「要刪訂單」的前一步，
  // 所以要求的就是刪訂單的權限。
  const guard = await requirePermission(supabaseAdmin, event as any, 'booking.delete');
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }

  const bookingIds: string[] = Array.isArray(body.bookingIds) ? body.bookingIds.filter((x: any) => typeof x === 'string') : [];
  if (!bookingIds.length) return { statusCode: 400, body: JSON.stringify({ error: '缺少 bookingIds' }) };

  const result = await removeCalendarEventsForBookings(supabaseAdmin, bookingIds);
  return { statusCode: 200, body: JSON.stringify(result) };
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'calendar-detach', rawHandler);

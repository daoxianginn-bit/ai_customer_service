import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging, writeOperationLog, LOG_FEATURES } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { OCCUPYING_STATUSES } from '../../src/lib/bookingStatus';
import { getGoogleAccessToken, listGoogleEvents, deleteGoogleEvent, type GoogleCalendarEvent } from './scheduled-tasks-run';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// Google 行事曆對帳。
//
// 【為什麼需要這支】
// 推送流程（scheduled-tasks-run.ts 的 pushBookingsToGoogleCalendar）是單向的：照著訂單清單
// 往 Google 寫，寫完把事件 ID 記在 bookings.google_event_id。它從來不回頭看 Google 上實際
// 有什麼。所以只要訂單那一列被整個刪掉，google_event_id 就跟著消失，Google 上那個事件
// 從此沒有任何東西指向它——不會被更新、不會被刪除，就這樣留在行事曆上。
//
// 同一段日期之後若再建一筆訂單（OTA 重新匯入最常見），就會再插一個新事件，畫面上看起來
// 就是「同步出現重複資料」。實際上重複的不是同步，是沒人認領的殘影。
//
// 【怎麼確定只處理我們自己建的事件】
// Google 會回傳每個事件的 creator.email。服務帳號建立的事件，creator 就是金鑰裡那組
// client_email；管理員自己手動加的事件，creator 是他本人的 Google 帳號。只要比對這個欄位，
// 就能百分之百把「系統建的」和「人手動建的」分開，不必猜標題格式。
//
// 【刪除的安全性】
// 前端只能送事件 ID 進來，但這支不會照單全收：每次刪除都重新跑一次完整的比對，只刪
// 「這一刻仍然被判定為孤兒」的那些 ID。前端傳進來的其他 ID 一律拒絕並回報，所以就算
// 請求被竄改，也不可能刪到有訂單對應的事件或管理員自己建的行程。
// ========================================================================

// 比對範圍。訂單推送本身只處理近 180 天內退房的訂單，對帳範圍刻意放得更寬，
// 才看得到更早以前就留下的殘影；往未來放兩年是因為包棟檔期常常提前很久就訂。
const AUDIT_PAST_DAYS = 365;
const AUDIT_FUTURE_DAYS = 730;

// 剛建立或剛改過、還沒輪到排程推送的訂單不算「漏推」。排程預設每 15 分鐘跑一次，
// 抓 20 分鐘留一點緩衝，否則每次對帳都會把正在排隊的訂單列成問題。
const SYNC_GRACE_MINUTES = 20;

interface OrphanEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  created: string | null;
  htmlLink: string | null;
}

interface MissingBooking {
  bookingId: string;
  orderNumber: string | null;
  name: string | null;
  checkin: string;
  checkout: string;
  status: string;
  reason: string;
}

function dayOf(ev: GoogleCalendarEvent, which: 'start' | 'end'): string {
  const slot = ev[which];
  return String(slot?.date || slot?.dateTime || '').slice(0, 10);
}

/**
 * 跑一次完整比對。回傳兩個方向的問題：
 *   orphans  行事曆上有、訂單清單沒有（殘影，就是畫面上看到的重複）
 *   missing  訂單在佔用中、行事曆上卻找不到對應事件（漏推）
 */
async function audit(): Promise<{
  orphans: OrphanEvent[];
  missing: MissingBooking[];
  scannedEvents: number;
  ourEvents: number;
  rangeFrom: string;
  rangeTo: string;
  calendarId: string;
  accessToken: string;
}> {
  const { data: settings } = await supabase
    .from('settings')
    .select('id, google_calendar_id, google_service_account_json')
    .limit(1)
    .maybeSingle();

  const calendarId = settings?.google_calendar_id;
  const serviceAccountJson = settings?.google_service_account_json;
  if (!calendarId || !serviceAccountJson) throw new Error('尚未設定 Google 行事曆 ID 或服務帳號金鑰');

  const accessToken = await getGoogleAccessToken(serviceAccountJson);
  // 金鑰上一行已經解析成功（換得到 token），這裡再取一次 client_email 不會失敗。
  const serviceAccountEmail = String(JSON.parse(serviceAccountJson).client_email || '').trim().toLowerCase();
  if (!serviceAccountEmail) throw new Error('服務帳號金鑰裡沒有 client_email，無法分辨哪些事件是系統建立的');

  const now = Date.now();
  const rangeFrom = new Date(now - AUDIT_PAST_DAYS * 86400000).toISOString().slice(0, 10);
  const rangeTo = new Date(now + AUDIT_FUTURE_DAYS * 86400000).toISOString().slice(0, 10);

  const events = await listGoogleEvents(accessToken, calendarId, `${rangeFrom}T00:00:00Z`, `${rangeTo}T00:00:00Z`);
  const ourEvents = events.filter((ev) => String(ev.creator?.email || '').trim().toLowerCase() === serviceAccountEmail);

  // 所有訂單目前記得的事件 ID。注意不能只看佔用中的訂單——已取消但還沒被同步清掉的訂單
  // 也還記著事件 ID，那種事件有人認領，不是孤兒。
  const { data: linked } = await supabase
    .from('bookings')
    .select('google_event_id')
    .not('google_event_id', 'is', null);
  const claimed = new Set((linked || []).map((b: any) => b.google_event_id));

  const orphans: OrphanEvent[] = ourEvents
    .filter((ev) => !claimed.has(ev.id))
    .map((ev) => ({
      eventId: ev.id,
      summary: ev.summary || '(無標題)',
      start: dayOf(ev, 'start'),
      end: dayOf(ev, 'end'),
      created: ev.created || null,
      htmlLink: ev.htmlLink || null,
    }))
    .sort((a, b) => a.start.localeCompare(b.start));

  // 反方向：訂單在佔用中，行事曆上卻沒有對應事件。
  const liveEventIds = new Set(events.map((ev) => ev.id));
  const graceCutoff = new Date(now - SYNC_GRACE_MINUTES * 60000).toISOString();
  const { data: shouldExist } = await supabase
    .from('bookings')
    .select('id, order_number, name, checkin_date, checkout_date, status, google_event_id, updated_at')
    .in('status', OCCUPYING_STATUSES)
    .not('checkin_date', 'is', null)
    .not('checkout_date', 'is', null)
    .gte('checkout_date', rangeFrom)
    .lte('checkin_date', rangeTo)
    .lt('updated_at', graceCutoff);

  const missing: MissingBooking[] = (shouldExist || [])
    .filter((b: any) => !b.google_event_id || !liveEventIds.has(b.google_event_id))
    .map((b: any) => ({
      bookingId: b.id,
      orderNumber: b.order_number || null,
      name: b.name || null,
      checkin: String(b.checkin_date).slice(0, 10),
      checkout: String(b.checkout_date).slice(0, 10),
      status: b.status,
      reason: b.google_event_id ? '訂單記著的事件在行事曆上已不存在' : '這張訂單還沒有被推送過',
    }))
    .sort((a, b) => a.checkin.localeCompare(b.checkin));

  return { orphans, missing, scannedEvents: events.length, ourEvents: ourEvents.length, rangeFrom, rangeTo, calendarId, accessToken };
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: '只接受 POST' }) };

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }
  const action = body.action === 'delete' ? 'delete' : 'check';

  // 看報告只要「檢視整合設定」，真的要動行事曆才需要「管理整合設定」。
  const guard = await requirePermission(supabase, event as any, action === 'delete' ? 'integration.manage' : 'integration.view');
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };

  let result: Awaited<ReturnType<typeof audit>>;
  try {
    result = await audit();
  } catch (e: any) {
    return { statusCode: 400, body: JSON.stringify({ error: `對帳失敗：${e.message}` }) };
  }

  const report = {
    orphans: result.orphans,
    missing: result.missing,
    scannedEvents: result.scannedEvents,
    ourEvents: result.ourEvents,
    rangeFrom: result.rangeFrom,
    rangeTo: result.rangeTo,
  };

  if (action === 'check') return { statusCode: 200, body: JSON.stringify(report) };

  // ---- 刪除 ----
  const requested: string[] = Array.isArray(body.eventIds) ? body.eventIds.filter((x: any) => typeof x === 'string') : [];
  if (!requested.length) return { statusCode: 400, body: JSON.stringify({ error: '沒有指定要刪除的事件' }) };

  // 只刪「這一刻仍然被判定為孤兒」的。前端送進來的其他 ID 一律拒絕，不是忽略而是回報，
  // 這樣畫面上若真的出現落差（例如期間剛好被同步認領回去），使用者看得到原因。
  const orphanIds = new Set(result.orphans.map((o) => o.eventId));
  const allowed = requested.filter((id) => orphanIds.has(id));
  const rejected = requested.filter((id) => !orphanIds.has(id));

  const deleted: string[] = [];
  const failed: { eventId: string; error: string }[] = [];
  for (const id of allowed) {
    try {
      await deleteGoogleEvent(result.accessToken, result.calendarId, id);
      deleted.push(id);
    } catch (e: any) {
      failed.push({ eventId: id, error: e.message });
    }
  }

  if (deleted.length) {
    const byId = new Map(result.orphans.map((o) => [o.eventId, o]));
    await writeOperationLog(supabase, {
      feature: LOG_FEATURES.calendarSync,
      action: '刪除',
      target: `Google 行事曆殘留事件 ${deleted.length} 筆`,
      actorType: 'user',
      actorName: guard.user.email || guard.user.id,
      before: {
        刪除的事件: deleted
          .map((id) => { const o = byId.get(id); return o ? `${o.start}~${o.end} ${o.summary}` : id; })
          .join('、'),
      },
      after: { 說明: '這些事件在行事曆上沒有對應的訂單（訂單已被刪除），由管理員確認後清除' },
    });
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ...report, deleted: deleted.length, rejected: rejected.length, failed }),
  };
};

export const handler: Handler = withErrorLogging(supabase, 'calendar-audit', rawHandler);

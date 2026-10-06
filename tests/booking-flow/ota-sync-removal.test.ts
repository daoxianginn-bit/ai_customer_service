// 第三方平台同步「什麼時候可以刪訂單」。這一組守的是兩個方向都會出事的那條線：
//   該刪沒刪 → 取消掉的訂單繼續佔房、繼續出現在 Google 行事曆、繼續被算進成本
//   不該刪卻刪 → 已經賣掉的日期被釋出，超賣
// 跑的是真正的 syncOneOtaChannel，只有 Supabase 與抓 iCal 的 fetch 是假的。
import { syncOneOtaChannel } from '../../netlify/functions/scheduled-tasks-run';
import { __db, __reset } from './stubs/supabase';

const checks: [string, boolean, unknown?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const CRLF = '\r\n';
const ics = (...events: string[][]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join(CRLF);

// 沒有設定 Google 行事曆：removeGoogleEventsFor 會直接返回，測試不會去打 Google。
const SETTINGS = { id: 1, google_calendar_id: null, google_service_account_json: null };
const CHANNEL = {
  id: 'ch1', name: 'Trip.com', platform: 'trip',
  import_ics_url: 'https://example.invalid/feed.ics', room_type_id: null, extra_block_keywords: '',
};

const booking = (over: Record<string, unknown> = {}) => ({
  id: 'b1', order_number: 'Trip.com-aaaa1111', status: 'external_synced', booking_source: 'trip',
  external_channel_id: 'ch1', external_uid: 't1', google_event_id: 'gev1',
  checkin_date: '2026-12-01', checkout_date: '2026-12-03', ...over,
});

const EV = (lines: string[]) => lines;
const LIVE = EV(['UID:t1', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261203', 'SUMMARY:Trip.com Booking']);
const CANCELLED = EV([...LIVE, 'STATUS:CANCELLED']);

async function sync(feed: string, bookings: Record<string, unknown>[]) {
  __reset({ bookings, ota_channels: [{ ...CHANNEL }], operation_logs: [], booking_rooms: [] });
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, text: async () => feed });
  const r = await syncOneOtaChannel({ ...CHANNEL }, { ...SETTINGS });
  return { summary: r.summary, remaining: (__db.bookings || []).map((b) => b.id), logs: __db.operation_logs || [] };
}

(async () => {
  // ---- 平台把訂單標成取消，但事件還留在匯出裡（這次回報的情境）
  let r = await sync(ics(CANCELLED), [booking()]);
  t('取消單：訂單被移除', !r.remaining.includes('b1'), r.remaining);
  t('取消單：摘要寫出「平台已取消」', r.summary.includes('平台已取消'), r.summary);
  t('取消單：操作紀錄說明是平台取消，不是「從行事曆消失」',
    r.logs.some((l: any) => l.action === '刪除' && JSON.stringify(l.after || {}).includes('平台已取消')),
    r.logs.map((l: any) => l.after));

  // ---- 還有效的訂單一律不動
  r = await sync(ics(LIVE), [booking()]);
  t('有效訂單：留著', r.remaining.includes('b1'), r.remaining);
  t('有效訂單：不會重複建一筆', r.remaining.length === 1, r.remaining);

  // ---- 取消後立刻重訂同一段日期：以新的為準
  r = await sync(ics(CANCELLED, LIVE), [booking()]);
  t('取消後重訂同一段日期：訂單保留', r.remaining.includes('b1'), r.remaining);

  // ---- 已經住完的
  const past = booking({ id: 'b2', checkin_date: '2020-01-01', checkout_date: '2020-01-03', external_uid: 't2' });
  const PAST_LIVE = EV(['UID:t2', 'DTSTART;VALUE=DATE:20200101', 'DTEND;VALUE=DATE:20200103', 'SUMMARY:Trip.com Booking']);
  r = await sync(ics([...PAST_LIVE, 'STATUS:CANCELLED']), [past]);
  t('住完但被取消：一樣移除（成本統計不能多算一筆沒發生的住宿）', !r.remaining.includes('b2'), r.remaining);

  r = await sync(ics(LIVE), [past]);
  t('住完且沒被取消：feed 不再提它也要留著（那是營運紀錄）', r.remaining.includes('b2'), r.remaining);

  // ---- 未來的房況從 feed 消失 → 平台端取消掉了，要移除
  r = await sync(ics(EV(['UID:zz', 'DTSTART;VALUE=DATE:20270101', 'DTEND;VALUE=DATE:20270102', 'SUMMARY:Trip.com Booking'])), [booking()]);
  t('未來房況從 feed 消失：移除', !r.remaining.includes('b1'), r.remaining);

  // ---- feed 壞掉時一筆都不能刪
  r = await sync(['BEGIN:VCALENDAR', 'END:VCALENDAR'].join(CRLF), [booking()]);
  t('feed 解析不到事件：不刪任何訂單', r.remaining.includes('b1'), r.remaining);
  t('feed 解析不到事件：摘要有警告', r.summary.includes('沒有解析到任何事件'), r.summary);

  // ---- 字面上的「取消」不足以刪單
  r = await sync(ics(EV(['UID:t9', 'DTSTART;VALUE=DATE:20261201', 'DTEND;VALUE=DATE:20261203', 'SUMMARY:Cancelled by guest'])), [booking()]);
  t('只有標題寫 Cancelled：不刪既有訂單（誤判的代價是超賣）', r.remaining.includes('b1'), r.remaining);
  t('只有標題寫 Cancelled：也不會收成新訂單', r.remaining.length === 1, r.remaining);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})();

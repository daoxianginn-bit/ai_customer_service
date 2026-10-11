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

async function sync(feed: string, bookings: Record<string, unknown>[], ignored: Record<string, unknown>[] = []) {
  __reset({ bookings, ota_channels: [{ ...CHANNEL }], operation_logs: [], booking_rooms: [], ota_ignored_ranges: ignored });
  (globalThis as unknown as { fetch: unknown }).fetch = async () => ({ ok: true, status: 200, text: async () => feed });
  const r = await syncOneOtaChannel({ ...CHANNEL }, { ...SETTINGS });
  return {
    summary: r.summary,
    remaining: (__db.bookings || []).map((b) => b.id),
    logs: __db.operation_logs || [],
    ignores: __db.ota_ignored_ranges || [],
  };
}

const ignore = (over: Record<string, unknown> = {}) => ({
  id: 'ig1', channel_id: 'ch1', platform: 'trip',
  checkin_date: '2026-12-01', checkout_date: '2026-12-03', released_at: null, ...over,
});

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

  // ---- 隔離：平台殘留的資料不能再被匯入
  //
  // 實際踩過的坑：把錯的那筆訂單刪掉，平台的 iCal 還留著，下次同步就原封不動再建一筆。
  // 刪除快、平台更新慢，所以隔離必須是「同步時主動忽略」，不是訂單上的旗標。
  r = await sync(ics(LIVE), [], [ignore()]);
  t('隔離中：平台還在吐的那筆不會被重新匯入', r.remaining.length === 0, r.remaining);
  t('隔離中：摘要講出來擋掉了幾筆（不能靜悄悄）', r.summary.includes('已隔離略過'), r.summary);

  // 日期有重疊就忽略（不是完全相同）：平台殘留期間常常把同一筆的日期改來改去
  const SHIFTED = EV(['UID:t5', 'DTSTART;VALUE=DATE:20261202', 'DTEND;VALUE=DATE:20261204', 'SUMMARY:Trip.com Booking']);
  r = await sync(ics(SHIFTED), [], [ignore()]);
  t('隔離中：平台把日期改掉但仍有重疊，照樣擋住', r.remaining.length === 0, r.remaining);

  const APART = EV(['UID:t6', 'DTSTART;VALUE=DATE:20261220', 'DTEND;VALUE=DATE:20261222', 'SUMMARY:Trip.com Booking']);
  r = await sync(ics(APART), [], [ignore()]);
  t('隔離中：完全不重疊的另一段日期照常匯入', r.remaining.length === 1, r.remaining);

  // 自動解除：隔離的壽命＝平台殘留的壽命
  r = await sync(ics(APART), [], [ignore()]);
  t('平台已不再出現那段日期 → 自動解除', !!r.ignores[0]?.released_at, r.ignores);
  t('自動解除會在摘要講出來', r.summary.includes('解除隔離'), r.summary);

  r = await sync(ics(LIVE), [], [ignore()]);
  t('平台還在吐 → 不解除（隔離要繼續擋）', !r.ignores[0]?.released_at, r.ignores);

  r = await sync(ics(LIVE), [], [ignore({ checkin_date: '2020-01-01', checkout_date: '2020-01-03' })]);
  t('退房日已過的隔離自動解除（這張表不該無限長大）', !!r.ignores[0]?.released_at, r.ignores);

  // feed 壞掉時一條都不能解除，否則下次同步那些錯的訂單全部回來
  r = await sync(['BEGIN:VCALENDAR', 'END:VCALENDAR'].join(CRLF), [], [ignore()]);
  t('feed 解析不到事件：隔離一條都不解除', !r.ignores[0]?.released_at, r.ignores);

  // 整份 feed 剛好全部都在隔離中：那是正常狀態，不是抓取失敗
  r = await sync(ics(LIVE), [booking()], [ignore()]);
  t('全部事件都被隔離時不會誤判成「feed 壞掉」', !r.summary.includes('沒有解析到任何事件'), r.summary);
  t('全部事件都被隔離時，既有訂單也不會被當成「來源已消失」而刪掉', r.remaining.includes('b1'), r.remaining);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})();

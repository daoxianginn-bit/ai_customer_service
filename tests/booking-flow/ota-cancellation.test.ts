// 第三方平台 iCal：取消的訂單絕對不能被收進系統，也不能留在房況與 Google 行事曆上。
//
// 這一組的每一條都對應一個「錯了會出事」的情境，而且兩個方向的代價不一樣：
//   收了取消單   → 房況被一筆不存在的訂單鎖住，少賣一晚，而且成本統計多算一筆
//   誤刪真訂單   → 已經賣掉的日期被釋出，超賣，客人到了沒有房間
// 所以「移除」只認平台明講的 STATUS:CANCELLED，字面比對只負責「不收」。
import { parseIcsEvents } from '../../src/lib/icsParser';
import { classifyOtaEvent } from '../../src/lib/otaEventFilter';

const checks: [string, boolean, unknown?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const ics = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flatMap((e) => ['BEGIN:VEVENT', e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');

const ev = (lines: string[]) => lines.join('\r\n');

// ---- 解析器讀得到 STATUS
let parsed = parseIcsEvents(ics(
  ev(['UID:trip-1', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261103', 'SUMMARY:Trip.com Booking', 'STATUS:CANCELLED']),
  ev(['UID:trip-2', 'DTSTART;VALUE=DATE:20261105', 'DTEND;VALUE=DATE:20261106', 'SUMMARY:Trip.com Booking', 'STATUS:CONFIRMED']),
  ev(['UID:trip-3', 'DTSTART;VALUE=DATE:20261108', 'DTEND;VALUE=DATE:20261109', 'SUMMARY:Trip.com Booking']),
));
t('解析得到三筆', parsed.length === 3, parsed.length);
t('STATUS:CANCELLED 讀得到', parsed[0].status === 'CANCELLED', parsed[0]);
t('STATUS:CONFIRMED 讀得到', parsed[1].status === 'CONFIRMED', parsed[1]);
t('沒有 STATUS 時是空字串（不是 undefined）', parsed[2].status === '', parsed[2]);

parsed = parseIcsEvents(ics(ev(['UID:x', 'DTSTART:20261101', 'DTEND:20261103', 'SUMMARY:x', 'status:cancelled'])));
t('屬性名與值大小寫都不影響判讀', parsed[0].status === 'CANCELLED', parsed[0]);

// ---- 分類：取消 ≠ 關房
const classify = (platform: string, lines: string[]) => classifyOtaEvent(platform, parseIcsEvents(ics(ev(lines)))[0]);

const base = ['UID:u', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261103'];
t('Trip 取消單 → cancelled',
  classify('trip', [...base, 'SUMMARY:Trip.com Booking', 'STATUS:CANCELLED']).kind === 'cancelled');
t('Booking 取消單 → cancelled',
  classify('booking', [...base, 'SUMMARY:CLOSED - Reserved', 'STATUS:CANCELLED']).kind === 'cancelled');
t('Agoda 取消單 → cancelled',
  classify('agoda', [...base, 'SUMMARY:Agoda Reservation', 'STATUS:CANCELLED']).kind === 'cancelled');
t('Airbnb 取消單 → cancelled（即使 DESCRIPTION 還留著訂房連結）',
  classify('airbnb', [...base, 'SUMMARY:Reserved', 'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMYSQ5EZ8R', 'STATUS:CANCELLED']).kind === 'cancelled',
  classify('airbnb', [...base, 'SUMMARY:Reserved', 'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMYSQ5EZ8R', 'STATUS:CANCELLED']));
t('取消的原因寫得出來', (classify('trip', [...base, 'SUMMARY:x', 'STATUS:CANCELLED']).blockedReason || '').includes('CANCELLED'));

// ---- 有效訂單不受影響
t('Trip 一般訂單仍然是 reservation',
  classify('trip', [...base, 'SUMMARY:Trip.com Booking']).kind === 'reservation');
t('STATUS:CONFIRMED 仍然是 reservation',
  classify('trip', [...base, 'SUMMARY:Trip.com Booking', 'STATUS:CONFIRMED']).kind === 'reservation');
t('Airbnb 有訂房連結且沒標取消 → reservation，確認碼撈得到', (() => {
  const c = classify('airbnb', [...base, 'SUMMARY:Reserved', 'DESCRIPTION:Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMYSQ5EZ8R']);
  return c.kind === 'reservation' && c.confirmationCode === 'HMYSQ5EZ8R';
})());
t('關房事件仍然是 block（不是 cancelled）',
  classify('trip', [...base, 'SUMMARY:Not available']).kind === 'block');

// ---- 字面上的「取消」：只擋收，不當成取消
t('標題寫 Cancelled 但沒有 STATUS → block（不收為訂單）',
  classify('trip', [...base, 'SUMMARY:Cancelled by guest']).kind === 'block');
t('標題寫「已取消」→ block',
  classify('trip', [...base, 'SUMMARY:已取消的訂單']).kind === 'block');
t('字面取消不會升級成 cancelled（升級＝會刪既有訂單，風險是超賣）',
  classify('trip', [...base, 'SUMMARY:Cancelled by guest']).kind !== 'cancelled');
t('字面取消的理由有提醒要人工確認',
  (classify('trip', [...base, 'SUMMARY:Cancelled by guest']).blockedReason || '').includes('人工確認'));

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

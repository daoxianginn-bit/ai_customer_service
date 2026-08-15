import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { OCCUPYING_STATUSES } from '../../src/lib/bookingStatus';

// ========================================================================
// 訂房行事曆訂閱來源（iCalendar / .ics）
// 取代原本掛在 Google「報價」試算表上的兩支 Apps Script（calendar_sync.gs / timetree_sync.gs）——
// 那兩支是讀試算表產生日曆事件，試算表鏡射功能移除後就沒有資料來源了。這支直接讀 Supabase
// `bookings`，資料來源跟訂單管理／房況行事曆完全一致，不會有「試算表沒同步到」的落差。
//
// Google 日曆／TimeTree／Apple 行事曆都可以「訂閱網址」指向這個網址，不需要 Apps Script、
// 不需要 Google 服務帳號、也不需要試算表。
//
// 權限：行事曆軟體訂閱時沒辦法帶 Authorization 標頭，只能靠網址本身。內容含顧客姓名，
// 不能公開，所以要求網址帶 ?token=，比對 settings.calendar_feed_token。沒設定 token 就整個關閉，
// 避免有人升級後忘了設定、結果變成匿名可讀。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// 只輸出「房間已經鎖定」的訂單（跟房況行事曆／檔期衝突檢查同一套 OCCUPYING_STATUSES），
// 待報價/已報價還沒下訂、以及取消/退款的訂單都不該出現在行事曆上。
const FEED_STATUSES = OCCUPYING_STATUSES;

// 只輸出近期與未來的訂單，避免行事曆檔案無限成長（歷史訂單在訂單管理頁查得到）。
const PAST_WINDOW_DAYS = 180;

function escapeIcsText(value: string): string {
  // RFC 5545：反斜線要先跳脫，否則後面補上的跳脫字元會被二次處理。
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC 5545 規定每行不超過 75 octet，超過要折行（下一行以一個空白開頭）。
// 中文是多位元組字元，必須以「位元組」計算長度、但只能在字元邊界斷開，
// 否則會把一個中文字切成兩半，日曆軟體會顯示成亂碼。
function foldIcsLine(line: string): string {
  const maxOctets = 73; // 留 2 octet 給 CRLF
  const out: string[] = [];
  let current = '';
  let currentOctets = 0;

  for (const char of line) {
    const charOctets = Buffer.byteLength(char, 'utf8');
    if (currentOctets + charOctets > maxOctets) {
      out.push(current);
      current = ' '; // 續行的起始空白本身也算一個 octet
      currentOctets = 1;
    }
    current += char;
    currentOctets += charOctets;
  }
  out.push(current);
  return out.join('\r\n');
}

function toIcsDate(isoDate: string): string {
  return isoDate.slice(0, 10).replace(/-/g, '');
}

function toIcsDateTimeUtc(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

function formatAdultsKids(adults: number | null, kids: number | null, infants: number | null): string {
  const a = adults ?? 0;
  const k = kids ?? 0;
  const i = infants ?? 0;
  return `${a}大${k}小${i > 0 ? `${i}幼` : ''}`;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const { data: settings, error: settingsError } = await supabase
    .from('settings')
    .select('calendar_feed_token')
    .single();
  if (settingsError || !settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const expected = String(settings.calendar_feed_token || '');
  const provided = String(event.queryStringParameters?.token || '');
  // 還沒設定 token＝功能未啟用，一律拒絕（不是「沒設定就放行」）。
  if (!expected || provided !== expected) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  const { data: bookings, error: bookingsError } = await supabase
    .from('bookings')
    .select('id, order_number, name, checkin_date, checkout_date, headcount, adults, kids, infants, whole_house, room_type_label, status, notes')
    .in('status', FEED_STATUSES)
    .gte('checkout_date', isoDaysAgo(PAST_WINDOW_DAYS))
    .not('checkin_date', 'is', null)
    .not('checkout_date', 'is', null)
    .order('checkin_date');
  if (bookingsError) return { statusCode: 500, body: 'Failed to fetch bookings' };

  const stamp = toIcsDateTimeUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//daoxiang//booking-calendar//zh-TW',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:訂房行事曆',
    'X-WR-TIMEZONE:Asia/Taipei',
    // 給日曆軟體的更新頻率建議（實際多久抓一次仍由對方決定，不保證遵守）
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const b of bookings || []) {
    // 全天事件的 DTEND 是「不包含」的，直接用退房日就等於住到退房前一晚，跟原本 Apps Script 一致。
    const summaryParts = [`${b.name || '未填姓名'} ${b.headcount ?? ''}人`.trim()];
    if (b.whole_house) summaryParts.push('·包棟');
    // 「已確認」＝已收尾款（見 bookingStatus.ts），其餘鎖房中的狀態都還沒收齊尾款。
    if (b.status !== 'confirmed') summaryParts.push(' ⚠️尾款未收');
    const summary = summaryParts.join('');

    const descParts = [
      `訂單編號: ${b.order_number || ''}`,
      `大人小孩: ${formatAdultsKids(b.adults, b.kids, b.infants)}`,
    ];
    if (b.room_type_label) descParts.push(`房型: ${b.room_type_label}`);
    if (b.notes) descParts.push(`備註: ${b.notes}`);

    lines.push('BEGIN:VEVENT');
    // UID 用資料庫 id：order_number 可能還沒產生或被改，id 才是真正穩定的識別碼，
    // 不穩定的 UID 會讓日曆每次更新都重建事件（而不是就地更新）。
    lines.push(`UID:${b.id}@daoxiang-booking`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(b.checkin_date)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcsDate(b.checkout_date)}`);
    lines.push(`SUMMARY:${escapeIcsText(summary)}`);
    lines.push(`DESCRIPTION:${escapeIcsText(descParts.join('\n'))}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="booking.ics"',
      'Cache-Control': 'public, max-age=600',
    },
    body: lines.map(foldIcsLine).join('\r\n'),
  };
};

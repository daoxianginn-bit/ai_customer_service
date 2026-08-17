import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { OCCUPYING_STATUSES } from '../../src/lib/bookingStatus';

// ========================================================================
// OTA 平台訂閱（?channel=ota_channels.export_token）：給 Airbnb／Booking.com／Agoda／Trip
// 貼進它們自己的「行事曆同步」設定，讓那些平台知道這裡的房源已經被訂走、避免被重複訂出去。
// 這個方向刻意不帶顧客姓名等個資（平台不需要知道是誰訂的，只需要知道日期被佔用），
// 而且會排除「來源就是這個平台自己」的訂單——不然平台匯出自己剛匯入的訂單、我們又原樣
// 匯出回去，等於自己讀自己，沒有意義。
//
// 給民宿自己看房況的「個人訂閱」已經改用 Google 行事曆同步（主動 push，見
// scheduled-tasks-run.ts 的 sync_calendars 排程），不再需要這支 function 額外撐一份
// ?token= 的訂閱網址功能，settings.calendar_feed_token 欄位保留但不再讀寫。
//
// 權限：訂閱網址沒辦法帶 Authorization 標頭，只能靠網址本身，所以是網址帶 token 比對，
// 找不到頻道／頻道被停用就直接拒絕。
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

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function buildIcsResponse(calName: string, lines: string[]) {
  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//daoxiang//booking-calendar//zh-TW',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${calName}`,
    'X-WR-TIMEZONE:Asia/Taipei',
    // 給日曆軟體的更新頻率建議（實際多久抓一次仍由對方決定，不保證遵守）
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const body = [...header, ...lines, 'END:VCALENDAR'];
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="booking.ics"',
      'Cache-Control': 'public, max-age=600',
    },
    body: body.map(foldIcsLine).join('\r\n'),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const channelToken = event.queryStringParameters?.channel;
  if (!channelToken) return { statusCode: 400, body: 'Missing channel token' };
  return handleOtaChannelFeed(channelToken);
};

async function handleOtaChannelFeed(token: string) {
  const { data: channel, error: channelError } = await supabase
    .from('ota_channels')
    .select('*')
    .eq('export_token', token)
    .eq('is_active', true)
    .maybeSingle();
  if (channelError) return { statusCode: 500, body: 'Failed to fetch channel' };
  if (!channel) return { statusCode: 401, body: 'Unauthorized' };

  let query = supabase
    .from('bookings')
    .select('id, order_number, checkin_date, checkout_date, whole_house, status, booking_source')
    .in('status', FEED_STATUSES)
    // 排除來源就是這個平台自己的訂單——不然平台匯出自己剛匯入的訂單，我們又原樣匯出回去，
    // 形成無意義的自我循環（也可能被平台誤判成同一晚被自己重複佔用）。
    .neq('booking_source', channel.platform)
    .gte('checkout_date', isoDaysAgo(PAST_WINDOW_DAYS))
    .not('checkin_date', 'is', null)
    .not('checkout_date', 'is', null)
    .order('checkin_date');

  const { data: bookings, error: bookingsError } = await query;
  if (bookingsError) return { statusCode: 500, body: 'Failed to fetch bookings' };

  // 這個頻道綁定特定房型時，只輸出「會佔用到那間房」的訂單：包棟一定佔用（佔用所有房間），
  // 個別租房則要查 booking_rooms 這張正式的房間關聯表才知道實際開了哪幾間。
  let relevantIds: Set<string> | null = null;
  if (channel.room_type_id) {
    const { data: roomLinks } = await supabase
      .from('booking_rooms')
      .select('booking_id')
      .eq('room_type_id', channel.room_type_id);
    relevantIds = new Set((roomLinks || []).map((r: any) => r.booking_id));
  }

  const stamp = toIcsDateTimeUtc(new Date());
  const lines: string[] = [];

  for (const b of bookings || []) {
    if (relevantIds && !b.whole_house && !relevantIds.has(b.id)) continue;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${b.id}@daoxiang-booking`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(b.checkin_date)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcsDate(b.checkout_date)}`);
    // 刻意不帶顧客姓名／訂單編號等個資給第三方平台——對方只需要知道日期被佔用，
    // 不需要知道是誰訂的；完整細節現在只會出現在 Google 行事曆同步（sync_calendars 排程）。
    lines.push(`SUMMARY:${escapeIcsText('已預訂 Reserved')}`);
    lines.push('END:VEVENT');
  }

  return buildIcsResponse(`房況同步 - ${channel.name}`, lines);
}

// ========================================================================
// 最小可用的 ICS（iCalendar，RFC 5545）VEVENT 解析器。
//
// 只解析我們實際需要的四個欄位（UID／DTSTART／DTEND／SUMMARY），拿來跟第三方平台
// （Airbnb／Booking.com／Agoda／Trip）匯出的行事曆同步用——那些平台的 iCal 通常只給
// 這幾個欄位，不會有訂房系統的其他細節（房價、房客資料），這也是刻意的隱私限制。
// 不引入外部套件：這個解析範圍夠小，手刻比多一個相依性划算，跟這個專案手刻 ICS
// 「產生」（calendar-feed.ts）用同一套精神。
// ========================================================================

export interface ParsedIcsEvent {
  uid: string;
  startIso: string; // YYYY-MM-DD
  endIso: string; // YYYY-MM-DD（沿用 iCal 全天事件慣例：不含這一天，跟 checkout_date 的語意一致）
  summary: string;
}

// RFC 5545 折行：邏輯上的一行如果太長，會被拆成多行，除了第一行以外，
// 接續行開頭一定是一個空白或 tab——那個開頭字元不是內容的一部分，要先拿掉再接回上一行。
// 來源可能用 CRLF 或單純 LF，兩種都要接受。
function unfoldLines(text: string): string[] {
  const rawLines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      out.push(line);
    }
  }
  return out;
}

// 一行屬性是 "NAME;PARAM=X;PARAM2=Y:VALUE" 或簡單的 "NAME:VALUE"。
// 用第一個冒號切開「名稱＋參數」跟「值」——UID/DTSTART/DTEND/SUMMARY 這幾個欄位的值本身
// 不會包含冒號（不像 URL 類欄位），第一個冒號切開來一定正確。
function parsePropertyLine(line: string): { name: string; params: string; value: string } | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const semiIdx = left.indexOf(';');
  const name = (semiIdx === -1 ? left : left.slice(0, semiIdx)).toUpperCase();
  const params = semiIdx === -1 ? '' : left.slice(semiIdx + 1);
  return { name, params, value };
}

// DTSTART/DTEND 的值可能是：
//   純日期（全天事件）：20260901
//   日期時間：20260901T140000 或 20260901T140000Z
// 兩種都只取前 8 碼當日期，時分秒對「這天房間有沒有被佔用」沒有意義——
// 跟本系統自己的 checkin_date/checkout_date 一樣只存日期，不存時間。
function toDateIso(value: string): string | null {
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  return `${y}-${m}-${d}`;
}

// SUMMARY 等文字欄位的跳脫字元還原：\, \; \\ \n（順序重要，\\ 一定要最後處理，
// 否則會把 "\\," 誤判成先還原成 "\," 又再被 \, 規則吃掉一次）。
function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

export function parseIcsEvents(icsText: string): ParsedIcsEvent[] {
  const lines = unfoldLines(icsText || '');
  const events: ParsedIcsEvent[] = [];

  let inEvent = false;
  let uid = '';
  let startIso = '';
  let endIso = '';
  let summary = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      uid = '';
      startIso = '';
      endIso = '';
      summary = '';
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (inEvent && uid && startIso && endIso) {
        events.push({ uid, startIso, endIso, summary });
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    const prop = parsePropertyLine(line);
    if (!prop) continue;

    if (prop.name === 'UID') uid = prop.value.trim();
    else if (prop.name === 'DTSTART') startIso = toDateIso(prop.value) || '';
    else if (prop.name === 'DTEND') endIso = toDateIso(prop.value) || '';
    else if (prop.name === 'SUMMARY') summary = unescapeIcsText(prop.value.trim());
  }

  return events;
}

function doGet(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('工作表1'); // 改成你的分頁名稱
  const data = sheet.getDataRange().getValues();

  let ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//booking-sync//zh-TW',
    'CALSCALE:GREGORIAN'
  ];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const orderId = row[0];    // A 訂單編號
    const name = row[1];       // B 姓名
    const checkIn = row[2];    // C 入住日期
    const checkOut = row[3];   // D 退房日期
    const people = row[5];     // F 人數
    const detail = row[6];     // G 大人小孩
    const isWhole = row[7];    // H 是否包棟
    const finalPaidDate = row[14]; // O 尾款付款日
    const note = row[15];      // P 備註

    if (!name || !checkIn || !checkOut) continue; // 跳過空白列

    const dtStart = formatDate(checkIn);
    const dtEnd = formatDate(checkOut);

    let summary = `${name} ${people || ''}人`;
    if (isWhole === '是') summary += '·包棟';
    if (!finalPaidDate) summary += ' ⚠️尾款未收';

    const descParts = [
      `訂單編號: ${orderId || ''}`,
      `大人小孩: ${detail || ''}`
    ];
    if (note) descParts.push(`備註: ${note}`);
    const description = descParts.join('\\n');

    ics.push('BEGIN:VEVENT');
    ics.push(`UID:${orderId || Utilities.getUuid()}@booking-sync`);
    ics.push(`DTSTAMP:${formatDateTime(new Date())}`);
    ics.push(`DTSTART;VALUE=DATE:${dtStart}`);
    ics.push(`DTEND;VALUE=DATE:${dtEnd}`);
    ics.push(`SUMMARY:${escapeICS(summary)}`);
    ics.push(`DESCRIPTION:${escapeICS(description)}`);
    ics.push('END:VEVENT');
  }

  ics.push('END:VCALENDAR');

  return ContentService.createTextOutput(ics.join('\r\n'))
    .setMimeType(ContentService.MimeType.ICAL);
}

function formatDate(d) {
  return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyyMMdd');
}
function formatDateTime(d) {
  return Utilities.formatDate(d, 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}
function escapeICS(text) {
  return String(text).replace(/,/g, '\\,').replace(/;/g, '\\;');
}

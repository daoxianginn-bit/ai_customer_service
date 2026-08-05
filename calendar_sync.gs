const CALENDAR_ID = '你的日曆ID@group.calendar.google.com'; // 改成你自己建立的日曆 ID
const SHEET_NAME = '工作表1'; // 改成你的分頁名稱
const EVENT_ID_COL = 19; // S 欄，用來記錄日曆事件 ID，避免重複建立

function syncToCalendar() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const calendar = CalendarApp.getCalendarById(CALENDAR_ID);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const orderId = row[0];        // A 訂單編號
    const name = row[1];           // B 姓名
    const checkIn = row[2];        // C 入住日期
    const checkOut = row[3];       // D 退房日期
    const people = row[5];         // F 人數
    const detail = row[6];         // G 大人小孩
    const isWhole = row[7];        // H 是否包棟
    const finalPaidDate = row[14]; // O 尾款付款日
    const note = row[15];          // P 備註
    const existingEventId = row[EVENT_ID_COL - 1];

    const hasAllColumns = row.slice(0, 14).every(v => v !== '' && v !== null); // A~N 都要有資料
    if (!hasAllColumns) continue; // 跳過資料不齊全的列

    let summary = `${name} ${people || ''}人`;
    if (isWhole === '是') summary += '·包棟';
    if (!finalPaidDate) summary += ' ⚠️尾款未收';

    const descParts = [`訂單編號: ${orderId || ''}`, `大人小孩: ${detail || ''}`];
    if (note) descParts.push(`備註: ${note}`);
    const description = descParts.join('\n');

    const startDate = new Date(checkIn);
    const endDate = new Date(checkOut);

    let event = existingEventId ? calendar.getEventById(existingEventId) : null;

    if (event) {
      event.setTitle(summary);
      event.setDescription(description);
      event.setAllDayDates(startDate, endDate);
    } else {
      event = calendar.createAllDayEvent(summary, startDate, endDate, { description: description });
      sheet.getRange(i + 1, EVENT_ID_COL).setValue(event.getId());
    }
  }
}

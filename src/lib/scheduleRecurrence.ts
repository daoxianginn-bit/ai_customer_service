// ========================================================================
// 排程的「下一次執行時間」計算
//
// Netlify 排程函式的執行間隔是部署時寫死在 netlify.toml 的，後台沒辦法動態改。
// 所以每個排程實際的做法是：後台存的是「這個排程該在什麼時間執行」（next_run_at），
// 一個固定每 15 分鐘跑一次的 ticker 函式（scheduled-tasks-run.ts）負責檢查有哪些排程
// 到期了、執行它、然後呼叫這裡的 computeNextRunAt() 算出下一次時間。
// 排程管理頁的「新增/編輯」畫面也用同一個函式即時預覽下一次執行時間，兩邊才不會算出不同答案。
//
// 全部以台灣時間（UTC+8）為準，不依賴伺服器所在時區、不用任何時區套件——
// 用手動位移 8 小時 + UTC 方法明算，跟 line-webhook.ts 裡 computePaymentDeadline() 等函式同一套手法。
// 台灣沒有日光節約時間，固定位移 8 小時永遠正確。
// ========================================================================

export type Recurrence = 'once' | 'daily' | 'weekly' | 'monthly';

export interface ScheduleConfig {
  recurrence: Recurrence;
  runAtTime: string; // 'HH:MM'，24 小時制，台灣時間
  runAtDate?: string | null; // recurrence='once' 專用，'YYYY-MM-DD'
  weekday?: number | null; // recurrence='weekly' 專用，0=週日...6=週六
  dayOfMonth?: number | null; // recurrence='monthly' 專用，1-31；當月天數不足時自動用該月最後一天
}

const TAIWAN_OFFSET_MS = 8 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

// 把「台灣當地時間的 y/m/d hh:mm」換算成正確的 UTC 時間戳。
// y/m/d/hh/mm 允許超出正常範圍（例如 d=32、m=13），JS 的 Date.UTC 會自動進位，
// 這個特性被拿來實作「明天」「下個月同一天」等算法，不用另外手刻月曆進位邏輯。
function taiwanWallTimeToUtc(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - TAIWAN_OFFSET_MS);
}

// 把任意時間戳換算成台灣當地的年月日時分與星期幾。
function toTaiwanParts(ms: number) {
  const shifted = new Date(ms + TAIWAN_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate(); // 下個月 1 號往前推一天＝這個月最後一天
}

function parseTimeString(timeStr: string): { hh: number; mm: number } {
  const [hh, mm] = (timeStr || '09:00').split(':').map((n) => Number(n) || 0);
  return { hh, mm };
}

/**
 * 算出這個排程下一次該執行的真實時間。fromMs 是「從什麼時間點開始找下一次」，
 * 通常傳現在時間；ticker 執行完一次任務後，也是拿執行當下的時間算下一次。
 * 回傳 null 代表這個排程不會再執行（單次排程、時間已經過去）。
 */
export function computeNextRunAt(cfg: ScheduleConfig, fromMs: number = Date.now()): Date | null {
  const { hh, mm } = parseTimeString(cfg.runAtTime);

  if (cfg.recurrence === 'once') {
    if (!cfg.runAtDate) return null;
    const [y, m, d] = cfg.runAtDate.split('-').map(Number);
    const at = taiwanWallTimeToUtc(y, m, d, hh, mm);
    return at.getTime() > fromMs ? at : null;
  }

  const now = toTaiwanParts(fromMs);

  if (cfg.recurrence === 'daily') {
    let at = taiwanWallTimeToUtc(now.y, now.m, now.d, hh, mm);
    if (at.getTime() <= fromMs) at = taiwanWallTimeToUtc(now.y, now.m, now.d + 1, hh, mm);
    return at;
  }

  if (cfg.recurrence === 'weekly') {
    if (cfg.weekday == null) return null;
    const offset = (cfg.weekday - now.weekday + 7) % 7;
    let at = taiwanWallTimeToUtc(now.y, now.m, now.d + offset, hh, mm);
    if (at.getTime() <= fromMs) at = taiwanWallTimeToUtc(now.y, now.m, now.d + offset + 7, hh, mm);
    return at;
  }

  if (cfg.recurrence === 'monthly') {
    if (cfg.dayOfMonth == null) return null;
    const clampedDay = (y: number, m: number) => Math.min(cfg.dayOfMonth as number, daysInMonth(y, m));
    let at = taiwanWallTimeToUtc(now.y, now.m, clampedDay(now.y, now.m), hh, mm);
    if (at.getTime() <= fromMs) {
      const ny = now.m === 12 ? now.y + 1 : now.y;
      const nm = now.m === 12 ? 1 : now.m + 1;
      at = taiwanWallTimeToUtc(ny, nm, clampedDay(ny, nm), hh, mm);
    }
    return at;
  }

  return null;
}

/** 排程管理頁用的人話描述，例如「每天 09:00」「每週三 09:00」「每月 15 號 09:00」「2026/08/20 09:00 執行一次」。 */
export function describeSchedule(cfg: ScheduleConfig): string {
  const time = (cfg.runAtTime || '09:00').slice(0, 5);
  switch (cfg.recurrence) {
    case 'once':
      return cfg.runAtDate ? `${cfg.runAtDate.replace(/-/g, '/')} ${time} 執行一次` : '尚未設定日期';
    case 'daily':
      return `每天 ${time}`;
    case 'weekly':
      return cfg.weekday != null ? `每${WEEKDAY_LABELS[cfg.weekday]} ${time}` : '尚未設定星期';
    case 'monthly':
      return cfg.dayOfMonth != null ? `每月 ${cfg.dayOfMonth} 號 ${time}（月份天數不足時順延至當月最後一天）` : '尚未設定日期';
    default:
      return '';
  }
}

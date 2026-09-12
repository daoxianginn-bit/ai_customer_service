// ========================================================================
// 全站統一的日期與金額格式（V2 §92–93、§129-7）。各頁不要自己呼叫 toLocaleString。
//
// 日期：台灣慣用 2026/09/20、09/20、2026/09/20 15:30；不混用 2026-09-20 或 Sep 20。
// 金額：NT$ 12,000；表格裡可只放 12,000 但表頭要標明 NT$。
// ========================================================================

const pad = (n: number) => String(n).padStart(2, '0');

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  // 純日期字串（YYYY-MM-DD）當本地日期解析，避免被當成 UTC 而差一天
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 2026/09/20 */
export function formatDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}` : '';
}

/** 09/20（同年份省略年） */
export function formatShortDate(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `${pad(d.getMonth() + 1)}/${pad(d.getDate())}` : formatDate(d);
}

/** 2026/09/20 15:30 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

/** 15:30 */
export function formatTime(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

/** 09/20 → 09/21 */
export function formatDateRange(from: string | null | undefined, to: string | null | undefined): string {
  const a = formatShortDate(from);
  const b = formatShortDate(to);
  if (a && b) return `${a} → ${b}`;
  return a || b || '';
}

/** NT$ 12,000。null／undefined 回空字串，不要顯示 NT$ 0 誤導 */
export function formatMoney(value: number | string | null | undefined, opts: { withCurrency?: boolean } = {}): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const text = Math.round(n).toLocaleString('en-US');
  return opts.withCurrency === false ? text : `NT$ ${text}`;
}

/** 相對時間：剛剛、5 分鐘前、3 小時前、昨天、09/18 */
export function formatRelative(value: string | number | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '剛剛';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  return formatShortDate(d);
}

/** 今天的 YYYY-MM-DD（本地時區），給查詢用 */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysIso(iso: string, days: number): string {
  const d = toDate(iso);
  if (!d) return iso;
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

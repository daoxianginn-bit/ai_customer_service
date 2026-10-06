import { BOOKING_STATUS_OPTIONS } from '../../lib/bookingStatus';
import { computeOrderAmounts } from '../../lib/messageVariables';
import { roomLabel, roomLabels, type RoomOption } from '../../lib/rooms';

// ========================================================================
// 批次新建訂單的貼上內容解析（§批次匯入）。
//
// 【為什麼獨立成一個模組】
// 這裡全是「一段文字 → 一批可以寫進資料庫的訂單」的純轉換，沒有任何畫面或資料庫相依。
// 拆出來才測得動——匯入一次就建好幾十張單，解析錯了是要一筆一筆刪回去的，不能只靠眼睛看。
//
// 【為什麼用標題列對應而不是固定欄位順序】
// 來源是人從 Excel／Google 試算表複製的一整塊，欄位順序每個人每次都不一樣，而且多半只填
// 得出其中幾欄。認標題名稱就不必要求對方先把欄位排成我們要的樣子，也能安全地少填幾欄。
// 代價是標題打錯會整欄讀不到，所以不認得的標題一律回報出來，不默默忽略。
// ========================================================================

export interface BatchColumn {
  /** 標題列要寫的名稱 */
  key: string;
  required?: boolean;
  hint: string;
}

export const BATCH_COLUMNS: BatchColumn[] = [
  { key: '入住日期', required: true, hint: '2026-10-20 或 2026/10/20' },
  { key: '退房日期', required: true, hint: '退房當天，不含這一晚' },
  { key: '狀態', required: true, hint: BOOKING_STATUS_OPTIONS.map((s) => s.label).join('／') },
  { key: '客戶姓名', hint: '' },
  { key: '電話', hint: '' },
  { key: 'LINE暱稱', hint: '' },
  { key: '人數', hint: '整數' },
  { key: '房型', hint: '房間名稱，多間用「、」分隔，例如 暖木、晴空' },
  { key: '包棟', hint: '是／否，留空視為「是」' },
  { key: '房價', hint: '不含押金' },
  { key: '押金', hint: '留空時包棟帶入預設包棟押金，非包棟為 0' },
  { key: '訂單總額', hint: '留空自動算：房價＋押金' },
  { key: '訂金', hint: '留空自動算：房價 × 訂金比例' },
  { key: '匯款末5碼', hint: '' },
  { key: '備註', hint: '' },
];

/** 給「複製範本」按鈕用的標題列，貼到試算表第一列就能照著填。 */
export const BATCH_TEMPLATE_HEADER = BATCH_COLUMNS.map((c) => c.key).join('\t');

// 常見的別名，省得對方為了一個字重打整份標題。
const COLUMN_ALIASES: Record<string, string> = {
  暱稱: 'LINE暱稱',
  LINE名稱: 'LINE暱稱',
  姓名: '客戶姓名',
  客戶: '客戶姓名',
  手機: '電話',
  聯絡電話: '電話',
  入住人數: '人數',
  訂單狀態: '狀態',
  是否包棟: '包棟',
  房間: '房型',
  房號: '房型',
  總額: '訂單總額',
  匯款末五碼: '匯款末5碼',
};

const KNOWN_KEYS = new Set(BATCH_COLUMNS.map((c) => c.key));

/**
 * 認得引號的切欄。不能直接 split(delimiter)：試算表匯出成 CSV 時，含有逗號的值
 * （金額的千分位最常見）會被引號包起來，一刀切下去 "17,000" 會變成 17 跟 000 兩欄，
 * 後面每一欄都跟著錯位，而且錯得很安靜——解析得出數字，只是數字是錯的。
 * 雙引號本身依 RFC4180 以兩個連續引號表示。
 */
function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch !== '"') { cur += ch; continue; }
      if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 標題與儲存格都先正規化再比對：來源是試算表，前後空白與全形空格是常態。 */
function normalizeHeader(raw: string): string {
  return raw.replace(/[\s　]/g, '');
}

function cell(raw: string | undefined): string {
  return (raw ?? '').trim();
}

/** 接受 2026-10-20、2026/10/20、2026.10.20 與個位數月日，一律正規化成 YYYY-MM-DD。 */
export function parseDate(value: string): string | null {
  const m = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // 2026-02-31 這種「格式對、日期不存在」的值要擋下來，否則會被資料庫靜靜地收下或拒絕
  const probe = new Date(`${iso}T00:00:00Z`);
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return iso;
}

/** 數字欄位：空字串代表「沒填」而不是 0，要跟 0 分得開。允許千分位逗號與金額符號。 */
function parseNumber(value: string): number | null | 'invalid' {
  if (!value) return null;
  const cleaned = value.replace(/[,$＄\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return 'invalid';
  return Number(cleaned);
}

const TRUTHY = new Set(['是', 'y', 'yes', 'true', '1', 'v', '✓']);
const FALSY = new Set(['否', 'n', 'no', 'false', '0', '']);

export interface BatchRow {
  /** 貼上內容裡的行號（含標題列），錯誤訊息要指得出是哪一行 */
  lineNo: number;
  payload: Record<string, unknown> | null;
  /** 對應到的房間 id，建單後寫進 booking_rooms，也是算布巾預設用量的依據 */
  roomIds: string[];
  errors: string[];
  display: {
    checkin: string;
    checkout: string;
    name: string;
    statusLabel: string;
    rooms: string;
    nights: number | null;
    total: number | null;
  };
}

export interface BatchParseResult {
  rows: BatchRow[];
  /** 整份內容層級的問題（沒有標題列、缺必填欄位、不認得的欄位） */
  problems: string[];
}

export interface BatchParseOptions {
  depositPercent: number;
  wholeHouseSecurity: number;
  /** 可以指定的房間（room_types 裡 type='房間' 的那些） */
  rooms: RoomOption[];
}

/**
 * 房型欄位 →「這幾間房」。接受純名稱（暖木）或完整標籤（2F_暖木(2人)），多間用「、」分隔，
 * 也容忍逗號、斜線與頓號混用——來源是人打的，分隔符號不會乖乖統一。
 */
function resolveRooms(raw: string, rooms: RoomOption[]): { ids: string[]; unknown: string[] } {
  const wanted = raw.split(/[、,，/／]/).map((s) => s.trim()).filter(Boolean);
  const ids: string[] = [];
  const unknown: string[] = [];
  const key = (s: string) => s.replace(/[\s　]/g, '').toLowerCase();

  for (const w of wanted) {
    const hit = rooms.find((r) => key(r.name) === key(w) || key(roomLabel(r)) === key(w));
    if (!hit) { unknown.push(w); continue; }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, unknown };
}

export function parseBatchBookings(text: string, opts: BatchParseOptions): BatchParseResult {
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx < 0) return { rows: [], problems: ['還沒有貼上任何內容。'] };

  // 從試算表複製出來的是 Tab 分隔；手打或 CSV 檔則是逗號。看標題列有沒有 Tab 就知道。
  const delimiter = lines[firstIdx].includes('\t') ? '\t' : ',';
  const split = (line: string) => splitLine(line, delimiter);

  const headers = split(lines[firstIdx]).map((h) => {
    const norm = normalizeHeader(h);
    return COLUMN_ALIASES[norm] || norm;
  });

  const unknown = headers.filter((h) => h && !KNOWN_KEYS.has(h));
  if (unknown.length) problems.push(`不認得這些欄位，會被忽略：${unknown.join('、')}`);

  for (const col of BATCH_COLUMNS) {
    if (col.required && !headers.includes(col.key)) problems.push(`缺少必填欄位「${col.key}」`);
  }
  if (problems.some((p) => p.startsWith('缺少必填欄位'))) return { rows: [], problems };

  const indexOf = (key: string) => headers.indexOf(key);
  const rows: BatchRow[] = [];

  for (let i = firstIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const cols = split(line);
    const get = (key: string) => {
      const idx = indexOf(key);
      return idx < 0 ? '' : cell(cols[idx]);
    };

    const errors: string[] = [];
    const checkinRaw = get('入住日期');
    const checkoutRaw = get('退房日期');
    const statusRaw = get('狀態');

    const checkin = parseDate(checkinRaw);
    const checkout = parseDate(checkoutRaw);
    if (!checkinRaw) errors.push('入住日期沒有填');
    else if (!checkin) errors.push(`入住日期「${checkinRaw}」看不懂，要像 2026-10-20`);
    if (!checkoutRaw) errors.push('退房日期沒有填');
    else if (!checkout) errors.push(`退房日期「${checkoutRaw}」看不懂，要像 2026-10-21`);
    if (checkin && checkout && checkout <= checkin) errors.push('退房日期必須晚於入住日期');

    const statusOption = BOOKING_STATUS_OPTIONS.find((s) => s.label === statusRaw || s.value === statusRaw);
    if (!statusRaw) errors.push('狀態沒有填');
    else if (!statusOption) errors.push(`狀態「${statusRaw}」不是可以指定的狀態`);

    const wholeHouseRaw = get('包棟').toLowerCase();
    let wholeHouse = true;
    if (wholeHouseRaw && !TRUTHY.has(wholeHouseRaw)) {
      if (FALSY.has(wholeHouseRaw)) wholeHouse = false;
      else errors.push(`包棟「${get('包棟')}」看不懂，請填「是」或「否」`);
    }

    const numeric: Record<string, number | null> = {};
    for (const key of ['人數', '房價', '押金', '訂單總額', '訂金'] as const) {
      const parsed = parseNumber(get(key));
      if (parsed === 'invalid') { errors.push(`${key}「${get(key)}」不是數字`); numeric[key] = null; }
      else numeric[key] = parsed;
    }
    if (numeric['人數'] != null && (!Number.isInteger(numeric['人數']) || numeric['人數'] < 0)) {
      errors.push('人數必須是 0 以上的整數');
    }

    const roomRaw = get('房型');
    const { ids: roomIds, unknown: unknownRooms } = resolveRooms(roomRaw, opts.rooms);
    if (unknownRooms.length) {
      errors.push(`找不到房間「${unknownRooms.join('、')}」，可用的是：${opts.rooms.map((r) => r.name).join('、')}`);
    }
    const pickedRooms = opts.rooms.filter((r) => roomIds.includes(r.id));

    const nights = checkin && checkout
      ? Math.round((Date.parse(`${checkout}T00:00:00Z`) - Date.parse(`${checkin}T00:00:00Z`)) / 86400000)
      : null;

    // 金額的算法跟人工建單同一套（computeOrderAmounts）：押金留空時包棟帶預設包棟押金，
    // 總額＝房價＋押金，訂金＝房價×比例。有填就以填的為準，不要自作主張覆蓋。
    const roomAmount = numeric['房價'];
    // 押金留空時的預設跟人工建單一致：包棟用固定的包棟押金，非包棟是「開了哪幾間房」的押金加總。
    // 沒指定房型的非包棟訂單算不出來，只好是 0——那種單會進「待補布巾數量」佇列由房務補。
    const securityDeposit = numeric['押金'] ?? (wholeHouse
      ? opts.wholeHouseSecurity
      : pickedRooms.reduce((sum, r) => sum + Number(r.security_deposit ?? 0), 0));
    const auto = computeOrderAmounts(roomAmount ?? 0, securityDeposit, opts.depositPercent);
    const totalAmount = numeric['訂單總額'] ?? (roomAmount == null ? null : auto.total_amount);
    const deposit = numeric['訂金'] ?? (roomAmount == null ? null : auto.deposit);

    const payload = errors.length ? null : {
      line_user_id: '',
      name: get('客戶姓名') || null,
      nickname: get('LINE暱稱') || null,
      phone: get('電話') || null,
      checkin_date: checkin,
      checkout_date: checkout,
      headcount: numeric['人數'],
      whole_house: wholeHouse,
      room_amount: roomAmount,
      security_deposit: securityDeposit,
      total_amount: totalAmount,
      deposit,
      remit_last5: get('匯款末5碼') || null,
      status: statusOption!.value,
      // 房型的顯示字串跟人工建單同一個函式，列表、篩選、訊息變數看到的格式才會一致。
      room_type_label: pickedRooms.length ? roomLabels(pickedRooms) : null,
      notes: get('備註') || null,
      updated_at: new Date().toISOString(),
    };

    rows.push({
      lineNo: i + 1,
      payload,
      roomIds,
      errors,
      display: {
        checkin: checkin || checkinRaw,
        checkout: checkout || checkoutRaw,
        name: get('客戶姓名') || get('LINE暱稱') || '(未填姓名)',
        statusLabel: statusOption?.label || statusRaw,
        rooms: pickedRooms.length ? pickedRooms.map((r) => r.name).join('、') : '—',
        nights,
        total: totalAmount,
      },
    });
  }

  if (!rows.length) problems.push('標題列後面沒有任何資料列。');
  return { rows, problems };
}

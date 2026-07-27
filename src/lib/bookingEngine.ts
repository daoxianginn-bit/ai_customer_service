// ============================================================================
// 訂房報價引擎（純函式、無副作用）
//
// 設計原則：日期判斷、定價計算、房型分配全部由程式碼確定性運算，
// 絕對不交給 AI 自由生成——AI 只負責「解析顧客的自然語言輸入」與
// 「把這裡算好的結果包裝成口語化訊息」，避免報價出錯。
// ============================================================================

export interface RoomType {
  id: string;
  name: string;
  floor: string;
  capacity: number;
  max_extra_persons: number; // 最多可加人數（加床，不加開房），0=不支援加人
  display_order: number;
  is_active: boolean;
}

export interface RoomPricing {
  room_type_id: string;
  tier: string;
  price: number | null;
}

export interface RoomExtraPersonPricing {
  room_type_id: string;
  tier: string;
  price: number | null; // 該房型「加人不加房」每人加價
}

export interface WholeHousePackage {
  id: string;
  occupancy: number;
  display_order: number;
}

export interface WholeHousePackagePricing {
  package_id: string;
  tier: string;
  price: number | null;
}

export interface ExtraPersonRule {
  rule_type: string; // 'no_extra_room'（不多開房）/ 'extra_room'（多開房）
  rule_label: string;
  tier: string;
  price: number | null;
}

export interface DateRange {
  range_type: string; // '旺季' / '連假'
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  label?: string;
}

export const TIER_WEEKDAY = '平日';
export const TIER_SEMI_HOLIDAY = '小假日';
export const TIER_CONSECUTIVE_HOLIDAY = '連假';
export const TIER_PEAK_SEASON = '旺季';

function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 判斷某日期落在哪個定價 tier。
 * 優先順序：旺季 > 連假 > 依星期幾（五、六＝小假日，其餘＝平日）。
 */
export function resolvePricingTier(date: Date, dateRanges: DateRange[]): string {
  const dateStr = toDateStr(date);
  const inRange = (type: string) =>
    dateRanges.some((r) => r.range_type === type && dateStr >= r.start_date && dateStr <= r.end_date);

  if (inRange(TIER_PEAK_SEASON)) return TIER_PEAK_SEASON;
  if (inRange(TIER_CONSECUTIVE_HOLIDAY)) return TIER_CONSECUTIVE_HOLIDAY;

  const day = date.getDay(); // 0=Sun ... 6=Sat
  return day === 5 || day === 6 ? TIER_SEMI_HOLIDAY : TIER_WEEKDAY;
}

export type AvailableRoom = RoomType & { price: number; extraPersonPrice: number | null };

/**
 * 找出某 tier 目前開放個別租房的房型。
 * 該 tier 沒有價格資料（room_pricing 沒有這筆、或 price 是 null）＝不開放個別租房，只能包棟。
 * 這是資料驅動設計：後台補上該 tier 的價格，系統就會自動開放個別租房，不需要另外維護開放日曆。
 * 一併帶入該房型「加人不加房」的加價（沒有資料就是 null，代表這個 tier 該房型不能加人）。
 */
export function getAvailableIndividualRooms(
  tier: string,
  roomTypes: RoomType[],
  roomPricing: RoomPricing[],
  roomExtraPersonPricing: RoomExtraPersonPricing[] = []
): AvailableRoom[] {
  const rooms: AvailableRoom[] = [];
  for (const r of roomTypes) {
    if (!r.is_active) continue;
    const pricing = roomPricing.find((p) => p.room_type_id === r.id && p.tier === tier);
    if (pricing && pricing.price != null) {
      const extraPricing = roomExtraPersonPricing.find((p) => p.room_type_id === r.id && p.tier === tier);
      rooms.push({ ...r, price: pricing.price, extraPersonPrice: extraPricing?.price ?? null });
    }
  }
  return rooms.sort((a, b) => b.capacity - a.capacity || a.display_order - b.display_order);
}

/**
 * 共用的貪婪分配演算法：優先用容量 <= 剩餘人數中最大的項目去塞，
 * 塞不下時用剩下最小的項目補齊（會有空位，但至少能容納）。
 * 傳入的 items 必須已排序：capacity desc, display_order asc。
 */
function greedyPack<T extends { capacity: number }>(headcount: number, items: T[]): { items: T[]; success: boolean } {
  const pool = [...items];
  const assigned: T[] = [];
  let remaining = headcount;

  while (remaining > 0 && pool.length > 0) {
    let idx = pool.findIndex((r) => r.capacity <= remaining);
    if (idx === -1) idx = pool.length - 1; // 沒有完全塞得下的項目，用剩下最小的補齊
    const item = pool.splice(idx, 1)[0];
    assigned.push(item);
    remaining -= item.capacity;
  }

  return { items: assigned, success: remaining <= 0 };
}

export interface RoomAllocationResult {
  success: boolean; // false = 可用房型的總容納人數不足以容納顧客人數
  rooms: AvailableRoom[];
  totalCapacity: number;
  totalPrice: number;
}

/**
 * 分配房型並計算價格（「加開房」選項）：只能用在已依 tier 篩出「有定價」的房型清單（AvailableRoom，含 price）。
 * 資料驅動、房型增減不需要改邏輯，會自動反映在分配結果。
 */
export function allocateIndividualRooms(headcount: number, availableRooms: AvailableRoom[]): RoomAllocationResult {
  const { items: assigned, success } = greedyPack(headcount, availableRooms);
  return {
    success,
    rooms: assigned,
    totalCapacity: assigned.reduce((s, r) => s + r.capacity, 0),
    totalPrice: assigned.reduce((s, r) => s + r.price, 0),
  };
}

export interface ExtraPersonRoomAssignment {
  room: AvailableRoom;
  extraCount: number;
  extraPrice: number; // 這間房加人的總加價（extraCount × 每人加價）
}

export interface IndividualExtraPersonOption {
  baseRooms: AvailableRoom[]; // 用到的房間（比「加開房」選項少一間）
  extraAssignments: ExtraPersonRoomAssignment[];
  totalPrice: number;
}

/**
 * 「加人不加房」選項：把「加開房」選項裡最後（最小）一間房拿掉，
 * 改把差額人數以加人方式塞進其餘已選房間（優先用加人單價最低的房間），
 * 若已選房間的加人名額不夠塞下差額，代表這個選項不成立（回傳 null）。
 * 只嘗試拿掉最後一間房，不做窮舉最佳化——對應「一堆人剛好多 1、2 位」這種最常見的情境。
 */
function tryExtraPersonAlternative(headcount: number, openRoomRooms: AvailableRoom[]): IndividualExtraPersonOption | null {
  if (openRoomRooms.length < 2) return null; // 只有一間房就沒有「少開一間」的空間

  const baseRooms = openRoomRooms.slice(0, -1);
  const covered = baseRooms.reduce((s, r) => s + r.capacity, 0);
  const shortfall = headcount - covered;
  if (shortfall <= 0) return null;

  const candidates = baseRooms
    .filter((r) => r.extraPersonPrice != null && r.max_extra_persons > 0)
    .sort((a, b) => (a.extraPersonPrice as number) - (b.extraPersonPrice as number));

  let remaining = shortfall;
  const extraAssignments: ExtraPersonRoomAssignment[] = [];
  for (const room of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(room.max_extra_persons, remaining);
    if (take <= 0) continue;
    extraAssignments.push({ room, extraCount: take, extraPrice: (room.extraPersonPrice as number) * take });
    remaining -= take;
  }
  if (remaining > 0) return null; // 加人名額不足以覆蓋差額，這個選項不成立

  const baseTotal = baseRooms.reduce((s, r) => s + r.price, 0);
  const extraTotal = extraAssignments.reduce((s, a) => s + a.extraPrice, 0);
  return { baseRooms, extraAssignments, totalPrice: baseTotal + extraTotal };
}

export interface IndividualOptions {
  openRoomOption: RoomAllocationResult; // 加開房
  extraPersonOption: IndividualExtraPersonOption | null; // 加人不加房，null＝不適用（房間數不足 2 間，或加人名額不夠）
}

/**
 * 統整個別租房的兩種選項：加開房、加人不加房，交給對話流程呈現給顧客選擇。
 */
export function computeIndividualOptions(headcount: number, availableRooms: AvailableRoom[]): IndividualOptions {
  const openRoomOption = allocateIndividualRooms(headcount, availableRooms);
  const extraPersonOption = openRoomOption.success ? tryExtraPersonAlternative(headcount, openRoomOption.rooms) : null;
  return { openRoomOption, extraPersonOption };
}

/**
 * 自動建議包棟方案的房型組合：用同一套貪婪演算法，但對象是全部啟用中的房型（不受 tier 定價限制），
 * 純粹用來在後台「新增包棟方案」時，依動人數自動勾好建議組合，管理者仍可手動調整勾選。
 */
export function suggestRoomCombo(occupancy: number, roomTypes: RoomType[]): RoomType[] {
  const pool = roomTypes
    .filter((r) => r.is_active)
    .sort((a, b) => b.capacity - a.capacity || a.display_order - b.display_order);
  return greedyPack(occupancy, pool).items;
}

export interface ExtraPersonOption {
  rule_type: string;
  rule_label: string;
  unitPrice: number;
  totalPrice: number;
  grandTotal: number;
}

export interface WholeHouseQuote {
  package: WholeHousePackage;
  basePrice: number;
  extraPersons: number;
  extraPersonOptions: ExtraPersonOption[]; // 空陣列＝不需要加人（人數 <= 方案基礎人數）
}

/**
 * 選擇包棟方案：取「基礎人數 <= 需求人數」中最大的級距為基礎，差額用加人規則計算。
 * 若需求人數小於最小級距，仍以最小級距的價格為基礎（視為最低消費）。
 * 加人規則有多種（不多開房／多開房）時全部回傳，交由對話流程詢問顧客要選哪一種。
 */
export function selectWholeHousePackage(
  headcount: number,
  packages: WholeHousePackage[],
  packagePricing: WholeHousePackagePricing[],
  extraPersonRules: ExtraPersonRule[],
  tier: string,
  maxOccupancy: number
): WholeHouseQuote | null {
  if (headcount > maxOccupancy || !packages.length) return null;

  const sortedAsc = [...packages].sort((a, b) => a.occupancy - b.occupancy);
  const eligible = sortedAsc.filter((p) => p.occupancy <= headcount).sort((a, b) => b.occupancy - a.occupancy);
  const base = eligible[0] || sortedAsc[0]; // 需求人數小於最小級距時，用最小級距當最低消費基礎

  const basePricing = packagePricing.find((p) => p.package_id === base.id && p.tier === tier);
  if (!basePricing || basePricing.price == null) return null; // 該 tier 沒有包棟價格資料

  const basePrice = basePricing.price;
  const extraPersons = Math.max(0, headcount - base.occupancy);

  const extraPersonOptions: ExtraPersonOption[] =
    extraPersons > 0
      ? extraPersonRules
          .filter((r) => r.tier === tier && r.price != null)
          .map((r) => {
            const unitPrice = r.price as number;
            const totalPrice = unitPrice * extraPersons;
            return {
              rule_type: r.rule_type,
              rule_label: r.rule_label,
              unitPrice,
              totalPrice,
              grandTotal: basePrice + totalPrice,
            };
          })
      : [];

  return { package: base, basePrice, extraPersons, extraPersonOptions };
}

export interface QuoteInput {
  date: Date;
  headcount: number;
  dateRanges: DateRange[];
  roomTypes: RoomType[];
  roomPricing: RoomPricing[];
  roomExtraPersonPricing: RoomExtraPersonPricing[];
  packages: WholeHousePackage[];
  packagePricing: WholeHousePackagePricing[];
  extraPersonRules: ExtraPersonRule[];
  maxOccupancy: number;
}

export interface Recommendation {
  recommended: 'individual' | 'wholeHouse' | null; // null＝兩者都無法報價，或價格剛好一樣
  savings: number | null; // 選擇 recommended 那個選項，比另一個選項省下多少錢
}

function cheapestIndividualTotal(individualOption: IndividualOptions | null): number | null {
  if (!individualOption) return null;
  const openTotal = individualOption.openRoomOption.success ? individualOption.openRoomOption.totalPrice : null;
  const extraTotal = individualOption.extraPersonOption?.totalPrice ?? null;
  if (openTotal == null) return extraTotal;
  if (extraTotal == null) return openTotal;
  return Math.min(openTotal, extraTotal);
}

/**
 * 自動比較「個別租房」與「包棟」兩種選項，算出比較划算的一方跟省下多少錢。
 * 不需要管理者設定任何比較規則——單純的資料比較，兩邊都沒資料時無法比較。
 * 個別租房若有加開房／加人不加房兩種選項，包棟若有多種加人選項，比較時都取各自最便宜的那個。
 */
export function compareOptions(
  individualOption: IndividualOptions | null,
  wholeHouseOption: WholeHouseQuote | null
): Recommendation {
  const individualTotal = cheapestIndividualTotal(individualOption);
  const wholeHouseTotal = wholeHouseOption
    ? wholeHouseOption.extraPersonOptions.length
      ? Math.min(...wholeHouseOption.extraPersonOptions.map((o) => o.grandTotal))
      : wholeHouseOption.basePrice
    : null;

  if (individualTotal == null && wholeHouseTotal == null) return { recommended: null, savings: null };
  if (individualTotal == null) return { recommended: 'wholeHouse', savings: null };
  if (wholeHouseTotal == null) return { recommended: 'individual', savings: null };

  const diff = individualTotal - wholeHouseTotal;
  if (diff > 0) return { recommended: 'wholeHouse', savings: diff };
  if (diff < 0) return { recommended: 'individual', savings: -diff };
  return { recommended: null, savings: 0 };
}

export interface QuoteResult {
  date: Date;
  tier: string;
  headcount: number;
  individualOption: IndividualOptions | null; // null＝該 tier 不開放個別租房，只能包棟
  wholeHouseOption: WholeHouseQuote | null; // null＝沒有對應的包棟報價資料，或超過最大接待人數
  recommendation: Recommendation;
}

/**
 * 統整報價：同時算出「個別租房」與「包棟」兩種選項，並自動比較出推薦選項與省多少錢，
 * 交給對話流程呈現給顧客選擇。
 */
export function computeQuote(input: QuoteInput): QuoteResult {
  const tier = resolvePricingTier(input.date, input.dateRanges);
  const availableRooms = getAvailableIndividualRooms(tier, input.roomTypes, input.roomPricing, input.roomExtraPersonPricing);
  const individualOption = availableRooms.length ? computeIndividualOptions(input.headcount, availableRooms) : null;
  const wholeHouseOption = selectWholeHousePackage(
    input.headcount,
    input.packages,
    input.packagePricing,
    input.extraPersonRules,
    tier,
    input.maxOccupancy
  );
  const recommendation = compareOptions(individualOption, wholeHouseOption);

  return { date: input.date, tier, headcount: input.headcount, individualOption, wholeHouseOption, recommendation };
}

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
  room_layout: string; // 顯示用標籤，例如 "4+4"、"2+2+4"；同一 occupancy 可以有多筆方案代表不同組合
  is_default: boolean; // 客人沒有指定房型組合時，系統自動選這一筆（同 occupancy 只該有一筆 true）
}

export interface WholeHousePackagePricing {
  package_id: string;
  tier: string;
  price: number | null;
}

export interface WholeHousePackageRoom {
  package_id: string;
  room_type_id: string;
}

// 客人指定的房型組合：容量 -> 間數，例如 { 2: 2, 4: 1 } 代表「2間2人房 + 1間4人房」。
export type RequestedLayout = Record<number, number>;

export interface WholeHouseLayoutOptions {
  packageRooms?: WholeHousePackageRoom[];
  roomTypes?: RoomType[]; // 用來把 packageRooms 的 room_type_id 換算成容量
  requestedLayout?: RequestedLayout | null; // 客人沒指定就不帶，退回 is_default 那筆
}

export interface SpecialPrice {
  start_date: string; // YYYY-MM-DD
  end_date: string; // YYYY-MM-DD
  occupancy: number | null; // null＝不分人數都套用
  price: number;
}

/**
 * 特殊指定日期價格：命中就直接回傳這個絕對金額，優先權最高，呼叫端要用這個取代
 * 一般的 tier 判斷結果。同一天若同時有「指定人數」跟「不分人數」兩筆命中，優先用指定人數的那筆
 * （比較精準）；沒有特殊日期資料或都沒命中則回傳 null，維持原本的公式計算。
 */
export function getSpecialPrice(date: Date, headcount: number, specialPrices: SpecialPrice[]): number | null {
  const dateStr = toDateStr(date);
  const matches = specialPrices.filter(
    (s) => dateStr >= s.start_date && dateStr <= s.end_date && (s.occupancy == null || s.occupancy === headcount)
  );
  if (!matches.length) return null;
  const withOccupancy = matches.find((s) => s.occupancy != null);
  return (withOccupancy ?? matches[0]).price;
}

/** 這個方案的房間組成，是不是剛好符合客人指定的「容量 -> 間數」。 */
function packageMatchesLayout(packageId: string, requestedLayout: RequestedLayout, packageRooms: WholeHousePackageRoom[], roomTypes: RoomType[]): boolean {
  const capacityById = new Map(roomTypes.map((r) => [r.id, r.capacity]));
  const actualCounts: RequestedLayout = {};
  for (const pr of packageRooms) {
    if (pr.package_id !== packageId) continue;
    const cap = capacityById.get(pr.room_type_id);
    if (cap == null) continue;
    actualCounts[cap] = (actualCounts[cap] || 0) + 1;
  }
  const requestedKeys = Object.keys(requestedLayout).map(Number).filter((k) => requestedLayout[k] > 0);
  const actualKeys = Object.keys(actualCounts).map(Number);
  if (requestedKeys.length !== actualKeys.length) return false;
  return requestedKeys.every((cap) => actualCounts[cap] === requestedLayout[cap]);
}

/**
 * 找出某人數該用哪一筆包棟方案（只做「該用哪一筆」的判斷，不查價格）：
 * 人數低於配置的最小級距，或客人指定的房型組合排不出來，都回傳 null——不再像改版前那樣
 * 退回最小級距的價格墊底，這種情況一律轉真人由客服確認。
 * 沒有指定房型組合（requestedLayout 沒帶）就退回 is_default 那一筆；同人數還沒設定 is_default 的舊資料，
 * 退回同人數的第一筆，維持可用。
 */
function findWholeHouseBasePackage(headcount: number, packages: WholeHousePackage[], maxOccupancy: number, layoutOptions?: WholeHouseLayoutOptions): WholeHousePackage | null {
  if (headcount > maxOccupancy || !packages.length) return null;

  const sortedAsc = [...packages].sort((a, b) => a.occupancy - b.occupancy);
  const eligible = sortedAsc.filter((p) => p.occupancy <= headcount).sort((a, b) => b.occupancy - a.occupancy);
  if (!eligible.length) return null; // 人數低於最小配置級距

  const sameOccupancy = eligible.filter((p) => p.occupancy === eligible[0].occupancy);
  const requestedLayout = layoutOptions?.requestedLayout;
  if (requestedLayout && layoutOptions?.packageRooms && layoutOptions?.roomTypes) {
    return sameOccupancy.find((p) => packageMatchesLayout(p.id, requestedLayout, layoutOptions.packageRooms as WholeHousePackageRoom[], layoutOptions.roomTypes as RoomType[])) || null;
  }
  return sameOccupancy.find((p) => p.is_default) || sameOccupancy[0];
}

export interface ExtraPersonRule {
  rule_type: string; // 'no_extra_room'（不開房）/ 'extra_room'（開房）
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

export type PeakSeasonWeekdayTier = 'peak' | 'weekday';

/**
 * 判斷某日期落在哪個定價 tier。
 * 優先順序：旺季 > 連假 > 依星期幾（五、六＝小假日，其餘＝平日）。
 *
 * peakSeasonWeekdayTier：旺季期間的「平日」（日~四）要算旺季價還是平日價。
 * 預設 'peak'（維持原本行為，旺季期間不分平假日一律旺季價）；設為 'weekday' 時，
 * 旺季期間的平日改算平日價，旺季的小假日（五、六）不受影響仍是旺季價。
 * 這個設定同時套用在個別租房與包棟的 tier 判斷（兩者共用這個函式)。
 */
export function resolvePricingTier(
  date: Date,
  dateRanges: DateRange[],
  peakSeasonWeekdayTier: PeakSeasonWeekdayTier = 'peak'
): string {
  const dateStr = toDateStr(date);
  const inRange = (type: string) =>
    dateRanges.some((r) => r.range_type === type && dateStr >= r.start_date && dateStr <= r.end_date);

  const day = date.getDay(); // 0=Sun ... 6=Sat
  const isWeekday = day !== 5 && day !== 6;

  if (inRange(TIER_PEAK_SEASON)) {
    if (peakSeasonWeekdayTier === 'weekday' && isWeekday) return TIER_WEEKDAY;
    return TIER_PEAK_SEASON;
  }
  if (inRange(TIER_CONSECUTIVE_HOLIDAY)) return TIER_CONSECUTIVE_HOLIDAY;

  return isWeekday ? TIER_WEEKDAY : TIER_SEMI_HOLIDAY;
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
 * 需求人數小於配置的最小級距時回傳 null（見 findWholeHouseBasePackage()），不再墊底報價。
 * 加人規則有多種（不多開房／多開房）時全部回傳，交由對話流程詢問顧客要選哪一種。
 * layoutOptions 有帶 requestedLayout 時，只在符合客人指定房型組合的方案裡找。
 */
export function selectWholeHousePackage(
  headcount: number,
  packages: WholeHousePackage[],
  packagePricing: WholeHousePackagePricing[],
  extraPersonRules: ExtraPersonRule[],
  tier: string,
  maxOccupancy: number,
  layoutOptions?: WholeHouseLayoutOptions
): WholeHouseQuote | null {
  const base = findWholeHouseBasePackage(headcount, packages, maxOccupancy, layoutOptions);
  if (!base) return null;

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

export interface WholeHouseUpgradeOption {
  package: WholeHousePackage; // 升等後套用的級距（基礎人數 >= 需求人數，取最小的一個）
  price: number; // 直接套用該級距的整組價格，不額外計算加人費
}

/**
 * 包棟「升等方案」：人數卡在兩個級距中間時（例如 11 人卡在 10/12 級距之間），
 * 直接跳去用上一個更大的級距整組價格（例如 11 人直接套用 12 人級距價格），不計算超額加人費。
 * 這跟 selectWholeHousePackage()（維持在較小級距、超額用加人規則計算）是兩種獨立算法，
 * 提供給「自動報價總表」同時呈現兩種價格讓管理者比較。
 */
export function selectWholeHouseUpgradeOption(
  headcount: number,
  packages: WholeHousePackage[],
  packagePricing: WholeHousePackagePricing[],
  tier: string
): WholeHouseUpgradeOption | null {
  const eligible = [...packages].filter((p) => p.occupancy >= headcount).sort((a, b) => a.occupancy - b.occupancy);
  const upgradePackage = eligible[0];
  if (!upgradePackage) return null; // 沒有夠大的級距可以直接套用

  const pricing = packagePricing.find((p) => p.package_id === upgradePackage.id && p.tier === tier);
  if (!pricing || pricing.price == null) return null;

  return { package: upgradePackage, price: pricing.price };
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
  peakSeasonWeekdayTier?: PeakSeasonWeekdayTier; // 預設 'peak'，見 resolvePricingTier() 說明
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
  const tier = resolvePricingTier(input.date, input.dateRanges, input.peakSeasonWeekdayTier);
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

// ============================================================================
// 多晚報價（促銷方案 + 連住折扣）
// 設計原則：促銷方案（%折扣）只套用在第一晚；連住折扣（固定金額）只套用在第二晚（含）以後，
// 依「需打掃／無需打掃」對應不同金額。兩者都是在「個別租房」與「包棟」各自最便宜的當晚價格上
// 疊加計算，不影響 computeQuote() 既有的單晚報價邏輯。
// ============================================================================

export interface Promotion {
  id: string;
  name: string;
  discount_percent: number;
  discount_type?: 'percent' | 'amount'; // 預設 'percent'，沿用 discount_percent；'amount' 時改用 discount_amount 直接扣金額
  discount_amount?: number;
}

export interface NightlyPrice {
  date: Date;
  tier: string;
  rawPrice: number | null; // 該晚原始價格（尚未套用促銷/連住折扣），null＝當晚這個方案不可用
  discountedPrice: number | null;
  roomsUsed?: AvailableRoom[]; // 個別租房：當晚最便宜選項實際用到的房型
  packageUsed?: WholeHousePackage; // 包棟：當晚最便宜選項套用的方案級距
}

export interface MultiNightOption {
  nights: NightlyPrice[];
  total: number | null; // null＝有任一晚不可用，整段住宿這個方案不成立
}

export interface MultiNightQuoteInput {
  checkInDate: Date;
  nights: number; // 住宿晚數，1 晚時等同單晚邏輯只套用促銷、不套用連住折扣
  headcount: number;
  dateRanges: DateRange[];
  roomTypes: RoomType[];
  roomPricing: RoomPricing[];
  roomExtraPersonPricing: RoomExtraPersonPricing[];
  packages: WholeHousePackage[];
  packagePricing: WholeHousePackagePricing[];
  extraPersonRules: ExtraPersonRule[];
  maxOccupancy: number;
  promotion: Promotion | null; // 只套用在第一晚
  consecutiveStayDiscountPerNight: number; // 固定金額，需打掃/無需打掃對應的金額由呼叫端算好傳進來
  peakSeasonWeekdayTier?: PeakSeasonWeekdayTier; // 預設 'peak'，見 resolvePricingTier() 說明
  packageRooms?: WholeHousePackageRoom[]; // 包棟方案的房間組成，用來比對 requestedLayout
  requestedLayout?: RequestedLayout | null; // 客人指定的房型組合（容量 -> 間數），沒指定就不帶
  specialPrices?: SpecialPrice[]; // 特殊指定日期價格，只影響包棟
  specialPriceStacksWithDiscounts?: boolean; // 預設 true：特殊價格命中時，促銷/連住折扣要不要繼續疊加
}

export interface MultiNightQuoteResult {
  checkInDate: Date;
  nights: number;
  headcount: number;
  individual: MultiNightOption;
  wholeHouse: MultiNightOption;
}

interface IndividualNightResult {
  price: number;
  rooms: AvailableRoom[]; // 這個選項實際用到的房型
}

function cheapestIndividualNightPrice(
  tier: string,
  headcount: number,
  roomTypes: RoomType[],
  roomPricing: RoomPricing[],
  roomExtraPersonPricing: RoomExtraPersonPricing[]
): IndividualNightResult | null {
  const availableRooms = getAvailableIndividualRooms(tier, roomTypes, roomPricing, roomExtraPersonPricing);
  if (!availableRooms.length) return null;
  const options = computeIndividualOptions(headcount, availableRooms);
  const candidates: IndividualNightResult[] = [];
  if (options.openRoomOption.success) candidates.push({ price: options.openRoomOption.totalPrice, rooms: options.openRoomOption.rooms });
  if (options.extraPersonOption) candidates.push({ price: options.extraPersonOption.totalPrice, rooms: options.extraPersonOption.baseRooms });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.price < a.price ? b : a));
}

interface WholeHouseNightResult {
  price: number;
  package: WholeHousePackage; // 這個選項實際套用的方案級距
}

/**
 * specialPrice 有帶值（不是 null/undefined）時，代表當晚命中特殊指定日期價格：直接用這個金額，
 * 略過 tier 報價與加人/升等比價，但還是要跑 findWholeHouseBasePackage() 決定用哪個方案的房間組成
 * （開房、布巾成本都要知道確切開了哪幾間房，特殊價格只換金額、不能連房間組成都不知道）。
 * 客人指定的房型組合排不出來，或人數超界，一律回傳 null——特殊價格也救不了。
 */
function cheapestWholeHouseNightPrice(
  tier: string,
  headcount: number,
  packages: WholeHousePackage[],
  packagePricing: WholeHousePackagePricing[],
  extraPersonRules: ExtraPersonRule[],
  maxOccupancy: number,
  layoutOptions?: WholeHouseLayoutOptions,
  specialPrice?: number | null
): WholeHouseNightResult | null {
  const base = findWholeHouseBasePackage(headcount, packages, maxOccupancy, layoutOptions);
  if (!base) return null;

  if (specialPrice != null) return { price: specialPrice, package: base };

  const candidates: WholeHouseNightResult[] = [];
  const quote = selectWholeHousePackage(headcount, packages, packagePricing, extraPersonRules, tier, maxOccupancy, layoutOptions);
  if (quote) {
    const price = quote.extraPersonOptions.length ? Math.min(...quote.extraPersonOptions.map((o) => o.grandTotal)) : quote.basePrice;
    candidates.push({ price, package: quote.package });
  }
  const upgrade = selectWholeHouseUpgradeOption(headcount, packages, packagePricing, tier);
  if (upgrade) candidates.push({ price: upgrade.price, package: upgrade.package });
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.price < a.price ? b : a));
}

/**
 * 統整多晚報價：每一晚各自依當天日期判斷 tier、各自算出當晚最便宜的價格，
 * 第一晚套用促銷方案 %折扣（若有設定），第二晚（含）以後再扣除連住折扣固定金額。
 * 個別租房與包棟分開計算、分開加總，交給對話流程或後台呈現兩種總價供比較。
 */
export function computeMultiNightQuote(input: MultiNightQuoteInput): MultiNightQuoteResult {
  const individualNights: NightlyPrice[] = [];
  const wholeHouseNights: NightlyPrice[] = [];

  for (let i = 0; i < input.nights; i++) {
    const date = new Date(input.checkInDate);
    date.setDate(date.getDate() + i);
    const tier = resolvePricingTier(date, input.dateRanges, input.peakSeasonWeekdayTier);
    const isFirstNight = i === 0;

    const applyDiscounts = (raw: number | null): number | null => {
      if (raw == null) return null;
      let price = raw;
      if (isFirstNight && input.promotion) {
        price = input.promotion.discount_type === 'amount'
          ? Math.max(0, price - (input.promotion.discount_amount || 0))
          : price * (1 - input.promotion.discount_percent / 100);
      } else if (!isFirstNight) {
        price = Math.max(0, price - input.consecutiveStayDiscountPerNight);
      }
      return price;
    };

    const wholeHouseSpecialPrice = getSpecialPrice(date, input.headcount, input.specialPrices || []);
    // 特殊價格命中時，是否還要疊加促銷/連住折扣由 settings 決定（預設 true＝疊加）；
    // 不疊加的話，特殊價格就是當晚最終金額，直接跳過 applyDiscounts()。
    const applyWholeHouseDiscounts = (raw: number | null): number | null => {
      if (wholeHouseSpecialPrice != null && input.specialPriceStacksWithDiscounts === false) return raw;
      return applyDiscounts(raw);
    };

    const layoutOptions: WholeHouseLayoutOptions = {
      packageRooms: input.packageRooms,
      roomTypes: input.roomTypes,
      requestedLayout: input.requestedLayout,
    };
    const individualRaw = cheapestIndividualNightPrice(tier, input.headcount, input.roomTypes, input.roomPricing, input.roomExtraPersonPricing);
    const wholeHouseRaw = cheapestWholeHouseNightPrice(
      tier, input.headcount, input.packages, input.packagePricing, input.extraPersonRules, input.maxOccupancy,
      layoutOptions, wholeHouseSpecialPrice
    );

    individualNights.push({
      date,
      tier,
      rawPrice: individualRaw?.price ?? null,
      discountedPrice: applyDiscounts(individualRaw?.price ?? null),
      roomsUsed: individualRaw?.rooms,
    });
    wholeHouseNights.push({
      date,
      tier,
      rawPrice: wholeHouseRaw?.price ?? null,
      discountedPrice: applyWholeHouseDiscounts(wholeHouseRaw?.price ?? null),
      packageUsed: wholeHouseRaw?.package,
    });
  }

  const sumOrNull = (nights: NightlyPrice[]): number | null =>
    nights.length && nights.every((n) => n.discountedPrice != null)
      ? nights.reduce((s, n) => s + (n.discountedPrice as number), 0)
      : null;

  return {
    checkInDate: input.checkInDate,
    nights: input.nights,
    headcount: input.headcount,
    individual: { nights: individualNights, total: sumOrNull(individualNights) },
    wholeHouse: { nights: wholeHouseNights, total: sumOrNull(wholeHouseNights) },
  };
}

// ============================================================================
// 純公式驅動計價（取代上面 selectWholeHousePackage 那一整套手動定價）：
// 標準房型的價格 = 床位數 × 每床基礎價，人數剛好滿載（等於床位數）再加滿載獎勵；
// 客人要求的房型組合跟標準房型不同時，另外算加開房費。不分「個別租房」跟「包棟」，
// 所有人數統一走這條路徑。
//
// 這幾個函式是新加的，不動上面既有的函式——這個檔案跟 booking_computer 專案共用，
// 既有函式改動要兩邊同步，這次只讓這個專案自己的呼叫端改用新函式，比較安全。
// ============================================================================

export interface RoomCapacityCount {
  capacity: number;
  count: number; // 這個容量目前有幾間啟用中的房間
}

export type CapacityLayout = Record<number, number>; // 容量 -> 間數

export interface StandardRoomLayoutResult {
  layout: CapacityLayout;
  beds: number; // 實際湊到的床位數；success=false 時會小於目標床位數
  roomCount: number;
  success: boolean; // false = 現有房型庫存湊不出這個人數需要的床位數
}

/**
 * 標準房型：目標床位數 = 人數是偶數用人數本身，奇數則 +1（房間容量都是偶數，湊不出奇數床位，
 * 奇數人數一定會有 1 床空著）。優先塞容量最大的房型、剩下用小容量湊滿，在實際庫存範圍內
 * 湊出最少間數的組合。庫存不足（總容量小於目標床位數）時 success=false，呼叫端要轉真人。
 */
export function computeStandardRoomLayout(headcount: number, availableCapacities: RoomCapacityCount[]): StandardRoomLayoutResult {
  const targetBeds = headcount % 2 === 0 ? headcount : headcount + 1;
  const pool = availableCapacities.filter((c) => c.capacity > 0 && c.count > 0).map((c) => ({ ...c }));

  const layout: CapacityLayout = {};
  let remaining = targetBeds;

  for (const item of [...pool].sort((a, b) => b.capacity - a.capacity)) {
    if (remaining <= 0) break;
    const used = Math.min(item.count, Math.floor(remaining / item.capacity));
    if (used <= 0) continue;
    layout[item.capacity] = (layout[item.capacity] || 0) + used;
    remaining -= used * item.capacity;
  }

  // 大容量湊完還有剩（容量組合不是乾淨的倍數關係時才會發生），退回用小容量一間一間湊到剩下的庫存用完。
  if (remaining > 0) {
    for (const item of [...pool].sort((a, b) => a.capacity - b.capacity)) {
      let available = item.count - (layout[item.capacity] || 0);
      while (remaining > 0 && available > 0 && item.capacity <= remaining) {
        layout[item.capacity] = (layout[item.capacity] || 0) + 1;
        remaining -= item.capacity;
        available--;
      }
    }
  }

  const roomCount = Object.values(layout).reduce((s, n) => s + n, 0);
  return { layout, beds: targetBeds - Math.max(0, remaining), roomCount, success: remaining <= 0 };
}

export interface CapacityFee {
  capacity: number;
  extra_room_fee: number;
}

/**
 * 加開房費：客人實際要求的房型組合跟標準房型逐一比對，算出每種容量增加/減少幾間。
 * 減少的間數（不分容量）先拿去抵掉增加的間數，抵完剩下的增加間數，各自照該容量的
 * 加開費率收費加總。抵銷順序目前是容量小的先抵（沒有更明確的業務規則可以判斷，
 * 這個假設之後如果不對，這裡是唯一要調整的地方）。
 */
export function computeExtraRoomFee(standard: CapacityLayout, requested: CapacityLayout, capacityFees: CapacityFee[]): number {
  const feeByCapacity = new Map(capacityFees.map((f) => [f.capacity, f.extra_room_fee]));
  const capacities = Array.from(new Set([...Object.keys(standard), ...Object.keys(requested)].map(Number))).sort((a, b) => a - b);

  let totalFreed = 0;
  const increases: { capacity: number; count: number }[] = [];
  for (const cap of capacities) {
    const std = standard[cap] || 0;
    const req = requested[cap] || 0;
    if (req > std) increases.push({ capacity: cap, count: req - std });
    else if (std > req) totalFreed += std - req;
  }

  let fee = 0;
  for (const inc of increases) {
    const offset = Math.min(totalFreed, inc.count);
    totalFreed -= offset;
    fee += (inc.count - offset) * (feeByCapacity.get(inc.capacity) ?? 0);
  }
  return fee;
}

export interface DateSurcharge {
  small_holiday: number;
  peak: number;
  long_holiday: number;
}

function dateSurchargeForTier(tier: string, s: DateSurcharge): number {
  if (tier === TIER_SEMI_HOLIDAY) return s.small_holiday;
  if (tier === TIER_PEAK_SEASON) return s.peak;
  if (tier === TIER_CONSECUTIVE_HOLIDAY) return s.long_holiday;
  return 0;
}

export interface UnifiedNightlyPrice {
  date: Date;
  tier: string;
  rawPrice: number;
  discountedPrice: number;
  layoutUsed: CapacityLayout;
}

export interface UnifiedQuoteInput {
  checkInDate: Date;
  nights: number;
  headcount: number;
  dateRanges: DateRange[];
  roomCapacities: RoomCapacityCount[];
  capacityFees: CapacityFee[];
  bedBaseRate: number;
  fullOccupancyBonus: number;
  minGroupHeadcount: number;
  dateSurcharge: DateSurcharge;
  requestedLayout?: CapacityLayout | null; // 客人指定的房型組合，沒指定就不帶，用標準房型
  promotion: Promotion | null;
  consecutiveStayDiscountPerNight: number;
  specialPrices?: SpecialPrice[];
  specialPriceStacksWithDiscounts?: boolean; // 預設 true
  peakSeasonWeekdayTier?: PeakSeasonWeekdayTier;
}

export interface UnifiedMultiNightQuoteResult {
  checkInDate: Date;
  nights: number;
  headcount: number;
  standardLayout: CapacityLayout | null; // null = 人數超出範圍或庫存湊不出來，無法報價
  nightly: UnifiedNightlyPrice[];
  total: number | null;
}

/**
 * 統整報價：不分個別租房／包棟，所有人數都走這條路徑。人數低於 minGroupHeadcount 或
 * 超過目前房型庫存總容量、或庫存湊不出標準房型時，回傳 total=null，呼叫端要轉真人。
 * 客人指定的房型組合跟標準房型不同時，逐晚在標準價格上加計加開房費（命中特殊指定日期價格
 * 那一晚除外——特殊價格直接取代「標準價格＋加開房費＋日期加價」整段，不會再疊加加開房費）。
 */
export function computeUnifiedMultiNightQuote(input: UnifiedQuoteInput): UnifiedMultiNightQuoteResult {
  const totalCapacity = input.roomCapacities.reduce((s, c) => s + c.capacity * c.count, 0);
  const cannotQuote = { checkInDate: input.checkInDate, nights: input.nights, headcount: input.headcount, standardLayout: null, nightly: [], total: null };

  if (input.headcount < input.minGroupHeadcount || input.headcount > totalCapacity) return cannotQuote;

  const standard = computeStandardRoomLayout(input.headcount, input.roomCapacities);
  if (!standard.success) return cannotQuote;

  const hasRequestedLayout = !!input.requestedLayout && Object.keys(input.requestedLayout).length > 0;
  const finalLayout = hasRequestedLayout ? (input.requestedLayout as CapacityLayout) : standard.layout;
  const extraFee = hasRequestedLayout ? computeExtraRoomFee(standard.layout, finalLayout, input.capacityFees) : 0;

  const nightly: UnifiedNightlyPrice[] = [];
  for (let i = 0; i < input.nights; i++) {
    const date = new Date(input.checkInDate);
    date.setDate(date.getDate() + i);
    const tier = resolvePricingTier(date, input.dateRanges, input.peakSeasonWeekdayTier);
    const isFirstNight = i === 0;

    const special = getSpecialPrice(date, input.headcount, input.specialPrices || []);
    const raw = special != null
      ? special
      : standard.beds * input.bedBaseRate + (input.headcount === standard.beds ? input.fullOccupancyBonus : 0) + extraFee + dateSurchargeForTier(tier, input.dateSurcharge);

    let price = raw;
    const skipDiscount = special != null && input.specialPriceStacksWithDiscounts === false;
    if (!skipDiscount) {
      if (isFirstNight && input.promotion) {
        price = input.promotion.discount_type === 'amount'
          ? Math.max(0, price - (input.promotion.discount_amount || 0))
          : price * (1 - input.promotion.discount_percent / 100);
      } else if (!isFirstNight) {
        price = Math.max(0, price - input.consecutiveStayDiscountPerNight);
      }
    }

    nightly.push({ date, tier, rawPrice: raw, discountedPrice: price, layoutUsed: finalLayout });
  }

  return {
    checkInDate: input.checkInDate,
    nights: input.nights,
    headcount: input.headcount,
    standardLayout: standard.layout,
    nightly,
    total: nightly.length ? nightly.reduce((s, n) => s + n.discountedPrice, 0) : null,
  };
}

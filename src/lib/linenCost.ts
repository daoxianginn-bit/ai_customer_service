// ========================================================================
// 布巾備品洗滌成本計算
//
// 布巾跟耗材（consumables）不一樣：耗材用掉就沒了、要補貨；布巾重複使用，
// 每送洗一次算一次錢，成本來源是洗滌廠的每件單價。
//
// 訂單管理頁（產生／編輯用量）跟布巾統計頁（重算與核對）都用這裡的函式，
// 避免兩邊各算各的、對不起來。
// ========================================================================

export interface LinenItem {
  id: string;
  category: string;
  spec: string;
  unit_price: number | null; // null＝另行報價，算不出金額
  is_active: boolean;
  display_order: number;
  notes: string;
}

export interface RoomLinenDefault {
  room_type_id: string;
  linen_item_id: string;
  quantity: number;
  change_every_nights: number;
}

export interface LinenUsageRow {
  linen_item_id: string;
  quantity: number;
  unit_price: number;
  is_manual: boolean;
}

export function linenItemLabel(item: Pick<LinenItem, 'category' | 'spec'>): string {
  return item.spec ? `${item.category}－${item.spec}` : item.category;
}

/** 入住到退房的晚數。日期不合法或退房不晚於入住時回傳 0。 */
export function nightsBetween(checkin: string | null | undefined, checkout: string | null | undefined): number {
  if (!checkin || !checkout) return 0;
  const a = new Date(`${checkin}T00:00:00`);
  const b = new Date(`${checkout}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  const nights = Math.round((b.getTime() - a.getTime()) / 86400000);
  return nights > 0 ? nights : 0;
}

/**
 * 一趟住宿要換洗幾次。
 * 住 5 晚、設定 3 晚換一次 → ceil(5/3) = 2 次；設定 1（每晚換）→ 5 次。
 * 晚數 0（當日往返或日期沒填）仍算 1 次，因為房間還是整理過、布巾還是送洗了。
 */
export function changeCount(nights: number, changeEveryNights: number): number {
  const every = changeEveryNights > 0 ? changeEveryNights : 1;
  const effectiveNights = nights > 0 ? nights : 1;
  return Math.ceil(effectiveNights / every);
}

/**
 * 依「這張訂單開了哪幾間房 × 每間房的預設組合 × 換洗次數」算出整張訂單的布巾用量。
 *
 * 「包棟」不在這裡特別處理：它只是使用權的名稱，成本一律看實際開了哪幾間房，
 * 所以包棟訂單只要在訂單管理頁把開出去的房間選齊，算出來就是對的。
 */
export function computeUsage(
  roomTypeIds: string[],
  defaults: RoomLinenDefault[],
  nights: number,
  items: LinenItem[]
): LinenUsageRow[] {
  const priceById = new Map(items.map((i) => [i.id, i.unit_price ?? 0]));
  const totals = new Map<string, number>();

  for (const roomTypeId of roomTypeIds) {
    for (const d of defaults.filter((x) => x.room_type_id === roomTypeId)) {
      const qty = d.quantity * changeCount(nights, d.change_every_nights);
      totals.set(d.linen_item_id, (totals.get(d.linen_item_id) || 0) + qty);
    }
  }

  return [...totals.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([linen_item_id, quantity]) => ({
      linen_item_id,
      quantity,
      unit_price: priceById.get(linen_item_id) ?? 0,
      is_manual: false,
    }));
}

/**
 * 重算時保留管理員手動改過的列，只更新沒被手動改過的部分。
 * 改了日期或房間就整批重算的話，會把人工調整默默蓋掉，這在對帳時很難察覺。
 */
export function mergeUsage(existing: LinenUsageRow[], recomputed: LinenUsageRow[]): LinenUsageRow[] {
  const manual = existing.filter((r) => r.is_manual);
  const manualIds = new Set(manual.map((r) => r.linen_item_id));
  return [...manual, ...recomputed.filter((r) => !manualIds.has(r.linen_item_id))];
}

export function usageSubtotal(row: Pick<LinenUsageRow, 'quantity' | 'unit_price'>): number {
  return row.quantity * row.unit_price;
}

export function usageTotal(rows: Pick<LinenUsageRow, 'quantity' | 'unit_price'>[]): number {
  return rows.reduce((sum, r) => sum + usageSubtotal(r), 0);
}

export function currency(n: number): string {
  return `NT$ ${Math.round(n).toLocaleString()}`;
}

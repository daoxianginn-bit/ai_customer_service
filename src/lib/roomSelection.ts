// ========================================================================
// 依顧客指定的「每種房型各要幾間」挑出實際房間
//
// 為什麼不放進 bookingEngine.ts：那個檔案負責「算錢」，而且跟 booking_computer 專案共用，
// 改動要兩邊同步。這裡只負責「決定開哪幾間房」，不碰任何價格計算。
//
// 房間紀錄的用途：
//   1. 預訂單訊息裡列出實際房型
//   2. 布巾備品的洗滌成本（要知道開了幾間房、哪幾間）
//   3. 房況/行事曆與檔期衝突檢查
// ========================================================================

export interface SelectableRoom {
  id: string;
  name: string;
  capacity: number;
  display_order: number;
  floor?: string | null; // 顯示成「2F_暖木(2人)」時要用，見 rooms.ts 的 roomLabel()
}

export interface RoomCountRequest {
  capacity: number;
  count: number;
}

export interface RoomSelectionResult {
  rooms: SelectableRoom[];
  /** 指定了但排不出來的部分，例如客人要 3 間 2 人房但只剩 1 間 */
  shortfall: RoomCountRequest[];
}

/**
 * 依人數分類挑房：每一種容量各挑指定的間數，同容量的房間依 display_order 先後挑。
 * occupiedRoomIds 是同時段已被其他訂單佔用的房間，一律跳過。
 *
 * 排不滿時不會拿別種容量的房間硬湊——「2 人房 3 間」排不出來就如實回報 shortfall，
 * 讓呼叫端決定要轉真人還是改用其他方案，默默塞一間 4 人房會讓客人收到跟預期不同的房型。
 */
export function selectRoomsByRequest(
  requests: RoomCountRequest[],
  rooms: SelectableRoom[],
  occupiedRoomIds: Set<string> = new Set()
): RoomSelectionResult {
  const selected: SelectableRoom[] = [];
  const shortfall: RoomCountRequest[] = [];
  const used = new Set<string>();

  for (const req of requests) {
    if (req.count <= 0) continue;
    const pool = rooms
      .filter((r) => r.capacity === req.capacity && !occupiedRoomIds.has(r.id) && !used.has(r.id))
      .sort((a, b) => a.display_order - b.display_order);

    const take = pool.slice(0, req.count);
    for (const r of take) used.add(r.id);
    selected.push(...take);

    if (take.length < req.count) shortfall.push({ capacity: req.capacity, count: req.count - take.length });
  }

  return { rooms: selected.sort((a, b) => a.display_order - b.display_order), shortfall };
}

/** 把顧客回答的房數（key 是容量）整理成挑房用的請求清單，容量小的排前面比較好讀。 */
export function toRoomCountRequests(countsByCapacity: Record<number, number>): RoomCountRequest[] {
  return Object.entries(countsByCapacity)
    .map(([capacity, count]) => ({ capacity: Number(capacity), count }))
    .filter((r) => Number.isFinite(r.capacity) && r.count > 0)
    .sort((a, b) => a.capacity - b.capacity);
}

export function describeShortfall(shortfall: RoomCountRequest[]): string {
  return shortfall.map((s) => `${s.capacity}人房還差 ${s.count} 間`).join('、');
}

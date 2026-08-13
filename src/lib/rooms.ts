// ========================================================================
// 房間的顯示名稱
// 「房型與空間維護」把樓層、名稱、人數分成三個欄位存，但使用者在訂單管理、布巾備品
// 這些頁面看到的應該是完整的一串「2F_暖木_2人」，才分得出同名不同樓層的房間。
// 各頁面一律走這個函式，避免每頁自己拼、格式長得不一樣。
// ========================================================================

export interface RoomOption {
  id: string;
  name: string;
  floor?: string | null;
  capacity?: number | null;
  type?: string | null;
  security_deposit?: number | null;
}

/**
 * 樓層_名稱(人數)，例如 2F_暖木(2人)。
 * 樓層沒填就只有 暖木(2人)，人數沒填就只有 2F_暖木，不會留下多餘的底線或空括號。
 */
export function roomLabel(room: RoomOption): string {
  const floor = room.floor?.trim();
  const base = floor ? `${floor}_${room.name}` : room.name;
  return room.capacity != null ? `${base}(${room.capacity}人)` : base;
}

/** 一次顯示多間房，例如包棟訂單。 */
export function roomLabels(rooms: RoomOption[]): string {
  return rooms.map(roomLabel).join('、');
}

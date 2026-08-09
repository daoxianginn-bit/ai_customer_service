// ========================================================================
// 訂單狀態的單一定義來源：前端頁面（訂單管理、房況行事曆、客製訊息發送、客戶資料）
// 跟後端 Netlify functions（line-webhook.ts）都從這裡取用，避免各處清單/顏色/說明兜不起來。
// ========================================================================

export interface BookingStatusOption {
  value: string;
  label: string;
  description: string;
  badgeClassName: string;
}

// 管理員可以在「訂單管理」手動選擇的 9 種狀態，依正常流程先後排序。
export const BOOKING_STATUS_OPTIONS: BookingStatusOption[] = [
  { value: 'inquiring', label: '待報價', description: '客戶資訊都收集了，還未給報價金額。', badgeClassName: 'bg-gray-100 text-gray-600' },
  { value: 'quoted', label: '已報價', description: '已給報價金額，尚未說要預訂。', badgeClassName: 'bg-blue-100 text-blue-700' },
  { value: 'awaiting_deposit', label: '待預定', description: '已發送預定單資訊，等待客戶匯款訂金。', badgeClassName: 'bg-yellow-100 text-yellow-700' },
  { value: 'reserved', label: '已預定', description: '已收到訂金，距離入住日還大於 15 天。', badgeClassName: 'bg-purple-100 text-purple-700' },
  { value: 'awaiting_balance', label: '待收尾款', description: '已收訂金、未收尾款，距離入住日小於等於 15 天。', badgeClassName: 'bg-orange-100 text-orange-700' },
  { value: 'confirmed', label: '已確認', description: '已收尾款，等待時間到入住。', badgeClassName: 'bg-green-100 text-green-700' },
  { value: 'awaiting_refund', label: '待退款', description: '客戶取消訂單，款項尚未退回。', badgeClassName: 'bg-red-100 text-red-600' },
  { value: 'refunded', label: '已退款', description: '客戶取消訂單，款項已經匯還給客戶。', badgeClassName: 'bg-gray-200 text-gray-600' },
  { value: 'cancelled', label: '已取消', description: '客戶取消訂單，且沒有已收款項需要退還。', badgeClassName: 'bg-red-50 text-red-500' },
];

// 系統專用狀態：LINE 自動訂房流程偵測到入住日期/房型跟其他訂單衝突時才會用到，
// 不開放管理員在「訂單管理」下拉選單手動選這個狀態，需要人工核實空房狀況後改成其他狀態。
export const SYSTEM_ONLY_STATUS: BookingStatusOption = {
  value: 'pending_manual_conflict',
  label: '待人工確認',
  description: '系統偵測到入住日期/房型跟其他訂單重疊，需要人工核實實際空房狀況。',
  badgeClassName: 'bg-red-100 text-red-700',
};

export const ALL_BOOKING_STATUSES: BookingStatusOption[] = [...BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUS];

export function bookingStatusLabel(status?: string | null): string {
  return ALL_BOOKING_STATUSES.find((s) => s.value === status)?.label || status || '';
}

export function bookingStatusDescription(status?: string | null): string {
  return ALL_BOOKING_STATUSES.find((s) => s.value === status)?.description || '';
}

export function bookingStatusBadgeClass(status?: string | null): string {
  return ALL_BOOKING_STATUSES.find((s) => s.value === status)?.badgeClassName || 'bg-gray-100 text-gray-600';
}

// 房間已經鎖定、還沒進入取消/退款流程的狀態，供房況行事曆／檔期衝突檢查判斷「這個日期算不算被佔用」。
export const OCCUPYING_STATUSES = ['awaiting_deposit', 'reserved', 'awaiting_balance', 'confirmed', 'pending_manual_conflict'];

// 已經收過訂金（含）以後的狀態，供「客戶資料」頁判斷客戶是否已經「下訂」（而不只是詢問/報價）。
export const DEPOSIT_OR_LATER_STATUSES = ['reserved', 'awaiting_balance', 'confirmed'];

// 選這個狀態時，「訂單管理」表單會要求填寫匯款末5碼才能儲存（前端表單驗證，不是資料庫層級限制）。
export const REQUIRES_REMIT_LAST5_STATUS = 'reserved';

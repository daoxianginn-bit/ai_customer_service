// ========================================================================
// 訂單狀態的單一定義來源：前端頁面（訂單管理、房況行事曆、客製訊息發送、客戶資料、排程管理）
// 跟後端 Netlify functions（line-webhook.ts、scheduled-tasks-run.ts）都從這裡取用，
// 避免各處清單/顏色/說明兜不起來。
//
// 2026-08 改版：從舊的 9 狀態改成 9 步驟主流程 + 3 步驟例外分支，新增「待確認」
// （客人已回報匯款、等客服核對）「入住中」「押金處理」「已處理」四個狀態，
// 讓「已收尾款」到「真正結案」之間的過程可以被追蹤，不再全部塞在同一個「已確認」裡。
//
// 舊值遷移（供理解 supabase_schema.sql 裡的搬遷邏輯，資料庫遷移完成後這兩個舊值不會再出現）：
//   quoted（已報價）  → 併入 inquiring（待報價）——待報價本來就涵蓋「還沒報價」跟
//                        「已報價、等客人決定」兩種情況，不需要獨立狀態。
//   confirmed（已確認）→ 改名 awaiting_checkin（待入住）——語意完全相同（已收尾款、
//                        等入住日到），只是新流程把「入住當天」「退房當天」拆成
//                        更細的 checked_in／deposit_processing 兩步，原本的「已確認」
//                        不再適合當作終點，改成入住前的等待狀態。
// ========================================================================

export interface BookingStatusOption {
  value: string;
  label: string;
  description: string;
  badgeClassName: string;
  // 對應規格書裡的流程編號（1~9 主流程、20~22 例外分支），供畫面顯示「3.待確認」
  // 這種帶編號的呈現方式，跟客服原本習慣的編號對齊。系統專用狀態（pending_manual_conflict）
  // 沒有編號。
  code: number;
}

// 管理員可以在「訂單管理」手動選擇的狀態，依正常流程先後排序（1~9），
// 例外分支（取消/退款）緊接在後（20~22）。
export const BOOKING_STATUS_OPTIONS: BookingStatusOption[] = [
  { value: 'inquiring', label: '待報價', description: '客戶資訊都收集了、或已給報價金額，尚未確認要預訂。', badgeClassName: 'bg-gray-100 text-gray-600', code: 1 },
  { value: 'awaiting_deposit', label: '待預定', description: '已發送預定單資訊，等待客戶匯款訂金。', badgeClassName: 'bg-yellow-100 text-yellow-700', code: 2 },
  { value: 'awaiting_confirmation', label: '待確認', description: '客戶已回報已匯款，等待客服核對匯款是否到帳。', badgeClassName: 'bg-amber-100 text-amber-700', code: 3 },
  { value: 'reserved', label: '已預定', description: '已核對收到訂金，距離入住日還早。', badgeClassName: 'bg-purple-100 text-purple-700', code: 4 },
  { value: 'awaiting_balance', label: '待收尾款', description: '已收訂金、未收尾款，距離入住日剩 3 天內。', badgeClassName: 'bg-orange-100 text-orange-700', code: 5 },
  { value: 'awaiting_checkin', label: '待入住', description: '已收尾款，等待入住日到來。', badgeClassName: 'bg-sky-100 text-sky-700', code: 6 },
  { value: 'checked_in', label: '入住中', description: '入住當天，客人正在住宿期間。', badgeClassName: 'bg-teal-100 text-teal-700', code: 7 },
  { value: 'deposit_processing', label: '押金處理', description: '已退房，押金核對／退還處理中。', badgeClassName: 'bg-indigo-100 text-indigo-700', code: 8 },
  { value: 'completed', label: '已處理', description: '押金已處理完畢，訂單結案。', badgeClassName: 'bg-green-100 text-green-700', code: 9 },
  { value: 'cancelled', label: '取消訂單', description: '客戶取消訂單，且沒有已收款項需要退還。', badgeClassName: 'bg-red-50 text-red-500', code: 20 },
  { value: 'awaiting_refund', label: '待退款', description: '客戶取消訂單，款項尚未退回。', badgeClassName: 'bg-red-100 text-red-600', code: 21 },
  { value: 'refunded', label: '已退款', description: '客戶取消訂單，款項已經匯還給客戶。', badgeClassName: 'bg-gray-200 text-gray-600', code: 22 },
];

// 系統專用狀態：不開放管理員在「訂單管理」下拉選單手動選這些狀態，只由系統自動寫入/清除。
export const SYSTEM_ONLY_STATUSES: BookingStatusOption[] = [
  {
    // LINE 自動訂房流程偵測到入住日期/房型跟其他訂單衝突時使用，需要人工核實空房狀況後改成其他狀態。
    value: 'pending_manual_conflict',
    label: '待人工確認',
    description: '系統偵測到入住日期/房型跟其他訂單重疊，需要人工核實實際空房狀況。',
    badgeClassName: 'bg-red-100 text-red-700',
    code: 0,
  },
  {
    // 第三方平台（Airbnb／Booking.com／Agoda／Trip）iCal 同步匯入時使用，代表這個日期範圍
    // 是從外部平台讀進來的既有訂單，不是透過本系統成立的，所以不走 1~9 的正常流程，
    // 也不開放手動選——要取消/修改一律要回到來源平台，這裡只是把日期擋起來避免撞期。
    value: 'external_synced',
    label: '外部平台已訂',
    description: '從第三方平台（Airbnb／Booking.com／Agoda／Trip）iCal 同步匯入的既有訂單，僅用來佔用日期避免雙重預訂，異動請回到來源平台操作。',
    badgeClassName: 'bg-slate-100 text-slate-600',
    code: 0,
  },
];

export const ALL_BOOKING_STATUSES: BookingStatusOption[] = [...BOOKING_STATUS_OPTIONS, ...SYSTEM_ONLY_STATUSES];

export function bookingStatusLabel(status?: string | null): string {
  return ALL_BOOKING_STATUSES.find((s) => s.value === status)?.label || status || '';
}

export function bookingStatusDescription(status?: string | null): string {
  return ALL_BOOKING_STATUSES.find((s) => s.value === status)?.description || '';
}

export function bookingStatusBadgeClass(status?: string | null): string {
  return ALL_BOOKING_STATUSES.find((s) => s.value === status)?.badgeClassName || 'bg-gray-100 text-gray-600';
}

export function bookingStatusCode(status?: string | null): number | null {
  const found = ALL_BOOKING_STATUSES.find((s) => s.value === status);
  return found ? found.code : null;
}

// 房間已經鎖定、還沒進入取消/退款流程的狀態，供房況行事曆／檔期衝突檢查判斷「這個日期算不算被佔用」。
// 定義是「除了 待報價／取消／待退款／已退款 以外的全部」——只要訂單走到「待預定」以後，
// 這個日期範圍就已經算是保留給這位客人了，一路到已處理都算數（那段日期確實被住過）。
export const OCCUPYING_STATUSES = [
  'awaiting_deposit', 'awaiting_confirmation', 'reserved', 'awaiting_balance',
  'awaiting_checkin', 'checked_in', 'deposit_processing', 'completed',
  'pending_manual_conflict', 'external_synced',
];

// 已經核對收過訂金（含）以後的狀態，供「客戶資料」頁判斷客戶是否已經「下訂」（而不只是詢問/報價）。
// 不含 awaiting_confirmation：客人「說」已經匯款了，但客服還沒核對到帳，還不能算數。
export const DEPOSIT_OR_LATER_STATUSES = ['reserved', 'awaiting_balance', 'awaiting_checkin', 'checked_in', 'deposit_processing', 'completed'];

// 已經收齊尾款（含）以後的狀態，供房況行事曆／日曆訂閱判斷「尾款未收」警示要不要顯示。
export const BALANCE_PAID_STATUSES = ['awaiting_checkin', 'checked_in', 'deposit_processing', 'completed'];

// 選這個狀態時，「訂單管理」表單會要求填寫匯款末5碼才能儲存（前端表單驗證，不是資料庫層級限制）。
export const REQUIRES_REMIT_LAST5_STATUS = 'reserved';

// 選這個狀態時才能填寫「入住密碼」欄位（前端表單驗證），其餘狀態這個欄位鎖住不可編輯。
export const REQUIRES_CHECKIN_PASSWORD_STATUS = 'awaiting_checkin';

// 訂單管理頁「訂單流程狀態」進度列用的 9 步驟正常流程，依序前進；取消/待退款/已退款/待人工確認
// 是例外流程，不在這個序列裡（flowStepIndex 對它們回傳 null，畫面上另外用例外樣式呈現，
// 不會出現在 1~9 的進度點上——這就是「4 已預定下一步可能走 5 待收尾款或 20 取消訂單」
// 的分支：取消永遠是獨立於進度列之外、隨時可選的動作，不需要進度列本身支援分支邏輯）。
export const FLOW_STEP_STATUSES = [
  'inquiring', 'awaiting_deposit', 'awaiting_confirmation', 'reserved', 'awaiting_balance',
  'awaiting_checkin', 'checked_in', 'deposit_processing', 'completed',
];

export function flowStepIndex(status?: string | null): number | null {
  const idx = FLOW_STEP_STATUSES.indexOf(status || '');
  return idx === -1 ? null : idx + 1;
}

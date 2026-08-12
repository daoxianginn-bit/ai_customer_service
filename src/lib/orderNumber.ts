// ========================================================================
// 訂單編號：6 碼大寫英數混和亂數
//
// 字元集去掉容易看錯/唸錯的 0/O、1/I，剩 32 個字元，6 碼約有 32^6 ≈ 10.7 億種組合。
// bookings.order_number 有 UNIQUE 限制，撞號時呼叫端 retry 幾次即可（機率極低）。
//
// 舊格式（YYYYMMDD-XXXX）的訂單不會被改動，新舊格式並存——這裡只負責產生新編號，
// 不處理既有資料的轉換。
// ========================================================================

const ORDER_NUMBER_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 字元，去掉 0/O、1/I
const ORDER_NUMBER_LENGTH = 6;

export function generateOrderNumber(): string {
  let result = '';
  for (let i = 0; i < ORDER_NUMBER_LENGTH; i++) {
    result += ORDER_NUMBER_CHARS[Math.floor(Math.random() * ORDER_NUMBER_CHARS.length)];
  }
  return result;
}

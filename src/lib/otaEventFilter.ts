// ========================================================================
// 判斷第三方平台 iCal 裡的每一筆事件「是不是該平台真正成立的訂單」。
//
// 為什麼需要這一層：OTA 匯出的行事曆同時包含兩種東西——該平台自己成交的訂單，以及
// 「這幾天不能訂」的關房事件。關房的來源可能是房東手動封房、平台的可預訂範圍上限，
// 也可能是「我們自己匯出給該平台的本地訂單，被平台轉成 Not available 又原樣吐回來」。
// 全部照收的話會發生兩件事：
//   1. 同一段日期在系統裡變成兩筆訂單（本地一筆 + 平台回傳的關房一筆）。
//   2. 平台的可預訂範圍上限會變成一筆長達數個月的假訂單，把整段房況鎖死
//      （實測 Airbnb 的樣本就有一筆 2027/03/01→2027/08/20、共 172 天的關房）。
//
// 判斷策略分兩層，先白名單再黑名單：
//   白名單（只有已確認格式的平台才有）：找得到「這是訂單」的正面證據才收，例如 Airbnb 的
//     DESCRIPTION 一定帶 "Reservation URL: .../details/<確認碼>"，關房事件連 DESCRIPTION
//     都沒有，所以這個判斷不可能誤判。
//   黑名單（所有平台共用）：SUMMARY 出現 Not available／Blocked／CLOSED 這類字樣就是關房。
//     這些字幾乎不可能出現在真訂單的標題上，套用到還沒確認格式的平台也很安全。
//
// 還沒確認格式的平台（目前是 Booking／Agoda／Trip）只套黑名單，不套白名單——
// 白名單需要知道該平台「真訂單長什麼樣」，在拿到實際樣本之前貿然要求正面證據，
// 會把該平台所有訂單都擋掉，比照收更糟。拿到樣本後在 PLATFORM_RULES 補上即可。
// ========================================================================

import { ParsedIcsEvent } from './icsParser';

export type OtaEventKind = 'reservation' | 'block';

export interface OtaEventClassification {
  kind: OtaEventKind;
  /** 平台端的訂單確認碼（例如 Airbnb 的 HMYSQ5EZ8R）。撈不到就是 null。 */
  confirmationCode: string | null;
  /** 平台願意提供的聯絡資訊片段（Airbnb 只給電話末 4 碼），供人工比對用。撈不到就是 null。 */
  phoneLast4: string | null;
  /** 判定成關房時，是被哪一條規則擋下的，寫進同步摘要供人工追查。 */
  blockedReason: string | null;
}

/**
 * 所有平台共用的關房字樣。比對時一律轉小寫，所以這裡只寫小寫。
 * 平台改措辭時，可以在「OTA 頻道管理」該頻道的欄位補上新的字樣，不需要改程式。
 */
const COMMON_BLOCK_KEYWORDS = [
  'not available',
  'unavailable',
  'blocked',
  'block',
  'closed',
  'busy',
  '不可用',
  '已關閉',
  '關房',
];

interface PlatformRule {
  /**
   * 白名單：回傳非 null 代表「確定是真訂單」，順便把撈到的識別資訊帶回來。
   * 回傳 null 代表「這條規則看不出是訂單」，交給黑名單繼續判斷。
   * 只有已經拿到實際 .ics 樣本、確認過格式的平台才實作這個。
   */
  detectReservation?: (event: ParsedIcsEvent) => { confirmationCode: string | null; phoneLast4: string | null } | null;
  /** 這個平台專屬的關房字樣，會跟 COMMON_BLOCK_KEYWORDS 合併。 */
  blockKeywords?: string[];
}

// Airbnb 真訂單的 DESCRIPTION 範例（已確認的實際格式）：
//   Reservation URL: https://www.airbnb.com/hosting/reservations/details/HMYSQ5EZ8R
//   Phone Number (Last 4 Digits): 8607
// 關房事件則是 SUMMARY:Airbnb (Not available) 且完全沒有 DESCRIPTION。
const AIRBNB_RESERVATION_URL_RE = /reservations\/details\/([A-Za-z0-9]+)/;
const AIRBNB_PHONE_LAST4_RE = /last\s*4\s*digits\s*\)?\s*[:：]\s*(\d{4})/i;

const PLATFORM_RULES: Record<string, PlatformRule> = {
  airbnb: {
    detectReservation: (event) => {
      const code = event.description.match(AIRBNB_RESERVATION_URL_RE)?.[1] || null;
      if (!code) return null;
      return {
        confirmationCode: code,
        phoneLast4: event.description.match(AIRBNB_PHONE_LAST4_RE)?.[1] || null,
      };
    },
    blockKeywords: ['airbnb (not available)'],
  },
  // booking / agoda / trip：還沒拿到實際樣本，先只套共用黑名單。
  // 拿到樣本後在這裡補 detectReservation，才會升級成白名單判斷。
};

/**
 * @param extraBlockKeywords 管理員在「OTA 頻道管理」自行補的關房字樣（逗號分隔），平台改版時免改程式。
 */
export function classifyOtaEvent(
  platform: string,
  event: ParsedIcsEvent,
  extraBlockKeywords: string[] = []
): OtaEventClassification {
  const rule = PLATFORM_RULES[platform] || {};

  // 第一層：正面證據。找得到就直接認定是真訂單，不再看黑名單——真訂單的標題本來就有可能
  // 剛好包含黑名單字樣（例如客人姓名裡有 "Block"），有正面證據時不該被字面比對推翻。
  const detected = rule.detectReservation?.(event) ?? null;
  if (detected) {
    return { kind: 'reservation', confirmationCode: detected.confirmationCode, phoneLast4: detected.phoneLast4, blockedReason: null };
  }

  // 第二層：黑名單。
  const haystack = `${event.summary} ${event.description}`.toLowerCase();
  const keywords = [...COMMON_BLOCK_KEYWORDS, ...(rule.blockKeywords || []), ...extraBlockKeywords]
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  const hit = keywords.find((k) => haystack.includes(k));
  if (hit) {
    return { kind: 'block', confirmationCode: null, phoneLast4: null, blockedReason: `符合關房字樣「${hit}」` };
  }

  // 都沒中：已確認格式的平台採嚴格白名單（沒有正面證據就不收，避免假訂單佔房）；
  // 還沒確認格式的平台維持原本的寬鬆行為（照收），否則會把該平台所有訂單都擋掉。
  if (rule.detectReservation) {
    return { kind: 'block', confirmationCode: null, phoneLast4: null, blockedReason: '找不到訂單識別資訊（例如訂房連結／確認碼）' };
  }
  return { kind: 'reservation', confirmationCode: null, phoneLast4: null, blockedReason: null };
}

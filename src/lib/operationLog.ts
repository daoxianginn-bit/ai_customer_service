// ========================================================================
// 操作紀錄（異動軌跡）：誰在什麼時候、在哪個功能、把什麼資料從什麼改成什麼。
//
// 後台各功能頁在存檔成功後自己寫一筆，Netlify functions 則寫系統自動異動的那一筆
// （actor 是 'system'）。兩邊共用這個檔案，中文欄位名稱與比對規則才不會各寫一套、
// 同一個欄位在不同頁面顯示成不同名字。
//
// 設計上刻意只記「真的有變的欄位」，不記整列快照：
//   1. 查的人要的是「這次改了什麼」，整列丟上去等於要他自己逐欄找差異。
//   2. 一張訂單三十幾個欄位，每改一個字就留兩份完整副本，這張表會長得比 bookings 還快。
// ========================================================================

export type ActorType = 'user' | 'system';

export interface OperationLogEntry {
  /** 功能名稱（中文），例如「訂單管理」。用 FEATURES 裡的常數，不要各處自己打字串。 */
  feature: string;
  /** 動作（中文），例如「新增」「修改」「刪除」。 */
  action: string;
  /** 這次異動的對象，例如訂單編號、房型名稱。沒有明確對象時給 null。 */
  target?: string | null;
  actorType: ActorType;
  /** 使用者的登入帳號（email）；系統自動異動時是 'system'。 */
  actorName: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  /** 'info'＝資料異動（預設），'error'＝系統錯誤。 */
  level?: 'info' | 'error';
  /** HTTP 狀態碼（4XX/5XX）。不是 HTTP 來源的錯誤留空。 */
  statusCode?: number | null;
  errorMessage?: string | null;
}

// 功能名稱集中在這裡，查詢畫面的「功能」下拉選單也是讀這一份，
// 不會發生「寫進去的是『訂單管理』、選單裡卻只有『訂單』」而永遠篩不到的情況。
export const LOG_FEATURES = {
  order: '訂單管理',
  pricingFormula: '計價公式設定',
  roomType: '房型與空間維護',
  systemSettings: '系統設定',
  bookingFlow: 'LINE 自定訊息流程',
  scheduledTask: '排程管理',
  otaChannel: 'OTA 頻道管理',
  lineBooking: 'LINE 訂房流程',
  calendarSync: '行事曆同步',
} as const;

export const LOG_FEATURE_OPTIONS = Object.values(LOG_FEATURES);

// 系統錯誤是以「哪一支 function 出錯」記錄的（見 withErrorLogging），名稱就是 function 檔名。
// 查詢頁的「功能」下拉選單要把這些也列出來，否則錯誤紀錄查得到、卻沒辦法用功能篩選。
export const LOG_FUNCTION_NAMES = [
  'line-webhook',
  'scheduled-tasks-run',
  'custom-messages',
  'calendar-feed',
  'cleanup-conversations',
  'line-profile',
  'invite-admin',
  'list-admins',
  'delete-admin',
  'delete-customer-data',
];

/** 系統自動異動時的固定異動者名稱。 */
export const SYSTEM_ACTOR = 'system';

// 資料庫欄位 → 中文名稱。查詢畫面直接顯示 before/after 的鍵，所以在「寫入的當下」就要換成中文；
// 之後就算欄位改名，已經寫進去的舊紀錄也還是看得懂（不會因為對照表變了就整批顯示成亂碼）。
export const FIELD_LABELS: Record<string, string> = {
  // 訂單
  order_number: '訂單編號',
  name: '客戶姓名',
  nickname: 'LINE 暱稱',
  phone: '電話',
  line_user_id: 'LINE User ID',
  checkin_date: '入住日期',
  checkout_date: '退房日期',
  nights: '住宿晚數',
  headcount: '入住人數',
  adults: '大人',
  kids: '小孩',
  infants: '嬰兒',
  whole_house: '是否包棟',
  room_type_label: '房型',
  room_amount: '房價',
  security_deposit: '押金',
  total_amount: '訂單總額',
  deposit: '訂金',
  remit_last5: '匯款末5碼',
  check_in_password: '入住密碼',
  status: '訂單狀態',
  notes: '備註',
  linen_change_count: '布巾換洗次數',
  // 計價／房型
  bed_base_rate: '每床基礎價',
  full_occupancy_bonus: '滿載獎勵',
  min_group_headcount: '最少接待人數',
  date_surcharge_small_holiday: '小假日加價',
  date_surcharge_peak: '旺季加價',
  date_surcharge_long_holiday: '連假加價',
  deposit_percent: '訂金比例',
  whole_house_security_deposit: '包棟押金',
  capacity: '容納人數',
  extra_room_fee: '加開房費',
  // 系統設定
  is_ai_enabled: 'AI 是否啟用',
  active_ai: '使用的 AI 引擎',
  system_prompt: 'AI 系統指令',
  handover_keywords: '真人客服關鍵字',
  ai_ignore_keywords: 'AI 忽略關鍵字',
  agent_user_ids: '客服帳號',
  handover_timeout_minutes: '真人接手逾時（分鐘）',
};

export function fieldLabel(key: string): string {
  return FIELD_LABELS[key] || key;
}

// 值轉成給人看的字串。布林顯示「是/否」而不是 true/false，空值統一顯示成「（空白）」，
// 這樣畫面上不會出現 null / undefined / '' 三種長得不一樣、意思卻一樣的東西。
export function formatLogValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空白）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 比對異動前後，只留下真的有變的欄位，並把欄位名稱換成中文。
 *
 * 比對用寬鬆相等（String(a) === String(b)）：資料庫回來的數字可能是 "3000"（字串）、
 * 表單送出的是 3000（數字），嚴格比對會把它當成「有異動」，於是每次存檔都留一筆
 * 什麼都沒改的紀錄，這張表很快就沒人想看了。
 *
 * @param keys 要比對哪些欄位。不傳就比對 after 的所有欄位。
 */
export function diffRecords(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  keys?: string[]
): { before: Record<string, unknown>; after: Record<string, unknown>; changed: boolean } {
  const compareKeys = keys ?? Object.keys(after || {});
  const beforeOut: Record<string, unknown> = {};
  const afterOut: Record<string, unknown> = {};

  for (const key of compareKeys) {
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    const same = a === b || (a ?? '') === (b ?? '') || String(a ?? '') === String(b ?? '');
    if (same) continue;
    const label = fieldLabel(key);
    beforeOut[label] = a ?? null;
    afterOut[label] = b ?? null;
  }

  return { before: beforeOut, after: afterOut, changed: Object.keys(afterOut).length > 0 };
}

/** 把整列資料轉成「中文欄位名: 值」，給新增/刪除這種沒有對照對象的紀錄用。 */
export function labelRecord(record: Record<string, unknown> | null | undefined, keys?: string[]): Record<string, unknown> {
  if (!record) return {};
  const out: Record<string, unknown> = {};
  for (const key of keys ?? Object.keys(record)) {
    if (record[key] === undefined) continue;
    out[fieldLabel(key)] = record[key] ?? null;
  }
  return out;
}

/**
 * 實際寫入。傳入 supabase client 是為了讓前端（anon key + 登入身分）與
 * Netlify functions（service role key）共用同一套寫入邏輯。
 *
 * 寫紀錄失敗永遠不能讓原本的操作跟著失敗——使用者的訂單已經存好了，
 * 沒能留下軌跡是需要修的問題，但不該讓他看到「儲存失敗」而重按一次、造成重複資料。
 */
export async function writeOperationLog(client: any, entry: OperationLogEntry): Promise<void> {
  try {
    await client.from('operation_logs').insert({
      feature: entry.feature,
      action: entry.action,
      target: entry.target ?? null,
      actor_type: entry.actorType,
      actor_name: entry.actorName,
      before: entry.before && Object.keys(entry.before).length ? entry.before : null,
      after: entry.after && Object.keys(entry.after).length ? entry.after : null,
      level: entry.level ?? 'info',
      status_code: entry.statusCode ?? null,
      // 訊息可能很長（含堆疊），截斷避免單一筆把整張表撐大；前 2000 字足以判斷問題出在哪。
      error_message: entry.errorMessage ? String(entry.errorMessage).slice(0, 2000) : null,
    });
  } catch (e: any) {
    console.error('[OperationLog] write failed:', e?.message || e);
  }
}

// ------------------------------------------------------------------------
// 系統錯誤
// ------------------------------------------------------------------------

// 405 Method Not Allowed 不記：公開端點（calendar-feed、webhook）被掃描器用各種方法試探是
// 網路上的常態，記下來只會把真正的錯誤淹掉，而且它代表的是「有人亂打」，不是系統壞掉。
const IGNORED_STATUS_CODES = [405];

/** 從 function 的回應本文抽出錯誤訊息：JSON 的 { error } 優先，否則就是純文字本文。 */
function extractErrorMessage(body: unknown): string {
  if (typeof body !== 'string') return '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'error' in parsed) return String((parsed as any).error);
  } catch {
    // 不是 JSON，直接當純文字用
  }
  return body.slice(0, 500);
}

/**
 * 把 Netlify function 的 handler 包起來，統一記錄 4XX/5XX 與未攔截的例外。
 *
 * 包一層而不是在 58 個 return 點各寫一行的理由：漏掉任何一個就等於那條路徑靜靜失敗，
 * 而且之後新增的錯誤回傳點會自動被涵蓋，不用記得補。
 *
 * 一定要原樣回傳/重新拋出原本的結果——這層只負責記錄，不能改變 function 對外的行為
 * （例如 LINE 會依 webhook 的狀態碼決定要不要重送，擅自吞掉錯誤會讓訊息遺失）。
 */
export function withErrorLogging(client: any, functionName: string, handler: any) {
  return async (event: any, context: any) => {
    try {
      const res = await handler(event, context);
      const code = res?.statusCode;
      if (typeof code === 'number' && code >= 400 && !IGNORED_STATUS_CODES.includes(code)) {
        await writeOperationLog(client, {
          feature: functionName,
          action: `HTTP ${code}`,
          target: event?.path || null,
          actorType: 'system',
          actorName: SYSTEM_ACTOR,
          level: 'error',
          statusCode: code,
          errorMessage: extractErrorMessage(res?.body),
        });
      }
      return res;
    } catch (e: any) {
      // 未攔截的例外原本只會變成一個沒有前後文的 Netlify 500，這裡先留下訊息與堆疊再往上拋。
      await writeOperationLog(client, {
        feature: functionName,
        action: '未預期錯誤',
        target: event?.path || null,
        actorType: 'system',
        actorName: SYSTEM_ACTOR,
        level: 'error',
        statusCode: 500,
        errorMessage: `${e?.message || e}\n${(e?.stack || '').split('\n').slice(0, 5).join('\n')}`,
      });
      throw e;
    }
  };
}

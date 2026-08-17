// ========================================================================
// 多 LINE 官方帳號（多 webhook）的共用定義。
// 後台頁面與 Netlify functions 都從這裡取用，避免角色代碼／顯示文字兩邊各寫一份。
//
// 為什麼需要「頻道」這個概念：LINE 的 user ID 是每個官方帳號各自獨立的，
// 同一個人在客戶帳號與廠商帳號是兩組不同的 userId、無法互相對應。所以聯絡人與對話
// 一定要連同「屬於哪個官方帳號」一起記錄，不能只靠 line_user_id。
// ========================================================================

export type LineChannelRole = 'customer' | 'vendor' | 'internal';

export interface LineChannel {
  id: string;
  name: string;
  role: LineChannelRole;
  channel_access_token: string;
  channel_secret: string;
  is_active: boolean;
  display_order: number;
}

export const CHANNEL_ROLE_OPTIONS: { value: LineChannelRole; label: string; description: string }[] = [
  {
    value: 'customer',
    label: '客戶用',
    description: '一般顧客使用。完整功能：訂房詢問流程、AI 知識庫問答、轉真人客服。',
  },
  {
    value: 'vendor',
    label: '廠商用',
    description: '合作廠商使用。接收訂單完成統計推播，可回覆簡短確認（例如「已備貨」），不跑訂房流程與知識庫問答。',
  },
  {
    value: 'internal',
    label: '團隊內部用',
    description: '內部同仁使用。接收訂單完成統計推播，不對外提供對話功能。',
  },
];

export function channelRoleLabel(role: string | null | undefined): string {
  return CHANNEL_ROLE_OPTIONS.find((r) => r.value === role)?.label || role || '';
}

/** 只有客戶用頻道會跑訂房流程與 AI 知識庫問答；其餘角色只做輕量處理。 */
export function isFullServiceRole(role: LineChannelRole): boolean {
  return role === 'customer';
}

/** 會收到「訂單完成」統計推播的角色。 */
export function receivesCompletionReport(role: LineChannelRole): boolean {
  return role === 'vendor' || role === 'internal';
}

/**
 * 每個官方帳號各自的 webhook 網址。
 * 沿用同一支 function，用 query string 區分是哪個頻道打進來的——
 * Netlify 的 function 路徑是部署時決定的，沒辦法為每個頻道各生一支。
 */
export function channelWebhookUrl(origin: string, channelId: string): string {
  return `${origin}/.netlify/functions/line-webhook?channel=${encodeURIComponent(channelId)}`;
}

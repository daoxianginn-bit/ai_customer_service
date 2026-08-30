// ========================================================================
// 前端的角色與頁面權限對照表。
//
// 重要觀念：這一份只負責「介面上看不看得到、進不進得去」，不是安全防線。
// 真正的防線是資料庫的 RLS（見 supabase_schema.sql 第 9 節）——前端用的 anon key 是公開的，
// 任何人都能繞過畫面直接打 API，所以這裡的設定必須跟 RLS 的分層保持一致，
// 而不是拿來當作唯一的把關。這裡做的事情是讓使用者不會看到自己按了也會失敗的功能。
// ========================================================================

export type AdminRole = 'admin' | 'staff' | 'viewer';

// 帳號狀態機（對應 supabase_schema.sql 第 9 節）：
//   invited     已建立邀請，對方還沒完成 Google 驗證
//   pending_mfa 已通過 Google 驗證，但還沒綁定 TOTP（此時 session 是 aal1，讀不到任何業務資料）
//   active      已綁定並驗證 TOTP，具備完整權限
//   suspended   停權
export type AccountStatus = 'invited' | 'pending_mfa' | 'active' | 'suspended';

export const ROLE_OPTIONS: { value: AdminRole; label: string; description: string }[] = [
  {
    value: 'admin',
    label: '管理員',
    description: '全部功能：系統設定、價格設定、帳號管理、API 金鑰與 LINE 串接都能看能改。',
  },
  {
    value: 'staff',
    label: '客服人員',
    description: '日常營運：訂單、行事曆、客戶、AI客服中心、備品、訊息發送可讀可寫；價格與房型只能看；碰不到系統設定與帳號管理。',
  },
  {
    value: 'viewer',
    label: '唯讀',
    description: '只能查看訂單、行事曆、客戶與總覽，不能新增或修改任何資料。',
  },
];

export const STATUS_LABELS: Record<AccountStatus, string> = {
  invited: '已邀請',
  pending_mfa: '待綁定 2FA',
  active: '已啟用',
  suspended: '已停權',
};

export const STATUS_DESCRIPTIONS: Record<AccountStatus, string> = {
  invited: '邀請已寄出，對方尚未用 Google 完成驗證。',
  pending_mfa: '已完成 Google 驗證，但還沒綁定 Google Authenticator，尚無法存取任何資料。',
  active: '已綁定雙因素驗證，可正常使用系統。',
  suspended: '已停權，無法登入。',
};

export function roleLabel(role?: string | null): string {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label || role || '';
}

// 每個路徑允許哪些角色進入。沒列在這裡的路徑一律只有管理員能進——
// 採「預設拒絕」而不是「預設允許」，這樣之後有人新增頁面卻忘了設權限時，
// 失誤的方向是「管理員以外的人進不去」，而不是「所有人都看得到不該看的東西」。
const ROUTE_ACCESS: Record<string, AdminRole[]> = {
  '/': ['admin', 'staff', 'viewer'],
  '/orders': ['admin', 'staff', 'viewer'],
  '/room-calendar': ['admin', 'staff', 'viewer'],
  '/customers': ['admin', 'staff', 'viewer'],

  // 價格總覽：客服要查得到報價才能回答客人，但只有管理員能改（RLS 的設定類分層）
  '/room-pricing': ['admin', 'staff'],
  '/ai-service-center': ['admin', 'staff'],
  '/broadcast': ['admin', 'staff'],
  '/linens': ['admin', 'staff'],

  // 以下純管理員：機密設定、計價規則、帳號與稽核
  '/room-pricing/formula': ['admin'],
  '/standard-messages': ['admin'],
  '/message-variables': ['admin'],
  '/knowledge-base': ['admin'],
  '/room-spaces': ['admin'],
  '/system-settings': ['admin'],
  '/scheduled-tasks': ['admin'],
  '/accounts': ['admin'],
  '/operation-logs': ['admin'],
};

export function canAccessRoute(role: AdminRole | null | undefined, path: string): boolean {
  if (!role) return false;
  const allowed = ROUTE_ACCESS[path];
  if (!allowed) return role === 'admin'; // 未登記的路徑：預設只有管理員
  return allowed.includes(role);
}

/** 使用者登入後該落在哪一頁：優先首頁，沒權限就找第一個進得去的頁面。 */
export function defaultRouteFor(role: AdminRole | null | undefined): string {
  if (!role) return '/';
  if (canAccessRoute(role, '/')) return '/';
  const first = Object.keys(ROUTE_ACCESS).find((p) => canAccessRoute(role, p));
  return first || '/';
}

/** 唯讀角色不能寫入任何資料（跟 RLS 的 can_operate() 對應）。 */
export function canWrite(role: AdminRole | null | undefined): boolean {
  return role === 'admin' || role === 'staff';
}

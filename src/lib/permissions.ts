// ========================================================================
// 前端的角色與頁面權限對照表。
//
// 重要觀念：這一份只負責「介面上看不看得到、進不進得去」，不是安全防線。
// 真正的防線是資料庫的 RLS（見 supabase_schema.sql 第 9 節）——前端用的 anon key 是公開的，
// 任何人都能繞過畫面直接打 API，所以這裡的設定必須跟 RLS 的分層保持一致，
// 而不是拿來當作唯一的把關。這裡做的事情是讓使用者不會看到自己按了也會失敗的功能。
// ========================================================================

import { hasPermission } from '../app/permissions';
import { navigation, permissionForPath } from '../app/navigation';

/**
 * 舊的三級角色。權限管理 V2 之後真正的判斷依據是「權限集合」（app/permissions.ts＋PermissionContext），
 * 這個值只剩兩個用途：資料庫還沒升級時的對照來源、以及 is_owner()／舊 RLS 函式仍讀它。
 * 指派角色時由 legacyRoleFromPermissions() 反推寫回，不要再拿它做業務判斷（§59、§80）。
 */
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
// V2：路徑的權限由 app/navigation.ts 宣告（每個入口／頁籤各自的 permission），這裡只是轉接，
// 讓既有呼叫端（RequireAccess、defaultRouteFor）不用改。沒登記的路徑預設只有管理員能進。
/**
 * 路徑層級的守衛（權限管理 V2 §30、§56）：路徑的權限由 app/navigation.ts 宣告；
 * 沒登記的路徑一律 default deny——只有 system.manage 可進，之後有人加頁面忘了設權限時，
 * 失誤的方向是「進不去」而不是「大家都看得到」。
 */
export function canAccessRoute(granted: ReadonlySet<string> | readonly string[] | null | undefined, path: string): boolean {
  if (!granted) return false;
  const permission = permissionForPath(path);
  if (!permission) return hasPermission(granted, 'system.manage');
  return hasPermission(granted, permission);
}

/** 使用者登入後該落在哪一頁：優先工作台，沒權限就找第一個進得去的入口。 */
export function defaultRouteFor(granted: ReadonlySet<string> | readonly string[] | null | undefined): string {
  if (!granted) return '/';
  if (canAccessRoute(granted, '/')) return '/';
  for (const section of navigation) {
    for (const item of section.items) {
      if (hasPermission(granted, item.permission)) return item.path;
    }
  }
  return '/';
}

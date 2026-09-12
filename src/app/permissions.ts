// ========================================================================
// Permission-based 權限模型（V2 §71–74）
//
// 角色（admin / staff / viewer）保留，但前端改用「權限字串」判斷：頁面與按鈕宣告自己需要
// 哪個權限，角色 → 權限的對照只寫在這裡一處。加新頁面或新功能時不用改角色定義，
// 只要決定它屬於哪個權限。
//
// 這只是介面層的引導（選單顯示、路由導向、按鈕停用），不是安全防線——真正擋住資料的是
// 資料庫的 RLS 與 Functions 的 requireRole()。UI hidden 不等於權限控制（§74、§129-13）。
// ========================================================================

import type { AdminRole } from '../lib/permissions';

export const PERMISSIONS = [
  'dashboard.view',

  'booking.view',
  'booking.create',
  'booking.edit',
  'booking.payment',
  'booking.cancel',

  'calendar.view',

  'service.view',      // 客服工作台、對話紀錄
  'service.reply',
  'service.handover',
  'service.config',    // 對話流程、知識庫、訊息範本、客服規則

  'customer.view',
  'customer.edit',
  'customer.delete_personal_data',

  'marketing.view',
  'marketing.send',

  'inventory.view',
  'inventory.manage',

  'pricing.view',
  'pricing.manage',

  'housekeeping.view',
  'housekeeping.manage',

  'integration.view',
  'integration.manage',

  'automation.view',
  'automation.manage',

  'account.view',
  'account.manage',

  'audit.view',
  'system.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// 角色 → 權限。'*' 代表全部。
// staff 的範圍依 §109 頁面矩陣：日常營運可讀可寫，房型／價格只能看，碰不到串接、自動化、
// 帳號與系統設定。§73 另外列了 integration.view 給 staff，但 §109 的矩陣寫「-」，兩處矛盾時
// 取較嚴的（串接頁有 Token 等敏感資料，一般客服不需要看）。
const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[] | '*'> = {
  admin: '*',
  staff: [
    'dashboard.view',
    'booking.view', 'booking.create', 'booking.edit', 'booking.payment', 'booking.cancel',
    'calendar.view',
    'service.view', 'service.reply', 'service.handover',
    'customer.view', 'customer.edit',
    'marketing.view', 'marketing.send',
    'inventory.view',
    'pricing.view',
    'housekeeping.view', 'housekeeping.manage',
  ],
  viewer: [
    'dashboard.view',
    'booking.view',
    'calendar.view',
    'customer.view',
  ],
};

export function hasPermission(role: AdminRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  const granted = ROLE_PERMISSIONS[role];
  if (granted === '*') return true;
  return granted.includes(permission);
}

export function hasAnyPermission(role: AdminRole | null | undefined, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

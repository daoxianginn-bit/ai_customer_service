import type { ReactNode } from 'react';
import { Tooltip } from '@mui/material';
import { usePermissions } from './PermissionContext';
import { permissionName, type Permission } from './permissions';

// ========================================================================
// 依權限顯示／隱藏（權限管理 V2 §31）：
//   <Can permission="booking.refund.process"><Button>處理退款</Button></Can>
// 敏感操作沒權限預設直接隱藏；想讓使用者知道功能存在時用 mode="disabled"，會用 Tooltip 說明需要哪個權限。
// 這只是介面引導——真正擋住寫入的是 RLS 與 Functions 的 requirePermission。
// ========================================================================
export function Can({ permission, anyOf, children, fallback = null, mode = 'hide' }: {
  permission?: Permission;
  /** 任一個即可 */
  anyOf?: readonly Permission[];
  children: ReactNode;
  fallback?: ReactNode;
  mode?: 'hide' | 'disabled';
}) {
  const { hasPermission, hasAnyPermission } = usePermissions();
  const ok = permission ? hasPermission(permission) : anyOf ? hasAnyPermission(anyOf) : true;
  if (ok) return <>{children}</>;
  if (mode === 'disabled') {
    const need = permission || anyOf?.[0] || '';
    return (
      <Tooltip title={`需要「${permissionName(need)}」權限`}>
        <span style={{ display: 'inline-flex', opacity: 0.5, pointerEvents: 'none' }}>{children}</span>
      </Tooltip>
    );
  }
  return <>{fallback}</>;
}

export function usePermission(permission: Permission): boolean {
  return usePermissions().hasPermission(permission);
}

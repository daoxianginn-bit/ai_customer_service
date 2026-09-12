import type { ReactNode } from 'react';
import { useAuth } from '../lib/AuthContext';
import { hasPermission, type Permission } from './permissions';

// ========================================================================
// 依權限顯示／隱藏（V2 §74）：<Can permission="pricing.manage"><Button>編輯</Button></Can>
// 只是介面引導——沒權限的人看不到按鈕，但真正擋住寫入的是 RLS 與 Functions 的 requireRole。
// ========================================================================
export function Can({ permission, children, fallback = null }: { permission: Permission; children: ReactNode; fallback?: ReactNode }) {
  const { role } = useAuth();
  return <>{hasPermission(role, permission) ? children : fallback}</>;
}

export function usePermission(permission: Permission): boolean {
  const { role } = useAuth();
  return hasPermission(role, permission);
}

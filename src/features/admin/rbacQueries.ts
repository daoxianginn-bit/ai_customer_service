import { supabase } from '../../lib/supabase';
import type { AccountStatus, AdminRole } from '../../lib/permissions';

// ========================================================================
// 帳號與權限（權限管理 V2）的資料層。讀取直接查表（RLS：role.view／account.view），
// 寫入一律走 roles-admin function（相依、防提升、系統角色與最後管理者保護、稽核都在後端）。
// ========================================================================

export interface RoleRecord {
  id: string;
  code: string | null;
  name: string;
  description: string;
  is_system: boolean;
  is_active: boolean;
  sort_order: number;
  version: number;
  created_at: string;
  updated_at: string;
  permission_codes: string[];
  user_count: number;
}

export interface UserRecord {
  id: string;
  email: string | null;
  display_name: string | null;
  role: AdminRole;            // 舊三級角色（資料庫未升級時的來源）
  status: AccountStatus;
  last_sign_in_at: string | null;
  created_at: string;
  mfa_enrolled_at: string | null;
  role_ids: string[];
}

async function callFn(path: string, body?: unknown, method = 'POST') {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`/.netlify/functions/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
  if (!res.ok) {
    const err: any = new Error(parsed.error || parsed.message || text || '操作失敗');
    err.status = res.status;
    throw err;
  }
  return parsed;
}

export const rolesAdmin = (action: string, payload: Record<string, unknown> = {}) => callFn('roles-admin', { action, ...payload });

/** 角色清單（含權限 code 與使用者數）。 */
export async function fetchRoles(): Promise<RoleRecord[]> {
  const [{ data: roles, error }, { data: rp }, { data: ur }] = await Promise.all([
    supabase.from('roles').select('*').order('sort_order').order('name'),
    supabase.from('role_permissions').select('role_id, permissions(code, is_active)'),
    supabase.from('user_roles').select('role_id'),
  ]);
  if (error) throw error;
  const codesByRole = new Map<string, string[]>();
  for (const r of (rp || []) as any[]) {
    if (!r.permissions?.code || r.permissions.is_active === false) continue;
    codesByRole.set(r.role_id, [...(codesByRole.get(r.role_id) || []), r.permissions.code]);
  }
  const countByRole = new Map<string, number>();
  for (const r of (ur || []) as any[]) countByRole.set(r.role_id, (countByRole.get(r.role_id) || 0) + 1);
  return ((roles || []) as any[]).map((r) => ({ ...r, permission_codes: codesByRole.get(r.id) || [], user_count: countByRole.get(r.id) || 0 }));
}

export async function fetchRole(id: string): Promise<RoleRecord | null> {
  const all = await fetchRoles();
  return all.find((r) => r.id === id) || null;
}

/** 使用者清單（list-admins）＋每人的角色 id。 */
export async function fetchUsers(): Promise<UserRecord[]> {
  const [{ admins }, { data: ur }] = await Promise.all([
    callFn('list-admins', undefined, 'GET'),
    supabase.from('user_roles').select('user_id, role_id'),
  ]);
  const byUser = new Map<string, string[]>();
  for (const r of (ur || []) as any[]) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r.role_id]);
  return ((admins || []) as any[]).map((u) => ({ ...u, role_ids: byUser.get(u.id) || [] }));
}

export async function fetchRoleUsers(roleId: string): Promise<UserRecord[]> {
  const users = await fetchUsers();
  return users.filter((u) => u.role_ids.includes(roleId));
}

export interface ChangeLogRow { id: string; action: string; actor_name: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; created_at: string; target: string | null }

/** 角色或使用者的變更紀錄（operation_logs，feature 帳號與權限）。 */
export async function fetchRbacLogs(target: string): Promise<ChangeLogRow[]> {
  const { data, error } = await supabase
    .from('operation_logs')
    .select('id, action, actor_name, before, after, created_at, target')
    .eq('feature', '帳號與權限')
    .eq('target', target)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []) as ChangeLogRow[];
}

export async function fetchUserLogs(actorEmail: string): Promise<ChangeLogRow[]> {
  const { data, error } = await supabase
    .from('operation_logs')
    .select('id, action, actor_name, before, after, created_at, target, feature')
    .eq('actor_name', actorEmail)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []) as ChangeLogRow[];
}

export async function fetchPrimaryAdmin(): Promise<{ settingsId: string | null; primaryAdminId: string | null }> {
  const { data } = await supabase.from('settings').select('id, primary_admin_id').limit(1).maybeSingle();
  return { settingsId: data?.id || null, primaryAdminId: data?.primary_admin_id || null };
}

export interface Grantable { isOwner: boolean; grantable: Set<string> | null }
export async function fetchGrantable(): Promise<Grantable> {
  const res = await rolesAdmin('my_grantable');
  return { isOwner: !!res.is_owner, grantable: res.grantable ? new Set<string>(res.grantable) : null };
}

// ---------------- 使用者操作（帳號頁與使用者詳情共用） ----------------

export async function setUserStatus(userId: string, status: AccountStatus) {
  const { error } = await supabase.from('admin_profiles').update({ status, updated_at: new Date().toISOString() }).eq('id', userId);
  if (error) throw new Error(error.message);
}

export const resetUserMfa = (userId: string) => callFn('mfa', { action: 'reset', userId });
export const deleteUser = (userId: string) => callFn('delete-admin', { userId });

export interface InviteResult { email: string; mailSent: boolean; mailError: string | null; inviteUrl: string }
export function inviteUser(input: { email: string; roleIds: string[]; role?: AdminRole }): Promise<InviteResult> {
  return callFn('invite-admin', { email: input.email, roleIds: input.roleIds, role: input.role || 'staff' });
}

export const assignUserRoles = (userId: string, roleIds: string[]) => rolesAdmin('assign_user', { user_id: userId, role_ids: roleIds });

/** 還沒有主帳號時，由目前登入者認領（只有在 primary_admin_id 為空時才會成功） */
export async function claimPrimaryAdmin(settingsId: string, userId: string) {
  const { error } = await supabase.from('settings').update({ primary_admin_id: userId }).eq('id', settingsId).is('primary_admin_id', null);
  if (error) throw new Error(error.message);
}

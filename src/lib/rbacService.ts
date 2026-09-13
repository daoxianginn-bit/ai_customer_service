import type { SupabaseClient } from '@supabase/supabase-js';
import { effectivePermissions, legacyRoleFromPermissions, permissionName, withDependencies, PERMISSION_CATALOG, type LegacyRole } from '../app/permissions';
import { LOG_FEATURES, writeOperationLog } from './operationLog';

// ========================================================================
// 權限管理 V2 的後端服務（附錄 C）：角色的讀寫、指派、稽核與保護規則。
// 只在 Netlify Functions（service role）裡使用——roles／role_permissions／user_roles 的寫入 RLS 全部關閉，
// 所有變更都要經過這裡的檢查：
//   - 相依補齊：勾 edit 一定帶 view（§20）
//   - 防止權限提升：只能授予自己擁有的權限，主帳號例外（§40）
//   - 系統角色不可改權限／停用／刪除（§8）；有使用者的角色不可刪（§38）
//   - 最後管理者保護：不能讓系統沒有任何一個能管角色與帳號的啟用帳號（§39）
//   - 樂觀鎖：帶 expected_version，被別人改過就拒絕（§55）
//   - 每個變更寫操作紀錄，權限異動記 新增／移除 的中文名稱（§41）
//   - 指派後把舊的三級角色反推寫回 admin_profiles.role，給尚未改用 has_permission() 的舊邏輯（is_owner 等）用
// ========================================================================

export const RBAC_LOG_FEATURE = LOG_FEATURES.permission;

export class RbacError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); }
}

export interface RoleRow {
  id: string; code: string | null; name: string; description: string; is_system: boolean; is_active: boolean; sort_order: number; version: number;
  created_at: string; updated_at: string;
}

const ADMIN_CORE = ['role.manage', 'account.edit']; // 「最高管理者」的定義：能管角色也能管帳號

export async function loadCatalogIds(db: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await db.from('permissions').select('id, code').eq('is_active', true);
  if (error) throw new RbacError(`讀取權限目錄失敗：${error.message}`, 500);
  return new Map((data || []).map((p: any) => [p.code, p.id]));
}

export async function loadRolePermissionCodes(db: SupabaseClient, roleId: string): Promise<string[]> {
  const { data, error } = await db.from('role_permissions').select('permissions(code)').eq('role_id', roleId);
  if (error) throw new RbacError(`讀取角色權限失敗：${error.message}`, 500);
  return (data || []).map((r: any) => r.permissions?.code).filter(Boolean);
}

/** 使用者的有效權限（多角色聯集，停用角色排除；主帳號全部） */
export async function loadUserPermissions(db: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data: settings } = await db.from('settings').select('primary_admin_id').limit(1).maybeSingle();
  if (settings?.primary_admin_id === userId) return new Set(PERMISSION_CATALOG.map((p) => p.code));
  const { data } = await db.from('user_roles').select('roles(id, is_active, role_permissions(permissions(code)))').eq('user_id', userId);
  const roles = (data || []).map((r: any) => ({
    isActive: !!r.roles?.is_active,
    permissions: (r.roles?.role_permissions || []).map((rp: any) => rp.permissions?.code).filter(Boolean) as string[],
  }));
  if (roles.length === 0) {
    // 尚未指派角色：跟資料庫 has_permission_for 一樣用舊角色對照
    const { data: prof } = await db.from('admin_profiles').select('role').eq('id', userId).maybeSingle();
    const { data: tmpl } = await db.from('roles').select('id').eq('code', legacyTemplateCode(prof?.role)).maybeSingle();
    if (!tmpl) return new Set();
    return new Set(await loadRolePermissionCodes(db, tmpl.id));
  }
  return effectivePermissions(roles);
}

function legacyTemplateCode(role: string | null | undefined): string {
  return role === 'admin' ? 'sys_admin' : role === 'staff' ? 'staff' : 'viewer';
}

async function logRbac(db: SupabaseClient, actorName: string, action: string, target: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  await writeOperationLog(db, { feature: RBAC_LOG_FEATURE, action, target, actorType: 'user', actorName, before, after });
}

const names = (codes: Iterable<string>) => [...codes].map(permissionName).join('、');

export interface SaveRoleInput {
  id?: string | null;
  name: string;
  description?: string;
  permission_codes: string[];
  expected_version?: number | null;
}

/**
 * 建立或更新角色。呼叫者只能授予自己擁有的權限（主帳號例外）；相依自動補齊；
 * 系統角色只能改名稱與說明。回傳存好的角色與這次的 新增／移除。
 */
export async function saveRole(db: SupabaseClient, actor: { id: string; email: string; isOwner: boolean }, input: SaveRoleInput) {
  const name = String(input.name || '').trim();
  if (!name) throw new RbacError('請輸入角色名稱');
  if (name.length > 40) throw new RbacError('角色名稱請在 40 字以內');
  const description = String(input.description || '').trim();

  const catalog = await loadCatalogIds(db);
  const requested = withDependencies((input.permission_codes || []).filter((c) => catalog.has(c)));

  let roleId = input.id || null;
  let before: string[] = [];
  let existing: RoleRow | null = null;
  if (roleId) {
    const { data, error } = await db.from('roles').select('*').eq('id', roleId).maybeSingle();
    if (error) throw new RbacError(error.message, 500);
    if (!data) throw new RbacError('找不到這個角色', 404);
    existing = data as RoleRow;
    if (input.expected_version != null && existing.version !== input.expected_version) {
      throw new RbacError('此角色已被其他人更新，請重新載入最新內容後再儲存。', 409);
    }
    before = await loadRolePermissionCodes(db, roleId);
  }

  // 防止權限提升（§40）：只看「這次新加的」——角色原本就有、但呼叫者自己沒有的權限保留不動，
  // 否則系統管理員連改一下角色說明都會因為裡面有主帳號專屬權限而被擋
  if (!actor.isOwner) {
    const mine = await loadUserPermissions(db, actor.id);
    const beyond = [...requested].filter((c) => !mine.has(c) && !before.includes(c));
    if (beyond.length) throw new RbacError(`你不能授予自己沒有的權限：${names(beyond)}`, 403);
  }

  // 名稱不重複（大小寫不分）
  const { data: dup } = await db.from('roles').select('id').ilike('name', name).neq('id', roleId || '00000000-0000-0000-0000-000000000000').limit(1);
  if (dup?.length) throw new RbacError('已經有同名的角色');

  // 最後管理者保護（§39）先於寫入：這次若拿掉這個角色的管理權限，系統其他人還得有人能管角色與帳號
  if (existing && !existing.is_system && ADMIN_CORE.some((c) => before.includes(c) && !requested.has(c))) {
    await assertAdminRemains(db, { excludeRoleId: existing.id });
  }

  const nowIso = new Date().toISOString();
  if (!existing) {
    const { data, error } = await db.from('roles').insert({ name, description, created_by: actor.id, updated_by: actor.id }).select('*').single();
    if (error) throw new RbacError(`建立角色失敗：${error.message}`, 500);
    existing = data as RoleRow;
    roleId = existing.id;
  } else {
    const { error } = await db.from('roles').update({ name, description, updated_at: nowIso, updated_by: actor.id, version: existing.version + 1 }).eq('id', roleId);
    if (error) throw new RbacError(`更新角色失敗：${error.message}`, 500);
  }

  // 系統角色（super_admin）的權限固定全部，不由這裡改
  let added: string[] = [];
  let removed: string[] = [];
  if (!existing.is_system) {
    added = [...requested].filter((c) => !before.includes(c));
    removed = before.filter((c) => !requested.has(c));
    if (removed.length) {
      const ids = removed.map((c) => catalog.get(c)).filter(Boolean) as string[];
      const { error } = await db.from('role_permissions').delete().eq('role_id', roleId!).in('permission_id', ids);
      if (error) throw new RbacError(`移除權限失敗：${error.message}`, 500);
    }
    if (added.length) {
      const rows = added.map((c) => ({ role_id: roleId!, permission_id: catalog.get(c)!, created_by: actor.id }));
      const { error } = await db.from('role_permissions').insert(rows);
      if (error) throw new RbacError(`新增權限失敗：${error.message}`, 500);
    }
  }

  // 這個角色底下的使用者，舊三級角色重新反推
  await syncLegacyRolesForRole(db, roleId!);

  const changes: Record<string, unknown> = {};
  if (existing.name !== name && input.id) { changes['角色名稱'] = `${existing.name} → ${name}`; }
  if ((existing.description || '') !== description && input.id) { changes['角色說明'] = description || '（清空）'; }
  await logRbac(db, actor.email, input.id ? '修改角色' : '建立角色', name,
    input.id ? { 移除權限: removed.length ? names(removed) : '（無）', ...(existing.name !== name ? { 角色名稱: existing.name } : {}) } : null,
    { 新增權限: added.length ? names(added) : '（無）', ...changes, ...(input.id ? {} : { 權限數: requested.size }) });

  const { data: saved } = await db.from('roles').select('*').eq('id', roleId!).single();
  return { role: saved as RoleRow, added, removed, permission_codes: [...requested] };
}

export async function setRoleActive(db: SupabaseClient, actor: { id: string; email: string }, roleId: string, isActive: boolean) {
  const { data: role, error } = await db.from('roles').select('*').eq('id', roleId).maybeSingle();
  if (error) throw new RbacError(error.message, 500);
  if (!role) throw new RbacError('找不到這個角色', 404);
  if (role.is_system) throw new RbacError('系統角色不可停用', 400);
  if (!isActive) await assertAdminRemains(db, { excludeRoleId: roleId });
  const { error: upErr } = await db.from('roles').update({ is_active: isActive, updated_at: new Date().toISOString(), updated_by: actor.id, version: role.version + 1 }).eq('id', roleId);
  if (upErr) throw new RbacError(upErr.message, 500);
  await syncLegacyRolesForRole(db, roleId);
  const { count } = await db.from('user_roles').select('user_id', { count: 'exact', head: true }).eq('role_id', roleId);
  await logRbac(db, actor.email, isActive ? '啟用角色' : '停用角色', role.name, { 狀態: role.is_active ? '啟用' : '停用' }, { 狀態: isActive ? '啟用' : '停用', 影響使用者數: count ?? 0 });
}

export async function deleteRole(db: SupabaseClient, actor: { id: string; email: string }, roleId: string) {
  const { data: role } = await db.from('roles').select('*').eq('id', roleId).maybeSingle();
  if (!role) throw new RbacError('找不到這個角色', 404);
  if (role.is_system) throw new RbacError('系統角色不可刪除', 400);
  const { count } = await db.from('user_roles').select('user_id', { count: 'exact', head: true }).eq('role_id', roleId);
  if ((count ?? 0) > 0) throw new RbacError(`無法刪除角色：目前有 ${count} 位使用者。請先指派其他角色或停用此角色。`, 409);
  const codes = await loadRolePermissionCodes(db, roleId);
  const { error } = await db.from('roles').delete().eq('id', roleId);
  if (error) throw new RbacError(error.message, 500);
  await logRbac(db, actor.email, '刪除角色', role.name, { 權限: codes.length ? names(codes) : '（無）' }, null);
}

/** 指派使用者的角色（整組取代）。 */
export async function assignUserRoles(db: SupabaseClient, actor: { id: string; email: string; isOwner: boolean }, userId: string, roleIds: string[]) {
  const { data: profile } = await db.from('admin_profiles').select('id, email, display_name, role').eq('id', userId).maybeSingle();
  if (!profile) throw new RbacError('找不到這個使用者', 404);
  const unique = [...new Set(roleIds)];
  const { data: roles } = unique.length ? await db.from('roles').select('id, name, is_active, is_system').in('id', unique) : { data: [] as any[] };
  if ((roles || []).length !== unique.length) throw new RbacError('有角色不存在');
  const inactive = (roles || []).filter((r: any) => !r.is_active);
  if (inactive.length) throw new RbacError(`已停用的角色不能指派：${inactive.map((r: any) => r.name).join('、')}`);

  const { data: currentRowsRaw } = await db.from('user_roles').select('role_id, roles(name)').eq('user_id', userId);
  const currentRows = (currentRowsRaw || []) as any[];
  const currentIds = (currentRows || []).map((r: any) => r.role_id as string);
  const toAdd = unique.filter((id) => !currentIds.includes(id));
  const toRemove = currentIds.filter((id) => !unique.includes(id));

  // 防止權限提升：新指派出去的角色所含權限，呼叫者自己都要有（主帳號例外）；原本就有的角色保留不查
  if (!actor.isOwner && toAdd.length) {
    const mine = await loadUserPermissions(db, actor.id);
    for (const r of (roles || []).filter((x: any) => toAdd.includes(x.id))) {
      const codes = await loadRolePermissionCodes(db, r.id);
      const beyond = codes.filter((c) => !mine.has(c));
      if (beyond.length) throw new RbacError(`你不能指派「${r.name}」：它包含你沒有的權限（${names(beyond)}）`, 403);
    }
  }

  // 最後管理者保護先於寫入：把這位使用者換成新角色組合之後，系統還得有人能管角色與帳號
  await assertAdminRemains(db, { overrideUser: { id: userId, roleIds: unique } });

  if (toRemove.length) await db.from('user_roles').delete().eq('user_id', userId).in('role_id', toRemove);
  if (toAdd.length) await db.from('user_roles').insert(toAdd.map((role_id) => ({ user_id: userId, role_id, created_by: actor.id })));

  const legacy = await syncLegacyRole(db, userId);
  const nameOf = (id: string) => (roles || []).find((r: any) => r.id === id)?.name || (currentRows || []).find((r: any) => r.role_id === id)?.roles?.name || id;
  await logRbac(db, actor.email, '指派角色', profile.email || profile.display_name || userId,
    { 角色: currentIds.length ? currentIds.map(nameOf).join('、') : '（無）' },
    { 角色: unique.length ? unique.map(nameOf).join('、') : '（無）', 舊角色對照: legacy });
  return { added: toAdd, removed: toRemove, legacyRole: legacy };
}

/** 依有效權限反推舊三級角色寫回 admin_profiles.role；主帳號固定 admin。 */
export async function syncLegacyRole(db: SupabaseClient, userId: string): Promise<LegacyRole> {
  const { data: settings } = await db.from('settings').select('primary_admin_id').limit(1).maybeSingle();
  let legacy: LegacyRole;
  if (settings?.primary_admin_id === userId) legacy = 'admin';
  else {
    const { count } = await db.from('user_roles').select('role_id', { count: 'exact', head: true }).eq('user_id', userId);
    if (!count) return (await db.from('admin_profiles').select('role').eq('id', userId).maybeSingle()).data?.role || 'viewer';
    legacy = legacyRoleFromPermissions(await loadUserPermissions(db, userId));
  }
  await db.from('admin_profiles').update({ role: legacy, updated_at: new Date().toISOString() }).eq('id', userId);
  return legacy;
}

async function syncLegacyRolesForRole(db: SupabaseClient, roleId: string) {
  const { data } = await db.from('user_roles').select('user_id').eq('role_id', roleId);
  for (const r of data || []) await syncLegacyRole(db, r.user_id);
}

/**
 * 系統至少要留一位「啟用、能管角色也能管帳號」的帳號；主帳號永遠算數。
 * 在寫入之前模擬：excludeRoleId＝假設這個角色沒了（停用／拿掉管理權限）；
 * overrideUser＝假設這位使用者改成這組角色。supabase-js 沒有交易，所以只能先算再寫。
 */
export async function assertAdminRemains(db: SupabaseClient, sim: { excludeRoleId?: string; overrideUser?: { id: string; roleIds: string[] }; excludeUserId?: string } = {}) {
  const { data: settings } = await db.from('settings').select('primary_admin_id').limit(1).maybeSingle();
  if (settings?.primary_admin_id) {
    const { data: owner } = await db.from('admin_profiles').select('status').eq('id', settings.primary_admin_id).maybeSingle();
    if (owner?.status === 'active' && settings.primary_admin_id !== sim.excludeUserId) return;
  }
  const { data: actives } = await db.from('admin_profiles').select('id, role').eq('status', 'active').neq('id', sim.excludeUserId || '00000000-0000-0000-0000-000000000000');
  const { data: roleRows } = await db.from('roles').select('id, code, is_active, role_permissions(permissions(code))');
  const roleMap = new Map<string, { isActive: boolean; permissions: string[] }>();
  for (const r of (roleRows || []) as any[]) {
    roleMap.set(r.id, { isActive: r.is_active && r.id !== sim.excludeRoleId, permissions: (r.role_permissions || []).map((rp: any) => rp.permissions?.code).filter(Boolean) });
  }
  const templateByCode = new Map<string, string>();
  for (const r of (roleRows || []) as any[]) if (r.code) templateByCode.set(r.code, r.id);
  const { data: allUserRoles } = await db.from('user_roles').select('user_id, role_id');
  for (const p of actives || []) {
    let roleIds = (allUserRoles || []).filter((ur: any) => ur.user_id === p.id).map((ur: any) => ur.role_id as string);
    if (sim.overrideUser && sim.overrideUser.id === p.id) roleIds = sim.overrideUser.roleIds;
    if (roleIds.length === 0) {
      const tmpl = templateByCode.get(legacyTemplateCode(p.role));
      roleIds = tmpl ? [tmpl] : [];
    }
    const perms = effectivePermissions(roleIds.map((id) => roleMap.get(id)).filter(Boolean) as { isActive: boolean; permissions: string[] }[]);
    if (ADMIN_CORE.every((c) => perms.has(c))) return;
  }
  throw new RbacError('這個變更會讓系統沒有任何能管理角色與帳號的管理員，已取消。', 409);
}

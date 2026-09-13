import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import { hasAllPermissions, hasAnyPermission, hasPermission, legacyRolePermissions } from './permissions';

// ========================================================================
// PermissionProvider（權限管理 V2 §27–28、§72–73）：登入且通過 2FA 之後，向資料庫要「這個人有哪些
// 有效權限」（my_permissions()：多角色聯集、停用角色排除、主帳號全給、沒指派角色的舊帳號用舊角色對照）。
//
// 為什麼不放進 JWT（§74）：權限改了要下一次請求就生效，不能等重新登入。這裡在視窗重新取得焦點、
// 收到 403 時重新抓；角色頁儲存後也會呼叫 refresh()。
//
// 資料庫還沒跑過權限 migration（my_permissions 不存在）時退回舊角色對照（§76 過渡策略），
// 前端不會因此壞掉；等 schema 更新後自動改用新模型。
//
// preview：角色頁的「以此角色預覽」只換掉前端看到的權限集合（側欄、頁籤、按鈕），
// 寫入 API 與 RLS 仍用真實身分——預覽只能看，不能做。
// ========================================================================

export interface RoleSummary { id: string; code: string | null; name: string }

interface PermissionValue {
  /** 尚未取得權限前為 false；外殼在這之前只顯示「驗證帳號與權限…」，不先畫出完整側欄再消失（§72） */
  loaded: boolean;
  permissions: ReadonlySet<string>;
  roles: RoleSummary[];
  /** 是否為主帳號（settings.primary_admin_id） */
  isOwner: boolean;
  /** 是否走舊角色對照（資料庫尚未升級） */
  legacy: boolean;
  hasPermission: (code: string) => boolean;
  hasAnyPermission: (codes: readonly string[]) => boolean;
  hasAllPermissions: (codes: readonly string[]) => boolean;
  refresh: () => Promise<void>;
  /** 角色預覽：傳 null 結束預覽 */
  preview: { roleName: string; permissions: ReadonlySet<string> } | null;
  setPreview: (p: { roleName: string; permissions: Iterable<string> } | null) => void;
}

const PermissionContext = createContext<PermissionValue | null>(null);

interface MyPermissionsRow { roles: RoleSummary[]; permissions: string[]; is_owner: boolean; version?: number }

export function PermissionProvider({ children }: { children: ReactNode }) {
  const { phase, profile, session } = useAuth();
  const [loaded, setLoaded] = useState(false);
  const [real, setReal] = useState<{ permissions: Set<string>; roles: RoleSummary[]; isOwner: boolean; legacy: boolean }>({ permissions: new Set(), roles: [], isOwner: false, legacy: false });
  const [preview, setPreviewState] = useState<{ roleName: string; permissions: ReadonlySet<string> } | null>(null);
  const versionRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (phase !== 'ready' || !profile) { setReal({ permissions: new Set(), roles: [], isOwner: false, legacy: false }); setLoaded(phase !== 'loading'); return; }
    const { data, error } = await supabase.rpc('my_permissions');
    if (error) {
      // 42883／PGRST202＝函式不存在（schema 還沒升級）；其他錯誤也退回舊對照，寧可少給也不要整個後台空白
      const legacyPerms = new Set(legacyRolePermissions(profile.role));
      let isOwner = false;
      try {
        const { data: s } = await supabase.from('settings').select('primary_admin_id').limit(1).maybeSingle();
        isOwner = !!s?.primary_admin_id && s.primary_admin_id === profile.id;
      } catch { /* settings 對非管理員讀不到，當作不是主帳號 */ }
      if (isOwner) for (const c of ['customer.personal_data.delete', 'primary_admin.manage']) legacyPerms.add(c);
      setReal({ permissions: legacyPerms, roles: [{ id: 'legacy', code: profile.role, name: profile.role === 'admin' ? '管理員（舊）' : profile.role === 'staff' ? '客服人員（舊）' : '唯讀（舊）' }], isOwner, legacy: true });
      setLoaded(true);
      return;
    }
    const row = (Array.isArray(data) ? data[0] : data) as MyPermissionsRow | null;
    versionRef.current = row?.version ?? null;
    setReal({ permissions: new Set(row?.permissions || []), roles: row?.roles || [], isOwner: !!row?.is_owner, legacy: false });
    setLoaded(true);
  }, [phase, profile]);

  useEffect(() => { load(); }, [load, session?.access_token]);

  // 視窗回到前景時重新抓：另一位管理員改了角色，這邊下一個動作前就會拿到新權限（§73）
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible' && phase === 'ready') load(); };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); };
  }, [load, phase]);

  const effective = preview ? preview.permissions : real.permissions;

  const value = useMemo<PermissionValue>(() => ({
    loaded,
    permissions: effective,
    roles: real.roles,
    isOwner: preview ? false : real.isOwner,
    legacy: real.legacy,
    hasPermission: (code) => hasPermission(effective, code),
    hasAnyPermission: (codes) => hasAnyPermission(effective, codes),
    hasAllPermissions: (codes) => hasAllPermissions(effective, codes),
    refresh: load,
    preview,
    setPreview: (p) => setPreviewState(p ? { roleName: p.roleName, permissions: new Set(p.permissions) } : null),
  }), [loaded, effective, real.roles, real.isOwner, real.legacy, preview, load]);

  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissions(): PermissionValue {
  const ctx = useContext(PermissionContext);
  if (!ctx) throw new Error('usePermissions 必須在 <PermissionProvider> 內使用');
  return ctx;
}

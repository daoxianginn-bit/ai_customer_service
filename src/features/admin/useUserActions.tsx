import { useSnackbar } from 'notistack';
import { Chip, Stack, Tooltip, Typography } from '@mui/material';
import { useAuth } from '../../lib/AuthContext';
import { usePermissions } from '../../app/PermissionContext';
import { STATUS_DESCRIPTIONS, STATUS_LABELS, roleLabel, type AccountStatus } from '../../lib/permissions';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { deleteUser, resetUserMfa, setUserStatus, type RoleRecord, type UserRecord } from './rbacQueries';

// ========================================================================
// 使用者的停權／恢復／重置 2FA／移除：列表與詳情頁共用同一套規則與文案。
// 自己、主帳號不能動；「最後一個能管帳號與角色的人」由後端（delete-admin 的模擬檢查、
// 資料庫 guard_last_admin 觸發器）把關，前端只負責把錯誤訊息原樣顯示。
// ========================================================================

export const STATUS_COLOR: Record<AccountStatus, 'default' | 'info' | 'warning' | 'success'> = { invited: 'info', pending_mfa: 'warning', active: 'success', suspended: 'default' };

export function StatusChip({ status }: { status: AccountStatus }) {
  return <Tooltip title={STATUS_DESCRIPTIONS[status]}><Chip label={STATUS_LABELS[status]} size="small" color={STATUS_COLOR[status]} /></Tooltip>;
}

/** 使用者的角色 chips；還沒指派任何角色的舊帳號顯示舊三級角色 */
export function UserRoleChips({ user, roles }: { user: UserRecord; roles: RoleRecord[] }) {
  const assigned = user.role_ids.map((id) => roles.find((r) => r.id === id)).filter(Boolean) as RoleRecord[];
  if (!assigned.length) {
    return (
      <Tooltip title="尚未指派新制角色，依舊的三級角色對照取得權限">
        <Chip label={`${roleLabel(user.role)}（舊）`} size="small" variant="outlined" sx={{ height: 22 }} />
      </Tooltip>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {assigned.map((r) => (
        <Chip key={r.id} label={r.name} size="small" variant="outlined" color={r.is_active ? 'primary' : 'default'} sx={{ height: 22, ...(r.is_active ? {} : { textDecoration: 'line-through' }) }} />
      ))}
    </Stack>
  );
}

export function useUserActions(primaryAdminId: string | null, reload: () => Promise<void> | void) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { profile: me, refresh: refreshAuth } = useAuth();
  const { hasPermission } = usePermissions();

  const canEdit = hasPermission('account.edit');
  const canResetMfa = hasPermission('account.reset_mfa');
  const canDelete = hasPermission('account.delete');
  const canAssign = hasPermission('role.assign');

  const isMe = (u: UserRecord) => u.id === me?.id;
  const isPrimary = (u: UserRecord) => !!primaryAdminId && u.id === primaryAdminId;

  const suspendBlockReason = (u: UserRecord) => (!canEdit ? '沒有「編輯帳號」權限' : isMe(u) ? '不能停權自己的帳號' : isPrimary(u) ? '主帳號不能被停權' : null);
  const deleteBlockReason = (u: UserRecord) => (!canDelete ? '沒有「移除帳號」權限' : isMe(u) ? '不能刪除自己的帳號' : isPrimary(u) ? '主帳號不能被移除' : null);
  const assignBlockReason = (u: UserRecord) => (!canAssign ? '沒有「指派角色」權限' : isMe(u) ? '不能變更自己的角色，請由其他管理員操作' : isPrimary(u) ? '主帳號永遠擁有全部權限，不需要指派角色' : null);

  const toggleSuspend = async (u: UserRecord) => {
    const suspending = u.status !== 'suspended';
    if (suspending) {
      const reason = suspendBlockReason(u);
      if (reason) { enqueueSnackbar(reason, { variant: 'warning' }); return; }
      const ok = await confirm({ title: `確定要停權 ${u.email} 嗎？`, message: '停權後對方仍可用 Google 登入，但會立刻被系統擋下、進不到後台。之後可以隨時恢復。', confirmLabel: '停權', danger: true });
      if (!ok) return;
    }
    try {
      // 恢復時退回 pending_mfa 而不是 active：讓對方重新確認一次 2FA 才放行；已綁定驗證器的人登入時會直接走驗證頁
      await setUserStatus(u.id, suspending ? 'suspended' : 'pending_mfa');
      enqueueSnackbar(suspending ? `已停權 ${u.email}` : `已恢復 ${u.email}，對方下次登入需通過雙因素驗證`, { variant: 'success' });
      if (isMe(u)) await refreshAuth();
      await reload();
    } catch (e: any) { enqueueSnackbar(`更新失敗：${e.message}`, { variant: 'error' }); }
  };

  const resetMfa = async (u: UserRecord) => {
    if (!canResetMfa) { enqueueSnackbar('沒有「重置 2FA」權限', { variant: 'warning' }); return; }
    const ok = await confirm({ title: `重置 ${u.email} 的雙因素驗證？`, message: '對方目前綁定的驗證器會被解除，下次登入時必須重新掃描 QR Code 綁定。適用於對方遺失手機的情況。', confirmLabel: '重置 2FA', danger: true });
    if (!ok) return;
    try {
      await resetUserMfa(u.id);
      enqueueSnackbar(`已重置 ${u.email} 的雙因素驗證`, { variant: 'success' });
      await reload();
    } catch (e: any) { enqueueSnackbar(`重置失敗：${e.message}`, { variant: 'error' }); }
  };

  const remove = async (u: UserRecord): Promise<boolean> => {
    const reason = deleteBlockReason(u);
    if (reason) { enqueueSnackbar(reason, { variant: 'warning' }); return false; }
    const ok = await confirm({
      title: `確定要移除 ${u.email} 嗎？`,
      message: <Typography variant="body2">帳號會被永久刪除，無法復原。如果只是暫時不讓對方使用，建議改用「停權」。</Typography>,
      confirmLabel: '永久移除', danger: true,
    });
    if (!ok) return false;
    try {
      await deleteUser(u.id);
      enqueueSnackbar(`已移除 ${u.email}`, { variant: 'success' });
      await reload();
      return true;
    } catch (e: any) { enqueueSnackbar(`移除失敗：${e.message}`, { variant: 'error' }); return false; }
  };

  return { me, isMe, isPrimary, canEdit, canResetMfa, canDelete, canAssign, suspendBlockReason, deleteBlockReason, assignBlockReason, toggleSuspend, resetMfa, remove };
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Box, Button, Card, CardActionArea, CardContent, Chip, IconButton, InputAdornment, Menu, MenuItem, Skeleton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { Ban, CheckCircle2, MoreVertical, Search, ShieldCheck, ShieldOff, Trash2, UserPlus } from 'lucide-react';
import { usePermissions } from '../../app/PermissionContext';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatRelative } from '../../lib/format';
import { STATUS_LABELS, type AccountStatus } from '../../lib/permissions';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import DataTableMui, { type Column } from '../../components/ui-mui/DataTableMui';
import { claimPrimaryAdmin, fetchGrantable, fetchPrimaryAdmin, fetchRoles, fetchUsers, type RoleRecord, type UserRecord } from './rbacQueries';
import InviteUserDialog from './InviteUserDialog';
import { StatusChip, UserRoleChips, useUserActions } from './useUserActions';
import { LegacyDbAlert } from './RolesPage';

// ========================================================================
// 使用者列表（權限管理 V2 §42–44）：姓名／Email／角色／狀態／2FA／最後登入，篩選與邀請。
// 點一列進詳情（基本資料／角色／登入安全／有效權限／操作紀錄）；常用的停權、重置 2FA、移除也放在列的選單。
// ========================================================================

export default function UsersPage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const { isMobile } = useBreakpoint();
  const { hasPermission, legacy } = usePermissions();
  const canInvite = hasPermission('account.invite');

  const [users, setUsers] = useState<UserRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [grantable, setGrantable] = useState<ReadonlySet<string> | null>(null);
  const [primary, setPrimary] = useState<{ settingsId: string | null; primaryAdminId: string | null }>({ settingsId: null, primaryAdminId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<AccountStatus | ''>('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [menu, setMenu] = useState<{ el: HTMLElement; user: UserRecord } | null>(null);
  const [claiming, setClaiming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [u, r, p, g] = await Promise.all([
        fetchUsers(),
        fetchRoles().catch(() => [] as RoleRecord[]),
        fetchPrimaryAdmin().catch(() => ({ settingsId: null, primaryAdminId: null })),
        hasPermission('role.assign') ? fetchGrantable().catch(() => ({ isOwner: false, grantable: null })) : Promise.resolve({ isOwner: false, grantable: null }),
      ]);
      setUsers(u); setRoles(r); setPrimary(p); setGrantable(g.grantable);
    } catch (e: any) { setError(e.message || '讀取帳號清單失敗'); } finally { setLoading(false); }
  }, [hasPermission]);
  useEffect(() => { load(); }, [load]);

  const actions = useUserActions(primary.primaryAdminId, load);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rank = (s: AccountStatus) => (s === 'invited' ? 0 : s === 'pending_mfa' ? 1 : s === 'active' ? 2 : 3);
    return users
      .filter((u) => {
        if (q && !((u.email || '').toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q))) return false;
        if (statusFilter && u.status !== statusFilter) return false;
        if (roleFilter === '__none' && u.role_ids.length > 0) return false;
        if (roleFilter && roleFilter !== '__none' && !u.role_ids.includes(roleFilter)) return false;
        return true;
      })
      // 尚未完成上線的帳號排前面：這一頁的主要工作就是盯著它們有沒有卡住
      .sort((a, b) => rank(a.status) - rank(b.status) || (a.email || '').localeCompare(b.email || ''));
  }, [users, search, roleFilter, statusFilter]);

  const stuckCount = users.filter((u) => u.status === 'invited' || u.status === 'pending_mfa').length;

  const claimPrimary = async () => {
    if (!primary.settingsId || !actions.me?.id) return;
    setClaiming(true);
    try { await claimPrimaryAdmin(primary.settingsId, actions.me.id); await load(); enqueueSnackbar('已將您設為主帳號', { variant: 'success' }); }
    catch (e: any) { enqueueSnackbar(`設定失敗：${e.message}`, { variant: 'error' }); }
    finally { setClaiming(false); }
  };

  const nameCell = (u: UserRecord) => (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2" fontWeight={600}>{u.display_name || u.email}</Typography>
        {actions.isMe(u) && <Typography variant="caption" color="primary.main">（你）</Typography>}
        {actions.isPrimary(u) && <Chip label="主帳號" size="small" color="warning" sx={{ height: 18, fontSize: 11 }} />}
      </Stack>
      {u.display_name && u.display_name !== u.email && <Typography variant="caption" color="text.secondary">{u.email}</Typography>}
    </Box>
  );

  const mfaCell = (u: UserRecord) => (u.mfa_enrolled_at
    ? <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'success.main' }}><ShieldCheck size={14} /><Typography variant="caption">已綁定</Typography></Stack>
    : <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'text.disabled' }}><ShieldOff size={14} /><Typography variant="caption">未綁定</Typography></Stack>);

  const menuButton = (u: UserRecord) => (
    <IconButton size="small" onClick={(e) => { e.stopPropagation(); setMenu({ el: e.currentTarget, user: u }); }} aria-label="更多操作"><MoreVertical size={16} /></IconButton>
  );

  const columns: Column<UserRecord>[] = [
    { key: 'name', header: '使用者', render: nameCell },
    { key: 'roles', header: '角色', render: (u) => <UserRoleChips user={u} roles={roles} /> },
    { key: 'status', header: '狀態', width: 110, render: (u) => <StatusChip status={u.status} /> },
    { key: 'mfa', header: '2FA', width: 110, nowrap: true, render: mfaCell },
    { key: 'last', header: '最後登入', width: 130, nowrap: true, render: (u) => <Typography variant="body2" color="text.secondary">{u.last_sign_in_at ? formatRelative(u.last_sign_in_at) : '尚未登入'}</Typography> },
  ];

  if (error) return <Box><PageHeaderV2 /><ResultState status={500} description={error} onRetry={load} backTo={false} /></Box>;

  return (
    <Box>
      <PageHeaderV2 action={canInvite ? <Button variant="contained" startIcon={<UserPlus size={16} />} onClick={() => setInviteOpen(true)}>邀請同事</Button> : undefined} />
      <LegacyDbAlert />

      {stuckCount > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>有 <strong>{stuckCount}</strong> 個帳號尚未完成上線（還沒用 Google 登入，或還沒綁定雙因素驗證），目前無法存取任何資料。</Alert>
      )}
      {!loading && !primary.primaryAdminId && actions.canEdit && (
        <Alert severity="info" sx={{ mb: 2 }} action={<Button size="small" onClick={claimPrimary} disabled={claiming}>{claiming ? '設定中…' : '將我設為主帳號'}</Button>}>
          目前還沒有設定「主帳號」。主帳號擁有全部權限、不能被其他管理員停權或移除，建議由老闆本人設定。
        </Alert>
      )}

      <Stack direction={isMobile ? 'column' : 'row'} spacing={1.5} sx={{ mb: 2 }}>
        <TextField size="small" placeholder="搜尋姓名或 Email" value={search} onChange={(e) => setSearch(e.target.value)} InputProps={{ startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> }} sx={{ minWidth: { md: 260 } }} />
        <TextField select size="small" label="角色" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} sx={{ minWidth: { md: 180 } }}>
          <MenuItem value="">全部</MenuItem>
          {roles.map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}
          <MenuItem value="__none">尚未指派角色</MenuItem>
        </TextField>
        <TextField select size="small" label="狀態" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as AccountStatus | '')} sx={{ minWidth: { md: 160 } }}>
          <MenuItem value="">全部</MenuItem>
          {(Object.keys(STATUS_LABELS) as AccountStatus[]).map((s) => <MenuItem key={s} value={s}>{STATUS_LABELS[s]}</MenuItem>)}
        </TextField>
      </Stack>

      {isMobile ? (
        <Stack spacing={1.5}>
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={96} />)}
          {!loading && visible.length === 0 && <ResultState status="empty" title={users.length ? '沒有符合條件的帳號' : '尚無任何帳號'} description="" backTo={false} />}
          {!loading && visible.map((u) => (
            <Card key={u.id} variant="outlined">
              <CardActionArea onClick={() => navigate(`/access/users/${u.id}`)}>
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                    {nameCell(u)}
                    {menuButton(u)}
                  </Stack>
                  <Box sx={{ mt: 1 }}><UserRoleChips user={u} roles={roles} /></Box>
                  <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 1 }}>
                    <StatusChip status={u.status} />
                    {mfaCell(u)}
                    <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{u.last_sign_in_at ? formatRelative(u.last_sign_in_at) : '尚未登入'}</Typography>
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      ) : (
        <DataTableMui
          columns={columns} rows={visible} rowKey={(u) => u.id} loading={loading}
          emptyMessage={users.length ? '沒有符合條件的帳號' : '尚無任何帳號'}
          onRowClick={(u) => navigate(`/access/users/${u.id}`)}
          rowActions={menuButton}
        />
      )}

      <Menu open={!!menu} anchorEl={menu?.el} onClose={() => setMenu(null)}>
        {menu && menu.user.status === 'active' && actions.canResetMfa && (
          <MenuItem onClick={() => { actions.resetMfa(menu.user); setMenu(null); }}><ShieldOff size={16} style={{ marginRight: 8 }} />重置雙因素驗證</MenuItem>
        )}
        {menu && actions.canEdit && (
          <Tooltip title={(menu.user.status !== 'suspended' && actions.suspendBlockReason(menu.user)) || ''} placement="left"><span>
            <MenuItem disabled={menu.user.status !== 'suspended' && !!actions.suspendBlockReason(menu.user)} onClick={() => { actions.toggleSuspend(menu.user); setMenu(null); }}>
              {menu.user.status === 'suspended' ? <><CheckCircle2 size={16} style={{ marginRight: 8 }} />恢復帳號</> : <><Ban size={16} style={{ marginRight: 8 }} />停權</>}
            </MenuItem>
          </span></Tooltip>
        )}
        {menu && actions.canDelete && (
          <Tooltip title={actions.deleteBlockReason(menu.user) || ''} placement="left"><span>
            <MenuItem disabled={!!actions.deleteBlockReason(menu.user)} onClick={() => { actions.remove(menu.user); setMenu(null); }} sx={{ color: 'error.main' }}>
              <Trash2 size={16} style={{ marginRight: 8 }} />永久移除
            </MenuItem>
          </span></Tooltip>
        )}
      </Menu>

      <InviteUserDialog open={inviteOpen} onClose={() => setInviteOpen(false)} roles={roles} grantable={grantable} legacy={legacy} onInvited={load} />
    </Box>
  );
}

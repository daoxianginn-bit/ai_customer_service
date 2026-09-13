import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import { Alert, Box, Button, Card, CardContent, Chip, Divider, Grid, List, ListItem, ListItemText, Skeleton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { Ban, CheckCircle2, ChevronLeft, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';
import { usePermissions } from '../../app/PermissionContext';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { PERMISSION_CATALOG, legacyRolePermissions } from '../../app/permissions';
import { formatDateTime, formatRelative } from '../../lib/format';
import { roleLabel } from '../../lib/permissions';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import { assignUserRoles, fetchGrantable, fetchPrimaryAdmin, fetchRoles, fetchUserLogs, fetchUsers, type ChangeLogRow, type RoleRecord, type UserRecord } from './rbacQueries';
import { RoleCheckList } from './InviteUserDialog';
import { StatusChip, UserRoleChips, useUserActions } from './useUserActions';
import { RiskChip, groupByModule } from './PermissionMatrix';

// ========================================================================
// 使用者詳情（權限管理 V2 §45）：基本資料／角色／登入安全／有效權限／操作紀錄。
// 「有效權限」是多角色聯集的結果，每一項標出來自哪個角色，管理員才看得懂為什麼這個人有這個權限。
// ========================================================================

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" component="div">{value ?? '—'}</Typography>
    </Box>
  );
}

export default function UserDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const { refresh: refreshPermissions } = usePermissions();

  const [user, setUser] = useState<UserRecord | null>(null);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [grantable, setGrantable] = useState<ReadonlySet<string> | null>(null);
  const [primary, setPrimary] = useState<{ settingsId: string | null; primaryAdminId: string | null }>({ settingsId: null, primaryAdminId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'notfound' | string | null>(null);
  const [tab, setTab] = useState<'profile' | 'roles' | 'security' | 'effective' | 'logs'>('profile');
  const [draftRoleIds, setDraftRoleIds] = useState<string[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);
  const [logs, setLogs] = useState<ChangeLogRow[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [users, r, p] = await Promise.all([fetchUsers(), fetchRoles().catch(() => [] as RoleRecord[]), fetchPrimaryAdmin().catch(() => ({ settingsId: null, primaryAdminId: null }))]);
      const u = users.find((x) => x.id === id) || null;
      if (!u) { setError('notfound'); return; }
      setUser(u); setRoles(r); setPrimary(p); setDraftRoleIds(u.role_ids);
      fetchGrantable().then((g) => setGrantable(g.grantable)).catch(() => setGrantable(null));
    } catch (e: any) { setError(e.message || '讀取失敗'); } finally { setLoading(false); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === 'logs' && logs === null && user) fetchUserLogs(user.email || '').then(setLogs).catch(() => setLogs([])); }, [tab, logs, user]);

  const actions = useUserActions(primary.primaryAdminId, load);

  const rolesDirty = !!user && (draftRoleIds.length !== user.role_ids.length || draftRoleIds.some((x) => !user.role_ids.includes(x)));
  useUnsavedChanges(rolesDirty && !savingRoles);

  const saveRoles = async () => {
    if (!user) return;
    setSavingRoles(true);
    try {
      await assignUserRoles(user.id, draftRoleIds);
      enqueueSnackbar('角色已更新，對方下一個動作起生效', { variant: 'success' });
      refreshPermissions();
      await load();
    } catch (e: any) { enqueueSnackbar(e.message || '指派失敗', { variant: 'error' }); } finally { setSavingRoles(false); }
  };

  // 有效權限：主帳號全部；有指派角色→啟用角色的聯集；沒有→舊角色對照
  const effective = useMemo(() => {
    const sources = new Map<string, string[]>();
    if (!user) return sources;
    const addAll = (codes: Iterable<string>, src: string) => { for (const c of codes) sources.set(c, [...(sources.get(c) || []), src]); };
    if (primary.primaryAdminId && user.id === primary.primaryAdminId) addAll(PERMISSION_CATALOG.map((p) => p.code), '主帳號');
    else if (user.role_ids.length) {
      for (const rid of user.role_ids) { const r = roles.find((x) => x.id === rid); if (r?.is_active) addAll(r.permission_codes, r.name); }
    } else addAll(legacyRolePermissions(user.role), `舊角色對照（${roleLabel(user.role)}）`);
    return sources;
  }, [user, roles, primary.primaryAdminId]);

  const backLink = <Button component={RouterLink} to="/admin/accounts" size="small" color="inherit" startIcon={<ChevronLeft size={16} />} sx={{ mb: 1, ml: -1 }}>使用者列表</Button>;

  if (error === 'notfound') return <Box>{backLink}<ResultState status={404} description="找不到這個使用者，可能已被移除。" backTo="/admin/accounts" /></Box>;
  if (error) return <Box>{backLink}<ResultState status={500} description={error} onRetry={load} backTo="/admin/accounts" /></Box>;
  if (loading || !user) return <Box>{backLink}<Skeleton width={240} height={36} /><Skeleton variant="rounded" height={240} sx={{ mt: 2 }} /></Box>;

  const assignReason = actions.assignBlockReason(user);
  const suspendReason = user.status !== 'suspended' ? actions.suspendBlockReason(user) : (actions.canEdit ? null : '沒有「編輯帳號」權限');
  const deleteReason = actions.deleteBlockReason(user);

  const profileTab = (
    <Card><CardContent>
      <Grid container spacing={2}>
        <Grid item xs={12} sm={6}><Field label="姓名" value={user.display_name || '（尚未登入，未取得 Google 名稱）'} /></Grid>
        <Grid item xs={12} sm={6}><Field label="Email" value={user.email} /></Grid>
        <Grid item xs={12} sm={6}><Field label="狀態" value={<StatusChip status={user.status} />} /></Grid>
        <Grid item xs={12} sm={6}><Field label="角色" value={<UserRoleChips user={user} roles={roles} />} /></Grid>
        <Grid item xs={12} sm={6}><Field label="建立時間" value={formatDateTime(user.created_at)} /></Grid>
        <Grid item xs={12} sm={6}><Field label="最後登入" value={user.last_sign_in_at ? `${formatDateTime(user.last_sign_in_at)}（${formatRelative(user.last_sign_in_at)}）` : '尚未登入'} /></Grid>
      </Grid>
      {actions.isPrimary(user) && <Alert severity="info" sx={{ mt: 2 }}>這是主帳號：永遠擁有全部權限，不能被停權、移除或指派角色。要換人請到「安全性」頁設定。</Alert>}
    </CardContent></Card>
  );

  const rolesTab = (
    <Card><CardContent>
      {assignReason ? <Alert severity="info" sx={{ mb: 2 }}>{assignReason}</Alert> : (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>可以勾多個角色，權限取聯集；已停用的角色不會生效。儲存後對方下一個動作起就用新權限。</Typography>
      )}
      {!user.role_ids.length && !actions.isPrimary(user) && (
        <Alert severity="warning" sx={{ mb: 2 }}>尚未指派新制角色，目前依舊角色「{roleLabel(user.role)}」對照取得權限；指派後以新角色為準。</Alert>
      )}
      <RoleCheckList roles={roles.filter((r) => r.is_active || draftRoleIds.includes(r.id))} value={draftRoleIds} onChange={setDraftRoleIds} grantable={grantable} disabled={!!assignReason} />
      {!assignReason && (
        <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button variant="outlined" onClick={() => setDraftRoleIds(user.role_ids)} disabled={!rolesDirty || savingRoles}>取消變更</Button>
          <Button variant="contained" onClick={saveRoles} disabled={!rolesDirty || savingRoles}>{savingRoles ? '儲存中…' : '儲存角色'}</Button>
        </Stack>
      )}
    </CardContent></Card>
  );

  const securityTab = (
    <Stack spacing={2}>
      <Card><CardContent>
        <Typography variant="subtitle2" gutterBottom>雙因素驗證</Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
          {user.mfa_enrolled_at
            ? <><ShieldCheck size={18} color="var(--mui-palette-success-main, #2e7d32)" /><Typography variant="body2">已綁定驗證器（{formatDateTime(user.mfa_enrolled_at)}）</Typography></>
            : <><ShieldOff size={18} /><Typography variant="body2" color="text.secondary">尚未綁定驗證器</Typography></>}
        </Stack>
        <Tooltip title={!actions.canResetMfa ? '沒有「重置 2FA」權限' : user.status !== 'active' ? '只有已啟用的帳號需要重置' : ''}><span>
          <Button variant="outlined" color="warning" startIcon={<ShieldOff size={16} />} onClick={() => actions.resetMfa(user)} disabled={!actions.canResetMfa || user.status !== 'active'}>重置雙因素驗證</Button>
        </span></Tooltip>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>對方遺失手機時使用：解除目前的驗證器，下次登入重新掃描 QR Code 綁定。</Typography>
      </CardContent></Card>

      <Card><CardContent>
        <Typography variant="subtitle2" gutterBottom>帳號狀態</Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}><StatusChip status={user.status} /><Typography variant="body2" color="text.secondary">最後登入：{user.last_sign_in_at ? formatRelative(user.last_sign_in_at) : '尚未登入'}</Typography></Stack>
        <Tooltip title={suspendReason || ''}><span>
          <Button variant="outlined" color={user.status === 'suspended' ? 'success' : 'warning'} startIcon={user.status === 'suspended' ? <CheckCircle2 size={16} /> : <Ban size={16} />} onClick={() => actions.toggleSuspend(user)} disabled={!!suspendReason}>
            {user.status === 'suspended' ? '恢復帳號' : '停權'}
          </Button>
        </span></Tooltip>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>停權保留帳號與設定，對方立刻進不了後台；之後可隨時恢復。</Typography>
      </CardContent></Card>

      <Card sx={{ borderColor: 'error.light' }} variant="outlined"><CardContent>
        <Typography variant="subtitle2" color="error.main" gutterBottom>永久移除</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>帳號會被永久刪除，無法復原。如果只是暫時不讓對方使用，請改用停權。</Typography>
        <Tooltip title={deleteReason || ''}><span>
          <Button variant="outlined" color="error" startIcon={<Trash2 size={16} />} disabled={!!deleteReason} onClick={async () => { if (await actions.remove(user)) navigate('/admin/accounts', { replace: true }); }}>永久移除帳號</Button>
        </span></Tooltip>
      </CardContent></Card>
    </Stack>
  );

  const effectiveGroups = groupByModule(effective.keys());
  const effectiveTab = (
    <Card><CardContent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>共 {effective.size} 項有效權限。每一項後面標示來自哪個角色；多個角色給同一項時只要其中一個有就算有（聯集）。</Typography>
      {effectiveGroups.length === 0 && <Alert severity="warning">這個帳號目前沒有任何權限，登入後會什麼都看不到。</Alert>}
      <Stack spacing={2}>
        {effectiveGroups.map((g) => (
          <Box key={g.module}>
            <Typography variant="subtitle2" gutterBottom>{g.label} <Typography component="span" variant="caption" color="text.secondary">{g.items.length} 項</Typography></Typography>
            <Stack spacing={0.5}>
              {g.items.map((p) => (
                <Stack key={p.code} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="body2">{p.name}</Typography>
                  <RiskChip risk={p.risk} />
                  <Typography variant="caption" color="text.secondary">來自：{(effective.get(p.code) || []).join('、')}</Typography>
                </Stack>
              ))}
            </Stack>
            <Divider sx={{ mt: 1.5 }} />
          </Box>
        ))}
      </Stack>
    </CardContent></Card>
  );

  const logsTab = logs === null
    ? <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={56} />)}</Stack>
    : logs.length === 0
      ? <ResultState status="empty" title="還沒有操作紀錄" description="這個帳號在後台做的異動會出現在這裡。" backTo={false} />
      : (
        <List disablePadding>
          {logs.map((r) => (
            <ListItem key={r.id} divider sx={{ px: 0 }}>
              <ListItemText
                primary={<Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap><Typography variant="body2" fontWeight={600}>{r.action}</Typography>{r.target && <Typography variant="body2" color="text.secondary">{r.target}</Typography>}</Stack>}
                secondary={`${(r as any).feature || ''}・${formatDateTime(r.created_at)}`}
              />
            </ListItem>
          ))}
        </List>
      );

  const body = tab === 'profile' ? profileTab : tab === 'roles' ? rolesTab : tab === 'security' ? securityTab : tab === 'effective' ? effectiveTab : logsTab;

  return (
    <Box>
      {backLink}
      <PageHeaderV2
        title={user.display_name || user.email || '使用者'}
        description={user.display_name ? user.email || undefined : undefined}
        adornment={<Stack direction="row" spacing={0.5}>{actions.isMe(user) && <Chip label="你" size="small" color="primary" variant="outlined" />}{actions.isPrimary(user) && <Chip label="主帳號" size="small" color="warning" />}</Stack>}
      />
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: '1px solid', borderColor: 'divider' }} variant="scrollable" allowScrollButtonsMobile>
        <Tab value="profile" label="基本資料" />
        <Tab value="roles" label="角色" />
        <Tab value="security" label="登入安全" />
        <Tab value="effective" label="有效權限" />
        <Tab value="logs" label="操作紀錄" />
      </Tabs>
      {body}
    </Box>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Box, Button, Card, CardActionArea, CardContent, Chip, FormControlLabel, IconButton, InputAdornment, Menu, MenuItem, Skeleton, Stack, Switch,
  TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { Eye, MoreVertical, Pencil, Plus, Power, Search, Trash2 } from 'lucide-react';
import { usePermissions } from '../../app/PermissionContext';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatRelative } from '../../lib/format';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import DataTableMui, { type Column } from '../../components/ui-mui/DataTableMui';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { fetchRoles, rolesAdmin, type RoleRecord } from './rbacQueries';
import { riskCounts } from './PermissionMatrix';

// ========================================================================
// 角色列表（權限管理 V2 §13–15）：名稱、說明、權限數、使用者數、狀態；新增／編輯／停用／刪除／預覽。
// 刪除只在沒有使用者時才開放，平常用「停用」（§38）；系統角色（Super Admin）兩者都不行（§8）。
// ========================================================================

export function LegacyDbAlert() {
  const { legacy } = usePermissions();
  if (!legacy) return null;
  return (
    <Alert severity="warning" sx={{ mb: 2 }}>
      資料庫尚未升級到權限管理 V2（找不到 <code>my_permissions()</code>）。請先在 Supabase SQL Editor 執行最新的 <code>supabase_schema.sql</code>；
      升級前所有帳號沿用舊的三級角色（管理員／客服／唯讀），這一頁的角色設定不會生效。
    </Alert>
  );
}

export default function RolesPage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const { hasPermission, refresh: refreshPermissions, setPreview } = usePermissions();
  const canManage = hasPermission('role.manage');

  const [rows, setRows] = useState<RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(true);
  const [menu, setMenu] = useState<{ el: HTMLElement; role: RoleRecord } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setRows(await fetchRoles()); } catch (e: any) { setError(e.message || '讀取角色失敗'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => (showInactive || r.is_active) && (!q || r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)));
  }, [rows, search, showInactive]);

  const preview = (role: RoleRecord) => {
    setPreview({ roleName: role.name, permissions: role.permission_codes });
    enqueueSnackbar(`正在以「${role.name}」的視角預覽，側欄與按鈕都會依這個角色顯示；預覽期間不能做任何修改。`, { variant: 'info' });
    navigate('/');
  };

  const toggleActive = async (role: RoleRecord) => {
    const disabling = role.is_active;
    if (disabling) {
      const ok = await confirm({
        title: `停用「${role.name}」？`,
        message: role.user_count > 0
          ? `目前有 ${role.user_count} 位使用者擁有這個角色，停用後他們會立即失去這個角色給的權限（其他角色不受影響）。角色設定會保留，可隨時再啟用。`
          : '角色設定會保留，可隨時再啟用。',
        confirmLabel: '停用', danger: true,
      });
      if (!ok) return;
    }
    setBusyId(role.id);
    try {
      await rolesAdmin('set_role_active', { id: role.id, is_active: !disabling });
      enqueueSnackbar(disabling ? `已停用「${role.name}」` : `已啟用「${role.name}」`, { variant: 'success' });
      await Promise.all([load(), refreshPermissions()]);
    } catch (e: any) { enqueueSnackbar(e.message || '操作失敗', { variant: 'error' }); } finally { setBusyId(null); }
  };

  const remove = async (role: RoleRecord) => {
    const ok = await confirm({
      title: `刪除「${role.name}」？`,
      message: '角色與它的權限設定會永久刪除，無法復原。如果之後可能還會用到，建議改用「停用」。',
      confirmLabel: '永久刪除', danger: true,
    });
    if (!ok) return;
    setBusyId(role.id);
    try {
      await rolesAdmin('delete_role', { id: role.id });
      enqueueSnackbar(`已刪除「${role.name}」`, { variant: 'success' });
      await load();
    } catch (e: any) { enqueueSnackbar(e.message || '刪除失敗', { variant: 'error' }); } finally { setBusyId(null); }
  };

  const deleteBlockReason = (r: RoleRecord) => (r.is_system ? '系統角色不可刪除' : r.user_count > 0 ? `目前有 ${r.user_count} 位使用者，請先改指派其他角色或停用` : null);

  const chips = (r: RoleRecord) => (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
      {r.is_system && <Chip label="系統角色" size="small" color="primary" variant="outlined" sx={{ height: 20, fontSize: 11 }} />}
      {!r.is_active && <Chip label="已停用" size="small" sx={{ height: 20, fontSize: 11 }} />}
    </Stack>
  );

  const riskSummary = (r: RoleRecord) => {
    const rc = riskCounts(r.permission_codes);
    return (
      <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="body2">{rc.total} 項</Typography>
        {rc.high > 0 && <Chip label={`高風險 ${rc.high}`} size="small" variant="outlined" color="error" sx={{ height: 20, fontSize: 11 }} />}
        {rc.medium > 0 && <Chip label={`敏感 ${rc.medium}`} size="small" variant="outlined" color="warning" sx={{ height: 20, fontSize: 11 }} />}
      </Stack>
    );
  };

  const actionsMenuButton = (r: RoleRecord) => (
    <IconButton size="small" onClick={(e) => { e.stopPropagation(); setMenu({ el: e.currentTarget, role: r }); }} disabled={busyId === r.id} aria-label="更多操作">
      <MoreVertical size={16} />
    </IconButton>
  );

  const columns: Column<RoleRecord>[] = [
    {
      key: 'name', header: '角色',
      render: (r) => (
        <Box sx={{ minWidth: 0 }}>
          <Stack direction="row" spacing={1} alignItems="center"><Typography variant="body2" fontWeight={600}>{r.name}</Typography>{chips(r)}</Stack>
          {r.description && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.description}</Typography>}
        </Box>
      ),
    },
    { key: 'permissions', header: '權限', width: 220, render: riskSummary },
    { key: 'users', header: '使用者', width: 100, align: 'right', render: (r) => <Typography variant="body2">{r.user_count}</Typography> },
    { key: 'updated_at', header: '最後更新', width: 140, nowrap: true, render: (r) => <Typography variant="body2" color="text.secondary">{formatRelative(r.updated_at)}</Typography> },
  ];

  if (error) {
    return (<Box><PageHeaderV2 /><ResultState status={500} description={error} onRetry={load} backTo={false} /></Box>);
  }

  return (
    <Box>
      <PageHeaderV2
        action={canManage ? <Button variant="contained" startIcon={<Plus size={16} />} onClick={() => navigate('/admin/roles/new')}>新增角色</Button> : undefined}
      />
      <LegacyDbAlert />

      <Stack direction={isMobile ? 'column' : 'row'} spacing={1.5} alignItems={isMobile ? 'stretch' : 'center'} sx={{ mb: 2 }}>
        <TextField
          size="small" placeholder="搜尋角色名稱或說明" value={search} onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> }}
          sx={{ minWidth: { md: 280 } }}
        />
        <FormControlLabel control={<Switch size="small" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />} label={<Typography variant="body2">顯示已停用</Typography>} />
      </Stack>

      {isMobile ? (
        <Stack spacing={1.5}>
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={88} />)}
          {!loading && visible.length === 0 && <ResultState status="empty" title="沒有角色" description={rows.length ? '沒有符合條件的角色' : '還沒有任何角色'} backTo={false} />}
          {!loading && visible.map((r) => (
            <Card key={r.id} variant="outlined">
              <CardActionArea onClick={() => navigate(`/admin/roles/${r.id}`)}>
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                    <Box sx={{ minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="subtitle2">{r.name}</Typography>{chips(r)}
                      </Stack>
                      {r.description && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.description}</Typography>}
                    </Box>
                    {actionsMenuButton(r)}
                  </Stack>
                  <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1 }}>
                    {riskSummary(r)}
                    <Typography variant="caption" color="text.secondary">{r.user_count} 位使用者</Typography>
                  </Stack>
                </CardContent>
              </CardActionArea>
            </Card>
          ))}
        </Stack>
      ) : (
        <DataTableMui
          columns={columns} rows={visible} rowKey={(r) => r.id} loading={loading}
          emptyMessage={rows.length ? '沒有符合條件的角色' : '還沒有任何角色'}
          onRowClick={(r) => navigate(`/admin/roles/${r.id}`)}
          rowActions={actionsMenuButton}
        />
      )}

      <Menu open={!!menu} anchorEl={menu?.el} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => { if (menu) navigate(`/admin/roles/${menu.role.id}`); setMenu(null); }}>
          <Pencil size={16} style={{ marginRight: 8 }} />{canManage && !menu?.role.is_system ? '編輯' : '查看'}
        </MenuItem>
        <MenuItem onClick={() => { if (menu) preview(menu.role); setMenu(null); }}>
          <Eye size={16} style={{ marginRight: 8 }} />以此角色預覽
        </MenuItem>
        {canManage && menu && !menu.role.is_system && (
          <MenuItem onClick={() => { toggleActive(menu.role); setMenu(null); }}>
            <Power size={16} style={{ marginRight: 8 }} />{menu.role.is_active ? '停用' : '啟用'}
          </MenuItem>
        )}
        {canManage && menu && (
          <Tooltip title={deleteBlockReason(menu.role) || ''} placement="left">
            <span>
              <MenuItem disabled={!!deleteBlockReason(menu.role)} onClick={() => { remove(menu.role); setMenu(null); }} sx={{ color: 'error.main' }}>
                <Trash2 size={16} style={{ marginRight: 8 }} />刪除
              </MenuItem>
            </span>
          </Tooltip>
        )}
      </Menu>
    </Box>
  );
}

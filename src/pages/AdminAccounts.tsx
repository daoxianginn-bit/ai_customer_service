import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  MenuItem, Stack, TextField, Tooltip, Typography, IconButton,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { UserCog, UserPlus, Trash2, ShieldCheck, Ban, CheckCircle2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import { ROLE_OPTIONS, STATUS_LABELS, roleLabel, type AdminRole, type AccountStatus } from '../lib/permissions';
import {
  PageHeaderMui, FilterPanel, DataTableMui, ResultState, useConfirm, type Column,
} from '../components/ui-mui';

interface AccountRow {
  id: string;
  email: string | null;
  display_name: string | null;
  role: AdminRole;
  status: AccountStatus;
  last_sign_in_at: string | null;
  created_at: string;
}

async function callFn(path: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`/.netlify/functions/${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${session?.access_token}` },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!res.ok) throw new Error(body.message || text || '操作失敗');
  return body;
}

const STATUS_COLOR: Record<AccountStatus, 'warning' | 'success' | 'default'> = {
  pending: 'warning',
  approved: 'success',
  disabled: 'default',
};

export default function AdminAccounts() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { profile: me, refreshProfile } = useAuth();

  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [primaryAdminId, setPrimaryAdminId] = useState<string | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  const [statusFilter, setStatusFilter] = useState<AccountStatus | ''>('');
  const [roleFilter, setRoleFilter] = useState<AdminRole | ''>('');
  const [applied, setApplied] = useState<{ status: AccountStatus | ''; role: AdminRole | '' }>({ status: '', role: '' });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AdminRole>('staff');
  const [inviting, setInviting] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { admins } = await callFn('list-admins', { method: 'GET' });
      setRows(admins || []);
      const { data } = await supabase.from('settings').select('id, primary_admin_id').single();
      setSettingsId(data?.id || null);
      setPrimaryAdminId(data?.primary_admin_id || null);
    } catch (err: any) {
      setLoadError(err.message || '讀取帳號清單失敗');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const approvedAdminCount = useMemo(
    () => rows.filter((r) => r.role === 'admin' && r.status === 'approved').length,
    [rows]
  );
  const pendingCount = useMemo(() => rows.filter((r) => r.status === 'pending').length, [rows]);

  const visibleRows = useMemo(() => rows.filter((r) => {
    if (applied.status && r.status !== applied.status) return false;
    if (applied.role && r.role !== applied.role) return false;
    return true;
  }).sort((a, b) => {
    // 待審核的排最前面：這一頁的主要工作就是處理它們，不該讓管理員自己去清單裡找
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (b.status === 'pending' && a.status !== 'pending') return 1;
    return (a.email || '').localeCompare(b.email || '');
  }), [rows, applied]);

  // 這個帳號是不是「系統最後一個管理員」——是的話不能降級也不能停用/刪除，
  // 否則會變成沒有人能核准新帳號、也沒有人能改系統設定的死結。
  const isLastAdmin = (row: AccountRow) =>
    row.role === 'admin' && row.status === 'approved' && approvedAdminCount <= 1;

  const patchProfile = async (row: AccountRow, patch: Partial<AccountRow>, successMsg: string) => {
    const { error } = await supabase
      .from('admin_profiles')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) {
      enqueueSnackbar(`更新失敗：${error.message}`, { variant: 'error' });
      return;
    }
    enqueueSnackbar(successMsg, { variant: 'success' });
    // 改到自己時要一併更新目前 session 的角色，否則畫面上的選單還是舊權限
    if (row.id === me?.id) await refreshProfile();
    fetchAll();
  };

  const handleApprove = async (row: AccountRow) => {
    await patchProfile(
      row,
      { status: 'approved', approved_at: new Date().toISOString(), approved_by: me?.id } as any,
      `已核准 ${row.email}，角色為「${roleLabel(row.role)}」`
    );
  };

  const handleRoleChange = async (row: AccountRow, nextRole: AdminRole) => {
    if (nextRole === row.role) return;
    if (row.id === me?.id) {
      enqueueSnackbar('不能變更自己的角色，請由其他管理員操作', { variant: 'warning' });
      return;
    }
    if (isLastAdmin(row) && nextRole !== 'admin') {
      enqueueSnackbar('這是系統唯一的管理員，不能降級', { variant: 'warning' });
      return;
    }
    await patchProfile(row, { role: nextRole }, `${row.email} 的角色已改為「${roleLabel(nextRole)}」`);
  };

  const handleToggleDisabled = async (row: AccountRow) => {
    const disabling = row.status !== 'disabled';
    if (disabling) {
      if (row.id === me?.id) { enqueueSnackbar('不能停用自己的帳號', { variant: 'warning' }); return; }
      if (row.id === primaryAdminId) { enqueueSnackbar('主帳號不能被停用', { variant: 'warning' }); return; }
      if (isLastAdmin(row)) { enqueueSnackbar('這是系統唯一的管理員，不能停用', { variant: 'warning' }); return; }
      const ok = await confirm({
        title: `確定要停用 ${row.email} 嗎？`,
        message: '停用後對方仍可用 Google 登入，但會被系統擋下、進不到後台。之後可以隨時重新啟用。',
        confirmLabel: '停用',
        danger: true,
      });
      if (!ok) return;
    }
    await patchProfile(
      row,
      { status: disabling ? 'disabled' : 'approved' },
      disabling ? `已停用 ${row.email}` : `已重新啟用 ${row.email}`
    );
  };

  const handleDelete = async (row: AccountRow) => {
    if (row.id === me?.id) { enqueueSnackbar('不能刪除自己的帳號', { variant: 'warning' }); return; }
    if (row.id === primaryAdminId) { enqueueSnackbar('主帳號不能被移除', { variant: 'warning' }); return; }
    if (isLastAdmin(row)) { enqueueSnackbar('這是系統唯一的管理員，不能移除', { variant: 'warning' }); return; }
    const ok = await confirm({
      title: `確定要移除 ${row.email} 嗎？`,
      message: '帳號會被永久刪除，無法復原。如果只是暫時不讓對方使用，建議改用「停用」。',
      confirmLabel: '永久移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await callFn('delete-admin', { method: 'POST', body: JSON.stringify({ userId: row.id }) });
      enqueueSnackbar(`已移除 ${row.email}`, { variant: 'success' });
      fetchAll();
    } catch (err: any) {
      enqueueSnackbar(`移除失敗：${err.message}`, { variant: 'error' });
    }
  };

  const claimPrimary = async () => {
    if (!settingsId || !me?.id) return;
    setClaiming(true);
    try {
      await supabase.from('settings').update({ primary_admin_id: me.id }).eq('id', settingsId).is('primary_admin_id', null);
      await fetchAll();
      enqueueSnackbar('已將您設為主帳號', { variant: 'success' });
    } finally {
      setClaiming(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) { enqueueSnackbar('請輸入 Email', { variant: 'warning' }); return; }
    setInviting(true);
    try {
      await callFn('invite-admin', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      enqueueSnackbar('邀請信已寄出，對方設定密碼後即可直接登入', { variant: 'success' });
      setInviteEmail('');
      setInviteOpen(false);
      fetchAll();
    } catch (err: any) {
      enqueueSnackbar(`邀請失敗：${err.message}`, { variant: 'error' });
    } finally {
      setInviting(false);
    }
  };

  const columns: Column<AccountRow>[] = [
    {
      key: 'email',
      header: '帳號',
      render: (r) => (
        <Box>
          <Typography variant="body2" fontWeight={600}>
            {r.email}
            {r.id === me?.id && <Typography component="span" variant="caption" color="primary.main" sx={{ ml: 1 }}>（你）</Typography>}
            {r.id === primaryAdminId && <Chip label="主帳號" size="small" color="warning" sx={{ ml: 1, height: 18, fontSize: 11 }} />}
          </Typography>
          {r.display_name && r.display_name !== r.email && (
            <Typography variant="caption" color="text.secondary">{r.display_name}</Typography>
          )}
        </Box>
      ),
    },
    {
      key: 'role',
      header: '角色',
      width: 150,
      render: (r) => {
        const locked = r.id === me?.id || (isLastAdmin(r));
        return (
          <Tooltip title={locked ? (r.id === me?.id ? '不能變更自己的角色' : '系統唯一的管理員，不能降級') : ''}>
            <span>
              <TextField
                select
                size="small"
                value={r.role}
                disabled={locked}
                onChange={(e) => handleRoleChange(r, e.target.value as AdminRole)}
                onClick={(e) => e.stopPropagation()}
                sx={{ width: 130 }}
              >
                {ROLE_OPTIONS.map((o) => (
                  <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
                ))}
              </TextField>
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'status',
      header: '狀態',
      width: 100,
      render: (r) => <Chip label={STATUS_LABELS[r.status]} size="small" color={STATUS_COLOR[r.status]} />,
    },
    {
      key: 'last_sign_in_at',
      header: '最後登入',
      nowrap: true,
      render: (r) => (
        <Typography variant="body2" color="text.secondary">
          {r.last_sign_in_at ? new Date(r.last_sign_in_at).toLocaleString('zh-TW') : '尚未登入'}
        </Typography>
      ),
    },
  ];

  if (loadError) {
    return (
      <Stack spacing={2}>
        <PageHeaderMui icon={<UserCog size={22} />} title="帳號管理" />
        <ResultState status={500} description={loadError} onRetry={fetchAll} backTo={false} />
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <PageHeaderMui
        icon={<UserCog size={22} />}
        title="帳號管理"
        description="核准新申請的帳號、指派角色，或停用不再需要的帳號。同事第一次用 Google 登入後會出現在這裡等待核准。"
        action={
          <Button variant="outlined" startIcon={<UserPlus size={16} />} onClick={() => setInviteOpen(true)}>
            用 Email 邀請
          </Button>
        }
      />

      {pendingCount > 0 && (
        <Alert severity="warning" icon={<ShieldCheck size={18} />}>
          有 <strong>{pendingCount}</strong> 個帳號正在等待核准。核准前對方無法登入後台。
        </Alert>
      )}

      {!primaryAdminId && (
        <Alert
          severity="info"
          action={<Button size="small" onClick={claimPrimary} disabled={claiming}>{claiming ? '設定中...' : '將我設為主帳號'}</Button>}
        >
          目前還沒有設定「主帳號」。主帳號不能被其他管理員停用或移除，建議由老闆本人設定。
        </Alert>
      )}

      <Alert severity="info" sx={{ '& ul': { m: 0, pl: 2.5 } }}>
        <Typography variant="body2" fontWeight={600} gutterBottom>角色權限說明</Typography>
        <ul>
          {ROLE_OPTIONS.map((o) => (
            <li key={o.value}>
              <Typography variant="body2" component="span"><strong>{o.label}</strong>：{o.description}</Typography>
            </li>
          ))}
        </ul>
      </Alert>

      <FilterPanel
        onSearch={() => setApplied({ status: statusFilter, role: roleFilter })}
        onReset={() => { setStatusFilter(''); setRoleFilter(''); setApplied({ status: '', role: '' }); }}
        loading={loading}
      >
        <TextField select label="狀態" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as any)} sx={{ width: 160 }}>
          <MenuItem value="">全部</MenuItem>
          {(Object.keys(STATUS_LABELS) as AccountStatus[]).map((s) => (
            <MenuItem key={s} value={s}>{STATUS_LABELS[s]}</MenuItem>
          ))}
        </TextField>
        <TextField select label="角色" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as any)} sx={{ width: 160 }}>
          <MenuItem value="">全部</MenuItem>
          {ROLE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
        </TextField>
      </FilterPanel>

      <DataTableMui
        columns={columns}
        rows={visibleRows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage={rows.length === 0 ? '尚無任何帳號' : '沒有符合條件的帳號'}
        rowActions={(r) => (
          <Stack direction="row" spacing={0.5}>
            {r.status === 'pending' && (
              <Tooltip title="核准這個帳號">
                <IconButton size="small" color="success" onClick={() => handleApprove(r)}>
                  <CheckCircle2 size={16} />
                </IconButton>
              </Tooltip>
            )}
            {r.status !== 'pending' && (
              <Tooltip title={r.status === 'disabled' ? '重新啟用' : '停用（保留帳號，但不能登入）'}>
                <span>
                  <IconButton
                    size="small"
                    color={r.status === 'disabled' ? 'success' : 'warning'}
                    onClick={() => handleToggleDisabled(r)}
                    disabled={r.status !== 'disabled' && (r.id === me?.id || r.id === primaryAdminId || isLastAdmin(r))}
                  >
                    {r.status === 'disabled' ? <CheckCircle2 size={16} /> : <Ban size={16} />}
                  </IconButton>
                </span>
              </Tooltip>
            )}
            <Tooltip title="永久移除帳號">
              <span>
                <IconButton
                  size="small"
                  color="error"
                  onClick={() => handleDelete(r)}
                  disabled={r.id === me?.id || r.id === primaryAdminId || isLastAdmin(r)}
                >
                  <Trash2 size={16} />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        )}
      />

      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>用 Email 邀請帳號</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="info">
              一般情況請直接請同事用 Google 登入，再到這一頁核准即可。
              這個邀請功能是給「沒有 Google 帳號」或需要保留一組密碼備援帳號時使用，
              對方會收到設定密碼的信，設定完直接就是已核准狀態。
            </Alert>
            <TextField
              label="Email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@example.com"
              fullWidth
            />
            <TextField select label="角色" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as AdminRole)} fullWidth>
              {ROLE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInviteOpen(false)}>取消</Button>
          <Button variant="contained" onClick={handleInvite} disabled={inviting}>
            {inviting ? '寄送中...' : '寄送邀請'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  MenuItem, Stack, TextField, Tooltip, Typography, IconButton,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { UserCog, UserPlus, Trash2, Ban, CheckCircle2, ShieldOff, ShieldCheck, Copy, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import {
  ROLE_OPTIONS, STATUS_LABELS, STATUS_DESCRIPTIONS, roleLabel,
  type AdminRole, type AccountStatus,
} from '../lib/permissions';
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
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}), Authorization: `Bearer ${session?.access_token}` },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!res.ok) throw new Error(body.error || body.message || text || '操作失敗');
  return body;
}

const STATUS_COLOR: Record<AccountStatus, 'default' | 'info' | 'warning' | 'success'> = {
  invited: 'info',
  pending_mfa: 'warning',
  active: 'success',
  suspended: 'default',
};

export default function AdminAccounts() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { profile: me, refresh } = useAuth();

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
  const [inviteResult, setInviteResult] = useState<
    { email: string; mailSent: boolean; mailError: string | null; inviteUrl: string } | null
  >(null);
  const [linkCopied, setLinkCopied] = useState(false);

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

  const activeAdminCount = useMemo(
    () => rows.filter((r) => r.role === 'admin' && r.status === 'active').length,
    [rows]
  );

  const visibleRows = useMemo(() => rows.filter((r) => {
    if (applied.status && r.status !== applied.status) return false;
    if (applied.role && r.role !== applied.role) return false;
    return true;
  }).sort((a, b) => {
    // 尚未完成上線的帳號排前面：這一頁的主要工作就是盯著它們有沒有卡住
    const rank = (s: AccountStatus) => (s === 'invited' ? 0 : s === 'pending_mfa' ? 1 : s === 'active' ? 2 : 3);
    const diff = rank(a.status) - rank(b.status);
    return diff !== 0 ? diff : (a.email || '').localeCompare(b.email || '');
  }), [rows, applied]);

  // 這個帳號是不是「系統最後一個可用的管理員」——是的話不能降級也不能停權/刪除，
  // 否則會變成沒有人能發邀請、也沒有人能改系統設定的死結。
  const isLastAdmin = (row: AccountRow) =>
    row.role === 'admin' && row.status === 'active' && activeAdminCount <= 1;

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
    if (row.id === me?.id) await refresh();
    fetchAll();
  };

  const handleRoleChange = async (row: AccountRow, nextRole: AdminRole) => {
    if (nextRole === row.role) return;
    if (row.id === me?.id) {
      enqueueSnackbar('不能變更自己的角色，請由其他管理員操作', { variant: 'warning' });
      return;
    }
    // 主帳號一降級就會失去所有特權（is_owner() 要求 is_admin()），而且自己救不回來。
    // 資料庫的 guard_owner_profile 觸發器才是真正的防線，這裡只是先給看得懂的訊息。
    if (row.id === primaryAdminId) {
      enqueueSnackbar('主帳號的角色不能變更', { variant: 'warning' });
      return;
    }
    if (isLastAdmin(row) && nextRole !== 'admin') {
      enqueueSnackbar('這是系統唯一的管理員，不能降級', { variant: 'warning' });
      return;
    }
    await patchProfile(row, { role: nextRole }, `${row.email} 的角色已改為「${roleLabel(nextRole)}」`);
  };

  const handleToggleSuspend = async (row: AccountRow) => {
    const suspending = row.status !== 'suspended';
    if (suspending) {
      if (row.id === me?.id) { enqueueSnackbar('不能停權自己的帳號', { variant: 'warning' }); return; }
      if (row.id === primaryAdminId) { enqueueSnackbar('主帳號不能被停權', { variant: 'warning' }); return; }
      if (isLastAdmin(row)) { enqueueSnackbar('這是系統唯一的管理員，不能停權', { variant: 'warning' }); return; }
      const ok = await confirm({
        title: `確定要停權 ${row.email} 嗎？`,
        message: '停權後對方仍可用 Google 登入，但會立刻被系統擋下、進不到後台。之後可以隨時恢復。',
        confirmLabel: '停權',
        danger: true,
      });
      if (!ok) return;
    }
    // 恢復時退回 pending_mfa 而不是 active：讓對方重新確認一次 2FA 才放行。
    // 若他原本就綁好驗證器，登入時會直接走驗證頁，不會被要求重綁。
    await patchProfile(
      row,
      { status: suspending ? 'suspended' : 'pending_mfa' },
      suspending ? `已停權 ${row.email}` : `已恢復 ${row.email}，對方下次登入需通過雙因素驗證`
    );
  };

  const handleReset2FA = async (row: AccountRow) => {
    const ok = await confirm({
      title: `重置 ${row.email} 的雙因素驗證？`,
      message: '對方目前綁定的驗證器會被解除，下次登入時必須重新掃描 QR Code 綁定。適用於對方遺失手機的情況。',
      confirmLabel: '重置 2FA',
      danger: true,
    });
    if (!ok) return;
    try {
      await callFn('mfa', { method: 'POST', body: JSON.stringify({ action: 'reset', userId: row.id }) });
      enqueueSnackbar(`已重置 ${row.email} 的雙因素驗證`, { variant: 'success' });
      fetchAll();
    } catch (err: any) {
      enqueueSnackbar(`重置失敗：${err.message}`, { variant: 'error' });
    }
  };

  const handleDelete = async (row: AccountRow) => {
    if (row.id === me?.id) { enqueueSnackbar('不能刪除自己的帳號', { variant: 'warning' }); return; }
    if (row.id === primaryAdminId) { enqueueSnackbar('主帳號不能被移除', { variant: 'warning' }); return; }
    if (isLastAdmin(row)) { enqueueSnackbar('這是系統唯一的管理員，不能移除', { variant: 'warning' }); return; }
    const ok = await confirm({
      title: `確定要移除 ${row.email} 嗎？`,
      message: '帳號會被永久刪除，無法復原。如果只是暫時不讓對方使用，建議改用「停權」。',
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
    setInviteResult(null);
    try {
      const result = await callFn('invite-admin', {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      setInviteResult({
        email: result.email,
        mailSent: result.mailSent,
        mailError: result.mailError,
        inviteUrl: result.inviteUrl,
      });
      setLinkCopied(false);
      setInviteEmail('');
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
        const locked = r.id === me?.id || r.id === primaryAdminId || isLastAdmin(r);
        return (
          <Tooltip title={locked ? (r.id === me?.id ? '不能變更自己的角色' : r.id === primaryAdminId ? '主帳號的角色不能變更' : '系統唯一的管理員，不能降級') : ''}>
            <span>
              <TextField
                select size="small" value={r.role} disabled={locked}
                onChange={(e) => handleRoleChange(r, e.target.value as AdminRole)}
                onClick={(e) => e.stopPropagation()}
                sx={{ width: 130 }}
              >
                {ROLE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
              </TextField>
            </span>
          </Tooltip>
        );
      },
    },
    {
      key: 'status',
      header: '狀態',
      width: 120,
      render: (r) => (
        <Tooltip title={STATUS_DESCRIPTIONS[r.status]}>
          <Chip label={STATUS_LABELS[r.status]} size="small" color={STATUS_COLOR[r.status]} />
        </Tooltip>
      ),
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

  const stuckCount = rows.filter((r) => r.status === 'invited' || r.status === 'pending_mfa').length;

  return (
    <Stack spacing={2}>
      <PageHeaderMui
        icon={<UserCog size={22} />}
        title="帳號管理"
        description="本系統不開放自行註冊。要讓同事使用後台，請在這裡用他的 Google 信箱建立邀請。"
        action={
          <Button variant="contained" startIcon={<UserPlus size={16} />} onClick={() => { setInviteOpen(true); setInviteResult(null); }}>
            邀請新帳號
          </Button>
        }
      />

      {stuckCount > 0 && (
        <Alert severity="info">
          有 <strong>{stuckCount}</strong> 個帳號尚未完成上線（還沒用 Google 登入，或還沒綁定雙因素驗證）。
          這些帳號目前無法存取任何資料。
        </Alert>
      )}

      {!primaryAdminId && (
        <Alert
          severity="info"
          action={<Button size="small" onClick={claimPrimary} disabled={claiming}>{claiming ? '設定中...' : '將我設為主帳號'}</Button>}
        >
          目前還沒有設定「主帳號」。主帳號不能被其他管理員停權或移除，建議由老闆本人設定。
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
            {r.status === 'active' && (
              <Tooltip title="重置雙因素驗證（對方遺失手機時使用）">
                <IconButton size="small" color="warning" onClick={() => handleReset2FA(r)}>
                  <ShieldOff size={16} />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title={r.status === 'suspended' ? '恢復帳號' : '停權（保留帳號，但不能登入）'}>
              <span>
                <IconButton
                  size="small"
                  color={r.status === 'suspended' ? 'success' : 'warning'}
                  onClick={() => handleToggleSuspend(r)}
                  disabled={r.status !== 'suspended' && (r.id === me?.id || r.id === primaryAdminId || isLastAdmin(r))}
                >
                  {r.status === 'suspended' ? <CheckCircle2 size={16} /> : <Ban size={16} />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="永久移除帳號">
              <span>
                <IconButton
                  size="small" color="error" onClick={() => handleDelete(r)}
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
        <DialogTitle>邀請新帳號</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {inviteResult ? (
              <>
                <Alert severity={inviteResult.mailSent ? 'success' : 'warning'} icon={<ShieldCheck size={18} />}>
                  已為 <strong>{inviteResult.email}</strong> 建立邀請。
                  {inviteResult.mailSent
                    ? '邀請信已寄出，對方點開信件後用 Google 登入即可。'
                    : '但邀請信沒有寄出（這個信箱先前已建立過帳號）。請直接請對方到登入頁用 Google 登入，一樣會被放行。'}
                </Alert>
                {!inviteResult.mailSent && inviteResult.mailError && (
                  <Typography variant="caption" color="text.secondary">技術原因：{inviteResult.mailError}</Typography>
                )}

                {/* 信件可能寄不到、或被 Supabase 的 Site URL 設定改寫成錯誤網址，
                    所以把連結直接給管理員，可以改用 LINE 等方式傳給對方。 */}
                <Box>
                  <Typography variant="caption" color="text.secondary">
                    邀請連結（可直接複製傳給對方，24 小時內有效）：
                  </Typography>
                  <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 0.5 }}>
                    <Box
                      sx={{
                        flex: 1, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5,
                        bgcolor: 'action.hover', px: 1.5, py: 1, borderRadius: 1,
                        wordBreak: 'break-all', maxHeight: 88, overflow: 'auto',
                      }}
                    >
                      {inviteResult.inviteUrl}
                    </Box>
                    <Button
                      size="small" variant="outlined"
                      startIcon={linkCopied ? <Check size={14} /> : <Copy size={14} />}
                      onClick={async () => {
                        await navigator.clipboard.writeText(inviteResult.inviteUrl);
                        setLinkCopied(true);
                        setTimeout(() => setLinkCopied(false), 1500);
                      }}
                    >
                      {linkCopied ? '已複製' : '複製'}
                    </Button>
                  </Stack>
                </Box>

                <Typography variant="caption" color="text.secondary">
                  對方完成 Google 登入後，還需要綁定 Google Authenticator 才能開始使用系統。
                </Typography>
              </>
            ) : (
              <>
                <Alert severity="info" sx={{ fontSize: 13 }}>
                  請填入對方的 <strong>Google 信箱</strong>。登入時系統會核對 Google 帳號的信箱與這裡填的完全一致，
                  不一致一律拒絕。邀請效期 24 小時。
                </Alert>
                <TextField
                  label="Google 信箱" type="email" value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@gmail.com" fullWidth autoFocus
                />
                <TextField select label="角色" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as AdminRole)} fullWidth>
                  {ROLE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                </TextField>
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setInviteOpen(false)}>{inviteResult ? '關閉' : '取消'}</Button>
          {!inviteResult && (
            <Button variant="contained" onClick={handleInvite} disabled={inviting}>
              {inviting ? '建立中...' : '建立邀請並寄信'}
            </Button>
          )}
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

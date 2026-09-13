import { useMemo, useState } from 'react';
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { Check, Copy, ShieldCheck } from 'lucide-react';
import { useBreakpoint } from '../../app/useBreakpoint';
import { ROLE_OPTIONS, type AdminRole } from '../../lib/permissions';
import { inviteUser, type InviteResult, type RoleRecord } from './rbacQueries';

// ========================================================================
// 邀請同事（權限管理 V2 §44）：填 Google 信箱、勾角色（可多選），送出後顯示邀請連結。
// 角色含有呼叫者自己沒有的權限時不能選（§40）；資料庫尚未升級時退回舊的三級角色下拉。
// ========================================================================

export function RoleCheckList({ roles, value, onChange, grantable, disabled }: {
  roles: RoleRecord[]; value: string[]; onChange: (ids: string[]) => void; grantable: ReadonlySet<string> | null; disabled?: boolean;
}) {
  const blockReason = (r: RoleRecord) => {
    if (!r.is_active) return '已停用的角色不能指派';
    if (grantable) {
      const beyond = r.permission_codes.filter((c) => !grantable.has(c));
      if (beyond.length) return `這個角色含有你自己沒有的權限（${beyond.length} 項），不能指派`;
    }
    return null;
  };
  return (
    <Stack spacing={0.5}>
      {roles.map((r) => {
        const reason = blockReason(r);
        const checked = value.includes(r.id);
        const row = (
          <FormControlLabel
            key={r.id}
            disabled={disabled || (!!reason && !checked)}
            control={<Checkbox size="small" checked={checked} onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))} />}
            label={
              <Box>
                <Typography variant="body2" fontWeight={500}>{r.name}{r.is_system ? '（系統角色）' : ''}{!r.is_active ? '（已停用）' : ''}</Typography>
                {r.description && <Typography variant="caption" color="text.secondary">{r.description}</Typography>}
              </Box>
            }
            sx={{ alignItems: 'flex-start', m: 0, '& .MuiCheckbox-root': { pt: 0.25 } }}
          />
        );
        return reason ? <Tooltip key={r.id} title={reason} placement="top-start"><Box>{row}</Box></Tooltip> : row;
      })}
      {roles.length === 0 && <Typography variant="body2" color="text.secondary">目前沒有可指派的角色，請先到「角色與權限」建立。</Typography>}
    </Stack>
  );
}

export default function InviteUserDialog({ open, onClose, roles, grantable, legacy, onInvited }: {
  open: boolean; onClose: () => void; roles: RoleRecord[]; grantable: ReadonlySet<string> | null; legacy: boolean; onInvited: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { isMobile } = useBreakpoint();
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [legacyRole, setLegacyRole] = useState<AdminRole>('staff');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const selectable = useMemo(() => roles.filter((r) => r.is_active), [roles]);
  const useLegacy = legacy || roles.length === 0;

  const submit = async () => {
    const e = email.trim();
    if (!e) { enqueueSnackbar('請輸入 Email', { variant: 'warning' }); return; }
    if (!useLegacy && roleIds.length === 0) { enqueueSnackbar('請至少選一個角色', { variant: 'warning' }); return; }
    setBusy(true);
    try {
      const r = await inviteUser({ email: e, roleIds: useLegacy ? [] : roleIds, role: useLegacy ? legacyRole : undefined });
      setResult(r); setCopied(false); setEmail(''); setRoleIds([]);
      onInvited();
    } catch (err: any) { enqueueSnackbar(`邀請失敗：${err.message}`, { variant: 'error' }); } finally { setBusy(false); }
  };

  const close = () => { onClose(); setTimeout(() => setResult(null), 200); };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth fullScreen={isMobile}>
      <DialogTitle>邀請同事</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {result ? (
            <>
              <Alert severity={result.mailSent ? 'success' : 'warning'} icon={<ShieldCheck size={18} />}>
                已為 <strong>{result.email}</strong> 建立邀請。
                {result.mailSent ? '邀請信已寄出，對方點開信件後用 Google 登入即可。' : '但邀請信沒有寄出（這個信箱先前已建立過帳號）。請直接請對方到登入頁用 Google 登入，一樣會被放行。'}
              </Alert>
              {!result.mailSent && result.mailError && <Typography variant="caption" color="text.secondary">技術原因：{result.mailError}</Typography>}
              {/* 信件可能寄不到、或被 Supabase 的 Site URL 設定改寫成錯誤網址，所以把連結直接給管理員，可改用 LINE 傳給對方 */}
              <Box>
                <Typography variant="caption" color="text.secondary">邀請連結（可直接複製傳給對方，24 小時內有效）：</Typography>
                <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 0.5 }}>
                  <Box sx={{ flex: 1, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, bgcolor: 'action.hover', px: 1.5, py: 1, borderRadius: 1, wordBreak: 'break-all', maxHeight: 88, overflow: 'auto' }}>{result.inviteUrl}</Box>
                  <Button size="small" variant="outlined" startIcon={copied ? <Check size={14} /> : <Copy size={14} />}
                    onClick={async () => { await navigator.clipboard.writeText(result.inviteUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
                    {copied ? '已複製' : '複製'}
                  </Button>
                </Stack>
              </Box>
              <Typography variant="caption" color="text.secondary">對方完成 Google 登入後，還需要綁定 Google Authenticator 才能開始使用系統。</Typography>
            </>
          ) : (
            <>
              <Alert severity="info" sx={{ fontSize: 13 }}>
                請填入對方的 <strong>Google 信箱</strong>。登入時系統會核對 Google 帳號的信箱與這裡填的完全一致，不一致一律拒絕。邀請效期 24 小時。
              </Alert>
              <TextField label="Google 信箱" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@gmail.com" fullWidth autoFocus />
              {useLegacy ? (
                <TextField select label="角色" value={legacyRole} onChange={(e) => setLegacyRole(e.target.value as AdminRole)} fullWidth helperText="資料庫尚未升級到權限管理 V2，暫用舊的三級角色">
                  {ROLE_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
                </TextField>
              ) : (
                <Box>
                  <Typography variant="subtitle2" gutterBottom>指派角色（可多選，權限取聯集）</Typography>
                  <RoleCheckList roles={selectable} value={roleIds} onChange={setRoleIds} grantable={grantable} />
                </Box>
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{result ? '關閉' : '取消'}</Button>
        {!result && <Button variant="contained" onClick={submit} disabled={busy}>{busy ? '建立中…' : '建立邀請並寄信'}</Button>}
      </DialogActions>
    </Dialog>
  );
}

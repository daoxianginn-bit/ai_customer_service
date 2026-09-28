import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItemButton, ListItemText, MenuItem, Radio, Skeleton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { MessageCircle } from 'lucide-react';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatRelative } from '../../lib/format';
import { bindUserLine, fetchLineContacts, unbindUserLine, type LineChannelOption, type LineContactOption, type UserRecord } from './rbacQueries';

// ========================================================================
// 帳號綁定 LINE：排程通知可以「依角色／個別帳號」發送（例如所有會計都收到待收尾款通知），
// 系統要知道這個帳號的 LINE 是哪一個。LINE 的 ID 只能從官方帳號的聯絡人裡挑——對方要先加
// 官方帳號好友並傳過一句話，系統才認得他；手打的 LINE ID 推播不出去。
// ========================================================================

function PickDialog({ open, user, onClose, onSaved }: { open: boolean; user: UserRecord; onClose: () => void; onSaved: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const { isMobile } = useBreakpoint();
  const [channels, setChannels] = useState<LineChannelOption[] | null>(null);
  const [channelId, setChannelId] = useState('');
  const [contacts, setContacts] = useState<LineContactOption[] | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(''); setQ(''); setContacts(null);
    fetchLineContacts().then((r) => {
      setChannels(r.channels);
      // 預設帶已綁的那個帳號；沒綁過就優先「團隊內部用」帳號（同事通常加的是那一個）
      const def = user.line_channel_id || r.channels.find((c) => c.role === 'internal')?.id || r.channels[0]?.id || '';
      setChannelId(def);
    }).catch((e) => { enqueueSnackbar(e.message || '讀取官方帳號失敗', { variant: 'error' }); setChannels([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || !channelId) return;
    setContacts(null); setPicked('');
    fetchLineContacts(channelId).then((r) => setContacts(r.contacts)).catch(() => setContacts([]));
  }, [open, channelId]);

  const shown = useMemo(() => (contacts || []).filter((c) => !q.trim() || (c.nickname || '').toLowerCase().includes(q.trim().toLowerCase())), [contacts, q]);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    try { await bindUserLine(user.id, channelId, picked); enqueueSnackbar('已綁定 LINE', { variant: 'success' }); onSaved(); }
    catch (e: any) { enqueueSnackbar(e.message || '綁定失敗', { variant: 'error' }); } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullScreen={isMobile} maxWidth="sm" fullWidth>
      <DialogTitle>設定 LINE：{user.display_name || user.email}</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" icon={false} sx={{ mb: 2, fontSize: 13 }}>
          請對方先用自己的 LINE 加官方帳號好友，並<b>傳一句話</b>（例如「綁定」），他才會出現在下面的聯絡人清單裡。<br />
          綁定後，排程通知勾選「{'角色'}」或這個帳號時，就會發到這個 LINE。
        </Alert>
        {channels === null ? <Skeleton variant="rounded" height={40} /> : channels.length === 0 ? (
          <Alert severity="warning">還沒有任何啟用中的 LINE 官方帳號，請先到「串接管理」設定。</Alert>
        ) : (
          <Stack spacing={1.5}>
            <TextField select size="small" label="官方帳號" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {channels.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}</MenuItem>)}
            </TextField>
            <TextField size="small" placeholder="搜尋暱稱" value={q} onChange={(e) => setQ(e.target.value)} />
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, maxHeight: 320, overflow: 'auto' }}>
              {contacts === null ? <Box sx={{ p: 1.5 }}><Skeleton height={32} /><Skeleton height={32} /></Box> : shown.length === 0 ? (
                <Typography variant="body2" color="text.secondary" sx={{ p: 1.5 }}>{contacts.length ? '沒有符合的聯絡人' : '這個官方帳號還沒有聯絡人。'}</Typography>
              ) : (
                <List dense disablePadding>
                  {shown.map((c) => (
                    <ListItemButton key={c.line_user_id} selected={picked === c.line_user_id} onClick={() => setPicked(c.line_user_id)}>
                      <Radio size="small" checked={picked === c.line_user_id} sx={{ p: 0.5, mr: 1 }} />
                      <ListItemText primary={c.nickname || '（未取得暱稱）'} secondary={c.last_message_at ? `最近互動 ${formatRelative(c.last_message_at)}` : undefined} />
                    </ListItemButton>
                  ))}
                </List>
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">只列最近互動的 300 位。暱稱相同時看「最近互動」：請對方剛傳完訊息就來挑，排在最上面的就是他。</Typography>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={saving}>取消</Button>
        <Button variant="contained" onClick={save} disabled={!picked || saving}>{saving ? '儲存中…' : '綁定'}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function UserLineCard({ user, canEdit, onChanged }: { user: UserRecord; canEdit: boolean; onChanged: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);

  const unbind = async () => {
    if (!(await confirm({ title: '解除 LINE 綁定？', message: '解除後，排程通知就不會再發給這個帳號。', confirmLabel: '解除', danger: true }))) return;
    try { await unbindUserLine(user.id); enqueueSnackbar('已解除', { variant: 'success' }); onChanged(); }
    catch (e: any) { enqueueSnackbar(e.message || '解除失敗', { variant: 'error' }); }
  };

  return (
    <Card sx={{ mt: 2 }}><CardContent>
      <Typography variant="subtitle2" gutterBottom>LINE 通知</Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'flex-start', sm: 'center' }} justifyContent="space-between">
        <Stack direction="row" spacing={1} alignItems="center">
          <MessageCircle size={18} />
          {user.line_bound
            ? <Typography variant="body2">已綁定：<b>{user.line_display_name || '（未取得暱稱）'}</b></Typography>
            : <Typography variant="body2" color="text.secondary">尚未綁定，排程通知發不到這個帳號</Typography>}
        </Stack>
        <Tooltip title={canEdit ? '' : '沒有「修改使用者」權限'}><span>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={() => setOpen(true)} disabled={!canEdit}>{user.line_bound ? '變更' : '設定 LINE'}</Button>
            {user.line_bound && <Button size="small" color="error" onClick={unbind} disabled={!canEdit}>解除</Button>}
          </Stack>
        </span></Tooltip>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        排程管理的通知可以「依角色」發送（例如勾「會計」，所有會計都會收到），只有綁了 LINE 的帳號收得到。
      </Typography>
      <PickDialog open={open} user={user} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChanged(); }} />
    </CardContent></Card>
  );
}

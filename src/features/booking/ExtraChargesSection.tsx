import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputAdornment, Menu, MenuItem, Skeleton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { MoreVertical, Plus } from 'lucide-react';
import { usePermission } from '../../app/Can';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { formatDateTime, formatMoney } from '../../lib/format';
import { BALANCE_PAID_STATUSES } from '../../lib/bookingStatus';
import { extraChargeCode, validateExtraChargeInput, type ExtraCharge } from '../../lib/extraCharges';
import { fetchExtraCharges, setExtraChargesPaid, updateExtraCharge, voidExtraCharge } from './extraChargeQueries';
import AddExtraChargesDialog from './AddExtraChargesDialog';
import type { BookingRow } from './bookingQueries';

// ========================================================================
// 訂單詳情的「追加款明細」。
//   新增、編輯、作廢：訂單編輯或款項核對權限（訂單編輯人員與會計）
//   勾選／取消「已付」：只有款項核對權限（會計）——系統裡的「已付」一定是會計確認過的
//   已付的鎖住不能改；作廢的保留顯示（字母不回收，看得到 B 曾經是什麼）
// 未付的會併進尾款；尾款已經收過的訂單，未付的要另外收，會計的「追加款收款」關卡會列出來。
// ========================================================================

function EditDialog({ charge, orderNumber, onClose, onSaved }: { charge: ExtraCharge | null; orderNumber?: string | null; onClose: () => void; onSaved: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ title?: string; amount?: string }>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!charge) return;
    setTitle(charge.title); setAmount(String(charge.amount)); setNote(charge.internal_note || ''); setErrors({});
  }, [charge]);
  const save = async () => {
    const e = validateExtraChargeInput({ title, amount });
    setErrors(e || {});
    if (e || !charge) return;
    setSaving(true);
    try { await updateExtraCharge(charge.id, { title: title.trim(), amount: Number(amount), internal_note: note.trim() || null }); enqueueSnackbar('已更新', { variant: 'success' }); onSaved(); }
    catch (err: any) { enqueueSnackbar(err.message || '更新失敗', { variant: 'error' }); } finally { setSaving(false); }
  };
  return (
    <Dialog open={!!charge} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>修改追加款 <Typography component="span" variant="body2" sx={{ fontFamily: 'monospace', ml: 1 }}>{charge ? extraChargeCode(orderNumber, charge.seq) : ''}</Typography></DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField size="small" label="追加名稱（客人會看到）" value={title} onChange={(e) => { setTitle(e.target.value); setErrors({}); }} error={!!errors.title} helperText={errors.title} inputProps={{ maxLength: 60 }} />
          <TextField size="small" label="金額" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d]/g, '')); setErrors({}); }} error={!!errors.amount} helperText={errors.amount}
            InputProps={{ startAdornment: <InputAdornment position="start">NT$</InputAdornment> }} inputProps={{ inputMode: 'numeric' }} />
          <TextField size="small" label="內部備註（選填）" value={note} onChange={(e) => setNote(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions><Button color="inherit" onClick={onClose} disabled={saving}>取消</Button><Button variant="contained" onClick={save} disabled={saving}>{saving ? '儲存中…' : '儲存'}</Button></DialogActions>
    </Dialog>
  );
}

export default function ExtraChargesSection({ booking, onChanged }: { booking: BookingRow; onChanged: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const canVerify = usePermission('booking.payment.verify');
  const canEditOrder = usePermission('booking.edit');
  const canEdit = canEditOrder || canVerify;
  const closed = ['cancelled', 'awaiting_refund', 'refunded', 'external_synced'].includes(booking.status);

  const [charges, setCharges] = useState<ExtraCharge[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ExtraCharge | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; charge: ExtraCharge } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCharges(await fetchExtraCharges(booking.id));
    setLoading(false);
  }, [booking.id]);
  useEffect(() => { load(); }, [load]);

  // 追加款改了，訂單上的尾款／未付合計（觸發器維護）也跟著變，上層要重抓訂單
  const refresh = async () => { await load(); onChanged(); };

  const togglePaid = async (c: ExtraCharge) => {
    if (c.is_paid && !(await confirm({ title: '取消已付？', message: `${extraChargeCode(booking.order_number, c.seq)} ${c.title} ${formatMoney(c.amount)} 會改回未付，並重新算進尾款。`, confirmLabel: '取消已付' }))) return;
    setBusyId(c.id);
    try { await setExtraChargesPaid(booking.id, [c.id], !c.is_paid); await refresh(); }
    catch (e: any) { enqueueSnackbar(e.message || '更新失敗', { variant: 'error' }); } finally { setBusyId(null); }
  };

  const voidCharge = async (c: ExtraCharge) => {
    setMenu(null);
    const ok = await confirm({ title: '作廢這筆追加款？', message: `${extraChargeCode(booking.order_number, c.seq)} ${c.title} ${formatMoney(c.amount)} 作廢後不會再算進尾款，編號 ${c.seq} 也不會再被使用。`, confirmLabel: '作廢', danger: true });
    if (!ok) return;
    setBusyId(c.id);
    try { await voidExtraCharge(c.id); enqueueSnackbar('已作廢', { variant: 'success' }); await refresh(); }
    catch (e: any) { enqueueSnackbar(e.message || '作廢失敗', { variant: 'error' }); } finally { setBusyId(null); }
  };

  const active = charges.filter((c) => !c.voided_at);
  const unpaidTotal = active.filter((c) => !c.is_paid).reduce((s, c) => s + c.amount, 0);
  const balancePaid = BALANCE_PAID_STATUSES.includes(booking.status);

  const addButton = canEdit && !closed && (
    <Button size="small" variant="outlined" startIcon={<Plus size={16} />} onClick={() => setAdding(true)}>增加追加項目</Button>
  );

  return (
    <Box>
      <Stack direction="row" justifyContent="flex-end" sx={{ mb: charges.length ? 1 : 0 }}>{addButton}</Stack>
      {loading ? <Skeleton variant="rounded" height={48} /> : !charges.length ? (
        <Typography variant="body2" color="text.secondary">沒有追加款{closed ? '' : '。訂單成立後另外加收的項目（烤肉用具、延遲退房…）在這裡新增。'}</Typography>
      ) : (
        <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
          {charges.map((c) => {
            const voided = !!c.voided_at;
            return (
              <Stack key={c.id} direction="row" spacing={1} alignItems="flex-start" sx={{ py: 0.75, opacity: voided ? 0.55 : 1 }}>
                <Tooltip title={voided ? '已作廢' : !canVerify ? '只有會計（款項核對權限）可以勾選已付' : c.is_paid ? '取消已付' : '勾選＝客人已付過這一筆'}><span>
                  <Checkbox size="small" checked={c.is_paid} disabled={voided || !canVerify || busyId === c.id} onChange={() => togglePaid(c)} sx={{ p: 0.5 }} />
                </span></Tooltip>
                <Box sx={{ flex: 1, minWidth: 0, pt: 0.5 }}>
                  <Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>{extraChargeCode(booking.order_number, c.seq)}</Typography>
                    <Typography variant="body2" sx={{ textDecoration: voided ? 'line-through' : undefined, wordBreak: 'break-word' }}>{c.title}</Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {voided ? `已作廢・${c.voided_by || ''} ${formatDateTime(c.voided_at)}` : c.is_paid ? `已付・${c.paid_by || ''} ${formatDateTime(c.paid_at)}` : `未付・${c.created_by || ''} 新增`}
                  </Typography>
                  {c.internal_note && <Typography variant="caption" color="text.secondary" component="div">內部備註：{c.internal_note}</Typography>}
                </Box>
                <Typography variant="body2" sx={{ pt: 0.5, fontWeight: 600, whiteSpace: 'nowrap', textDecoration: voided ? 'line-through' : undefined }}>{formatMoney(c.amount)}</Typography>
                {canEdit && !voided && !c.is_paid ? (
                  <IconButton size="small" onClick={(e) => setMenu({ anchor: e.currentTarget, charge: c })} aria-label="更多操作" disabled={busyId === c.id}><MoreVertical size={16} /></IconButton>
                ) : <Box sx={{ width: 30 }} />}
              </Stack>
            );
          })}
        </Stack>
      )}

      {unpaidTotal > 0 && (
        <Alert severity={balancePaid ? 'warning' : 'info'} icon={false} sx={{ mt: 1.5, py: 0.5 }}>
          未付合計 <b>{formatMoney(unpaidTotal)}</b>
          {balancePaid ? '・尾款已收過，這些要另外向客人收，會計的「追加款收款」會列出這筆訂單' : '・已計入尾款'}
        </Alert>
      )}

      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem onClick={() => { setEditing(menu!.charge); setMenu(null); }}>修改</MenuItem>
        <MenuItem onClick={() => voidCharge(menu!.charge)} sx={{ color: 'error.main' }}>作廢</MenuItem>
      </Menu>

      <AddExtraChargesDialog
        open={adding} booking={booking} charges={charges} canMarkPaid={canVerify}
        onClose={() => setAdding(false)}
        onSaved={async (notice) => { setAdding(false); if (notice) enqueueSnackbar(notice, { variant: notice.startsWith('未通知') ? 'warning' : 'info' }); await refresh(); }}
      />
      <EditDialog charge={editing} orderNumber={booking.order_number} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await refresh(); }} />
    </Box>
  );
}

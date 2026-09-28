import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, IconButton, InputAdornment, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { Plus, X } from 'lucide-react';
import { useBreakpoint } from '../../app/useBreakpoint';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { formatMoney } from '../../lib/format';
import {
  extraChargeCode, isBlankExtraChargeInput, nextExtraChargeLetters, remainingExtraChargeSlots, validateExtraChargeInput, type ExtraCharge,
} from '../../lib/extraCharges';
import { addExtraCharges } from './extraChargeQueries';
import type { BookingRow } from './bookingQueries';

// ========================================================================
// 增加追加項目：一次可以新增多筆，按「確認」整批存（全部成功或全部失敗）。
// 編號欄只是預覽——實際字母在確認時由後端配發，兩個人同時新增也不會撞號。
// 「已付」勾選框只有會計（款項核對權限）看得到：現場收了現金事後補登時用，其他人新增的一律未付。
// ========================================================================

interface Row { key: number; title: string; amount: string; note: string; paid: boolean }
type RowErrors = Record<number, { title?: string; amount?: string }>;

let rowKey = 0;
const emptyRow = (): Row => ({ key: ++rowKey, title: '', amount: '', note: '', paid: false });

export default function AddExtraChargesDialog({ open, booking, charges, canMarkPaid, onClose, onSaved }: {
  open: boolean;
  booking: BookingRow;
  /** 這筆訂單現有的追加款（含作廢的），用來預覽接下來的字母 */
  charges: ExtraCharge[];
  canMarkPaid: boolean;
  onClose: () => void;
  onSaved: (notice: string | null) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [errors, setErrors] = useState<RowErrors>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setRows([emptyRow()]); setErrors({}); } }, [open]);

  const used = useMemo(() => charges.map((c) => c.seq), [charges]);
  const remaining = remainingExtraChargeSlots(used);
  const letters = nextExtraChargeLetters(used, Math.min(rows.length, remaining)) || [];
  const total = rows.reduce((s, r) => s + (/^\d+$/.test(r.amount.trim()) ? Number(r.amount) : 0), 0);
  const dirty = rows.some((r) => !isBlankExtraChargeInput({ title: r.title, amount: r.amount, internal_note: r.note }) || r.paid);

  const patch = (key: number, p: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...p } : r)));
    setErrors((prev) => { const next = { ...prev }; delete next[key]; return next; });
  };
  const removeRow = (key: number) => setRows((prev) => (prev.length > 1 ? prev.filter((r) => r.key !== key) : [emptyRow()]));

  const close = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: '放棄這些內容？', message: '已經填寫的追加項目還沒存，關閉後就會消失。', confirmLabel: '放棄', danger: true }))) return;
    onClose();
  };

  const submit = async () => {
    const filled = rows.filter((r) => !isBlankExtraChargeInput({ title: r.title, amount: r.amount, internal_note: r.note }) || r.paid);
    const nextErrors: RowErrors = {};
    for (const r of filled) {
      const e = validateExtraChargeInput({ title: r.title, amount: r.amount });
      if (e) nextErrors[r.key] = e;
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    if (!filled.length) { enqueueSnackbar('請至少填一筆追加項目', { variant: 'warning' }); return; }

    setSaving(true);
    try {
      const res = await addExtraCharges(booking.id, filled.map((r) => ({ title: r.title.trim(), amount: Number(r.amount), internal_note: r.note.trim() || null, paid: canMarkPaid && r.paid })));
      enqueueSnackbar(`已新增 ${res.rows.length} 筆追加款`, { variant: 'success' });
      onSaved(res.notice);
    } catch (e: any) {
      enqueueSnackbar(e.message || '新增失敗', { variant: 'error' });
    } finally { setSaving(false); }
  };

  const rowView = (r: Row, i: number) => {
    const err = errors[r.key] || {};
    const code = letters[i] ? extraChargeCode(booking.order_number, letters[i]) : '—';
    const fields = (
      <>
        <TextField size="small" label="追加名稱" placeholder="例如：烤肉用具租借" value={r.title} onChange={(e) => patch(r.key, { title: e.target.value })}
          error={!!err.title} helperText={err.title} sx={{ flex: 2, minWidth: 0 }} inputProps={{ maxLength: 60 }} />
        <TextField size="small" label="金額" value={r.amount} onChange={(e) => patch(r.key, { amount: e.target.value.replace(/[^\d]/g, '') })}
          error={!!err.amount} helperText={err.amount} sx={{ width: isMobile ? '100%' : 140 }}
          InputProps={{ startAdornment: <InputAdornment position="start">NT$</InputAdornment> }} inputProps={{ inputMode: 'numeric' }} />
        <TextField size="small" label="內部備註（選填）" value={r.note} onChange={(e) => patch(r.key, { note: e.target.value })} sx={{ flex: 1.5, minWidth: 0 }} />
        {canMarkPaid && (
          <Tooltip title="客人已經付過（例如現場收現金），不會算進尾款">
            <FormControlLabel control={<Checkbox size="small" checked={r.paid} onChange={(e) => patch(r.key, { paid: e.target.checked })} />} label="已付" sx={{ mr: 0, whiteSpace: 'nowrap' }} />
          </Tooltip>
        )}
      </>
    );
    return (
      <Box key={r.key} sx={isMobile ? { p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 } : undefined}>
        <Stack direction={isMobile ? 'column' : 'row'} spacing={1} alignItems={isMobile ? 'stretch' : 'flex-start'}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ width: isMobile ? 'auto' : 120, pt: isMobile ? 0 : 1 }}>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }} title="確認時才會正式配發">{code}</Typography>
            {isMobile && <IconButton size="small" onClick={() => removeRow(r.key)} aria-label="刪除這一列"><X size={16} /></IconButton>}
          </Stack>
          {fields}
          {!isMobile && <IconButton size="small" onClick={() => removeRow(r.key)} aria-label="刪除這一列" sx={{ mt: 0.5 }}><X size={16} /></IconButton>}
        </Stack>
      </Box>
    );
  };

  return (
    <Dialog open={open} onClose={close} fullScreen={isMobile} maxWidth="md" fullWidth>
      <DialogTitle>增加追加項目<Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1, fontFamily: 'monospace' }}>訂單 {booking.order_number || '—'}</Typography></DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" icon={false} sx={{ mb: 2, fontSize: 13 }}>
          「追加名稱」<b>客人會看到</b>（付款通知、尾款明細），請用客人看得懂的說法；給同事看的寫在內部備註。<br />
          床位與人數異動請用「編輯訂單」重新報價，不要用追加款，以免重複收費。
        </Alert>
        {remaining <= 0 ? (
          <Alert severity="warning">這筆訂單的追加款已達上限（編號到 Z 為止），不能再新增。</Alert>
        ) : (
          <Stack spacing={isMobile ? 1.5 : 1}>
            {rows.map(rowView)}
            <Box>
              <Tooltip title={rows.length >= remaining ? `已達上限（編號到 Z 為止），最多還能加 ${remaining} 項` : ''}><span>
                <Button startIcon={<Plus size={16} />} onClick={() => setRows((prev) => [...prev, emptyRow()])} disabled={rows.length >= remaining}>新增一列</Button>
              </span></Tooltip>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Typography variant="body2" sx={{ flex: 1 }}>本次合計 <b>{formatMoney(total)}</b></Typography>
        <Button color="inherit" onClick={close} disabled={saving}>取消</Button>
        <Button variant="contained" onClick={submit} disabled={saving || remaining <= 0}>{saving ? '儲存中…' : '確認'}</Button>
      </DialogActions>
    </Dialog>
  );
}

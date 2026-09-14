import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Box, Button, Chip, Dialog, DialogContent, Divider, Drawer, IconButton, Skeleton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { ArrowRight, Check, RotateCcw, Send, X } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { usePermissions } from '../../app/PermissionContext';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatDateRange, formatDateTime, formatMoney } from '../../lib/format';
import { bookingStatusLabel } from '../../lib/bookingStatus';
import { computeUsage, linenItemLabel, normalizeChangeCount, type LinenItem, type LinenUsageRow, type RoomLinenDefault } from '../../lib/linenCost';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import { fetchBookingLinen, fetchLinenSetup, type BookingRow } from '../booking/bookingQueries';
import { advanceBookingStatus, saveBookingLinen, BookingActionError } from '../booking/bookingActions';
import { markStageConfirmed, saveStageEdits, type StageAction, type StageDef } from './processQueries';

// ========================================================================
// 處理面板：點一筆訂單後只顯示「這一關需要看的」——訂單編號、訂房資訊、金額、可編輯欄位、內部備註，
// 不把整張訂單攤出來。底部：取消（放棄編輯）／確認／確認並推進。
// 確認完直接切到第二步「發送通知」，訂單同時已離開佇列（清單由上層即時更新）。
// ========================================================================

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>{value ?? '—'}</Typography>
    </Box>
  );
}

export interface StagePanelProps {
  open: boolean;
  stage: StageDef;
  booking: BookingRow;
  action?: StageAction;
  onClose: () => void;
  /** 訂單或關卡紀錄改了：上層立刻更新清單 */
  onChanged: (updated: BookingRow) => void;
  onNotify: (booking: BookingRow, stage: StageDef) => void;
}

export default function StagePanel({ open, stage, booking, action, onClose, onChanged, onNotify }: StagePanelProps) {
  const { enqueueSnackbar } = useSnackbar();
  const { profile } = useAuth();
  const { hasPermission } = usePermissions();
  const { isDesktop } = useBreakpoint();
  const canAct = hasPermission(stage.permission);
  const canSeePayment = hasPermission('booking.payment.view');
  const canNotify = hasPermission('booking.notify');

  const [notes, setNotes] = useState('');
  const [remit, setRemit] = useState('');
  const [password, setPassword] = useState('');
  const [linen, setLinen] = useState<{ items: LinenItem[]; defaults: RoomLinenDefault[]; roomIds: string[]; usage: LinenUsageRow[] } | null>(null);
  const [linenLoading, setLinenLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<BookingRow | null>(null);
  const [remitError, setRemitError] = useState('');

  useEffect(() => {
    if (!open) return;
    setNotes(booking.notes || ''); setRemit(booking.remit_last5 || ''); setPassword(booking.check_in_password || '');
    setDone(null); setRemitError(''); setLinen(null);
    if (stage.fields.includes('linen')) {
      setLinenLoading(true);
      Promise.all([fetchLinenSetup(), fetchBookingLinen(booking.id)])
        .then(([setup, mine]) => setLinen({ items: setup.items, defaults: setup.defaults, roomIds: mine.roomIds, usage: mine.usage }))
        .finally(() => setLinenLoading(false));
    }
  }, [open, booking, stage]);

  const resetLinen = () => {
    if (!linen) return;
    setLinen({ ...linen, usage: computeUsage(linen.roomIds, linen.defaults, normalizeChangeCount(booking.linen_change_count), linen.items) });
    enqueueSnackbar('已回復為房型預設用量', { variant: 'info' });
  };
  const setQty = (item: LinenItem, qty: number) => {
    if (!linen) return;
    const others = linen.usage.filter((u) => u.linen_item_id !== item.id);
    setLinen({ ...linen, usage: qty > 0 ? [...others, { linen_item_id: item.id, quantity: qty, unit_price: item.unit_price ?? 0, is_manual: true }] : others });
  };

  const run = async (advance: boolean) => {
    if (!canAct) return;
    if (stage.fields.includes('remit') && !remit.trim()) { setRemitError('請先填寫匯款末5碼'); return; }
    setBusy(true);
    try {
      const patch: Parameters<typeof saveStageEdits>[1] = { notes: notes.trim() || null };
      if (stage.fields.includes('password')) patch.check_in_password = password.trim() || null;
      await saveStageEdits(booking, patch);
      if (linen) await saveBookingLinen(booking.id, linen.roomIds, linen.usage, true);
      let updated: BookingRow = { ...booking, ...patch } as BookingRow;
      if ((advance || stage.confirmAdvances) && stage.nextStatus) {
        await advanceBookingStatus(updated, stage.nextStatus, { remitLast5: remit.trim() });
        updated = { ...updated, status: stage.nextStatus, ...(stage.fields.includes('remit') ? { remit_last5: remit.trim() } : {}) };
      }
      await markStageConfirmed(booking.id, stage.key, profile?.email || profile?.id || 'unknown');
      onChanged(updated);
      setDone(updated);
      enqueueSnackbar(advance || stage.confirmAdvances ? `已確認，訂單進入「${bookingStatusLabel(updated.status)}」` : '已確認', { variant: 'success' });
    } catch (e: any) {
      enqueueSnackbar(e instanceof BookingActionError ? e.message : `儲存失敗：${e.message}`, { variant: 'error' });
    } finally { setBusy(false); }
  };

  const balance = booking.total_amount != null ? Number(booking.total_amount) - Number(booking.deposit || 0) : null;
  const nights = booking.nights ?? null;

  const header = (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <Chip label={stage.action} size="small" sx={{ bgcolor: stage.color, color: '#fff', fontWeight: 600 }} />
        <Typography variant="h6" noWrap sx={{ fontFamily: 'monospace', fontSize: 16 }}>{booking.order_number}</Typography>
        <StatusBadge status={(done || booking).status} />
      </Stack>
      <IconButton size="small" onClick={onClose} aria-label="關閉" disabled={busy}><X size={18} /></IconButton>
    </Box>
  );

  const info = (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>訂房資訊</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
          <Field label="客人" value={<>{booking.name || booking.nickname || '未取得'}{booking.phone ? <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>{booking.phone}</Typography> : null}</>} />
          <Field label="入住 → 退房" value={`${formatDateRange(booking.checkin_date, booking.checkout_date)}${nights ? `（${nights} 晚）` : ''}`} />
          <Field label="人數" value={booking.headcount != null ? `${booking.headcount} 人` : '—'} />
          <Field label="房型" value={booking.room_type_label || (booking.whole_house ? '包棟' : '—')} />
        </Box>
      </Box>
      <Box>
        <Typography variant="subtitle2" gutterBottom>金額</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.5 }}>
          <Field label="總額" value={formatMoney(booking.total_amount)} />
          <Field label="訂金" value={formatMoney(booking.deposit)} />
          <Field label="尾款" value={balance != null ? formatMoney(balance) : '—'} />
          <Field label="押金" value={formatMoney(booking.security_deposit)} />
          {canSeePayment && !stage.fields.includes('remit') && <Field label="匯款末五碼" value={booking.remit_last5 || '—'} mono />}
          {booking.payment_deadline_at && stage.key === 'awaiting_confirmation' && <Field label="匯款期限" value={formatDateTime(booking.payment_deadline_at)} />}
        </Box>
      </Box>
    </Stack>
  );

  const editor = (
    <Stack spacing={2}>
      <Alert severity="info" icon={false} sx={{ bgcolor: stage.colorLight, color: 'text.primary', fontSize: 13 }}>{stage.hint}</Alert>
      {stage.fields.includes('remit') && (
        <TextField label="匯款末5碼" value={remit} onChange={(e) => { setRemit(e.target.value.replace(/\D/g, '').slice(0, 5)); setRemitError(''); }} error={!!remitError} helperText={remitError || '核對到帳後填入，會寫進訂單'} inputProps={{ inputMode: 'numeric', maxLength: 5 }} required disabled={!canAct} sx={{ maxWidth: 240 }} />
      )}
      {stage.fields.includes('password') && (
        <TextField label="入住密碼" value={password} onChange={(e) => setPassword(e.target.value)} helperText="大門／房門密碼，發送「入住密碼發送」範本時會帶入 [入住密碼]" disabled={!canAct || !canSeePayment} sx={{ maxWidth: 240 }} />
      )}
      {stage.fields.includes('linen') && (
        <Box>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle2">洗物數量</Typography>
            <Button size="small" startIcon={<RotateCcw size={14} />} onClick={resetLinen} disabled={!linen || !canAct}>回復預設</Button>
          </Stack>
          {linenLoading || !linen ? <Skeleton variant="rounded" height={96} /> : linen.items.length === 0 ? (
            <Typography variant="body2" color="text.disabled">尚未建立任何布巾品項。</Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1 }}>
              {linen.items.map((it) => {
                const row = linen.usage.find((u) => u.linen_item_id === it.id);
                return (
                  <TextField
                    key={it.id} size="small" type="number" label={linenItemLabel(it)} value={row?.quantity ?? 0}
                    onChange={(e) => setQty(it, Math.max(0, Number(e.target.value) || 0))} inputProps={{ min: 0 }} disabled={!canAct}
                    InputLabelProps={{ shrink: true }}
                  />
                );
              })}
            </Box>
          )}
          {linen && linen.roomIds.length === 0 && <Typography variant="caption" color="warning.main">這筆訂單還沒連結房間，「回復預設」算不出用量；請先到訂單編輯勾選房間。</Typography>}
        </Box>
      )}
      <TextField label="內部備註" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={3} disabled={!canAct} helperText="只有後台看得到，不會發給客人" />
      {!canAct && <Alert severity="info">你沒有「{stage.action}」的權限，只能查看。</Alert>}
    </Stack>
  );

  const doneView = done && (
    <Stack spacing={2} alignItems="center" sx={{ py: 3, textAlign: 'center' }}>
      <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'success.light', color: 'success.dark', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={28} /></Box>
      <Typography variant="h6">已確認</Typography>
      <Typography variant="body2" color="text.secondary">訂單目前狀態：<StatusBadge status={done.status} />。接下來可以把結果通知客人。</Typography>
      {action?.notified_at && <Typography variant="caption" color="text.secondary">這一關已於 {formatDateTime(action.notified_at)} 通知過客人（{action.template_title || '自訂內容'}），可再發一次。</Typography>}
      <Tooltip title={!booking.line_user_id ? '這筆訂單沒有 LINE 帳號，無法推播' : !canNotify ? '沒有「發送訂單通知」權限' : ''}><span>
        <Button variant="contained" size="large" startIcon={<Send size={18} />} onClick={() => onNotify(done, stage)} disabled={!booking.line_user_id || !canNotify} sx={{ bgcolor: stage.color, '&:hover': { bgcolor: stage.color, filter: 'brightness(.92)' } }}>訊息發送</Button>
      </span></Tooltip>
      <Button color="inherit" onClick={onClose}>稍後再發，關閉</Button>
    </Stack>
  );

  const footer = !done && (
    <Box sx={{ px: 2.5, py: 1.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <Button color="inherit" onClick={onClose} disabled={busy}>取消</Button>
      <Button variant={stage.nextStatus && !stage.confirmAdvances ? 'outlined' : 'contained'} onClick={() => run(false)} disabled={busy || !canAct} startIcon={<Check size={16} />} sx={stage.nextStatus && !stage.confirmAdvances ? {} : { bgcolor: stage.color, '&:hover': { bgcolor: stage.color, filter: 'brightness(.92)' } }}>
        {busy ? '處理中…' : stage.confirmAdvances ? `確認（→ ${bookingStatusLabel(stage.nextStatus)}）` : '確認'}
      </Button>
      {stage.nextStatus && !stage.confirmAdvances && (
        <Button variant="contained" onClick={() => run(true)} disabled={busy || !canAct} endIcon={<ArrowRight size={16} />} sx={{ bgcolor: stage.color, '&:hover': { bgcolor: stage.color, filter: 'brightness(.92)' } }}>
          確認並推進到「{bookingStatusLabel(stage.nextStatus)}」
        </Button>
      )}
    </Box>
  );

  const content = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {header}
      <Box sx={{ p: 2.5, overflow: 'auto', flex: 1 }}>
        {done ? doneView : (
          <Stack spacing={3}>
            {info}
            <Divider />
            {editor}
          </Stack>
        )}
      </Box>
      {footer}
    </Box>
  );

  return isDesktop ? (
    <Drawer anchor="right" open={open} onClose={busy ? undefined : onClose} PaperProps={{ sx: { width: 560, maxWidth: '100vw' } }}>{content}</Drawer>
  ) : (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullScreen><DialogContent sx={{ p: 0 }}>{content}</DialogContent></Dialog>
  );
}

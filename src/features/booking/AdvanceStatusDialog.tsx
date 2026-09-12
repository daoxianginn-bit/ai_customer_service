import { useEffect, useState } from 'react';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { REQUIRES_REMIT_LAST5_STATUS, bookingStatusDescription, bookingStatusLabel } from '../../lib/bookingStatus';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import { advanceBookingStatus, BookingActionError } from './bookingActions';
import type { BookingRow } from './bookingQueries';

// ========================================================================
// 「推進狀態」確認視窗（V2 §24）。推進是不可逆的動作（會寫進訂單、留下操作紀錄，待入住那一關
// 還會影響排程），所以一律先問一次、並把 訂單編號／客戶／要改成什麼 攤開來確認。
// 推到「已預定」要在同一個視窗裡填匯款末5碼，所以不用共用的 useConfirm。
// ========================================================================
interface Props {
  target: { order: BookingRow; nextStatus: string } | null;
  onClose: () => void;
  onDone: () => void;
}

export default function AdvanceStatusDialog({ target, onClose, onDone }: Props) {
  const [remit, setRemit] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 「待確認 → 已預定」代表客服核對到訂金入帳，末5碼是核對的憑據，所以帶出訂單上已有的值
  // 讓客服確認，不是每次都要重打。
  useEffect(() => {
    if (target) {
      setRemit(target.order.remit_last5 || '');
      setError('');
    }
  }, [target]);

  const needsRemit = target?.nextStatus === REQUIRES_REMIT_LAST5_STATUS;
  const isCancel = target?.nextStatus === 'cancelled';

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await advanceBookingStatus(target.order, target.nextStatus, { remitLast5: remit });
      onDone();
    } catch (err: any) {
      setError(err instanceof BookingActionError ? err.message : `推進失敗：${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{isCancel ? '取消訂單' : '推進訂單狀態'}</DialogTitle>
      {target && (
        <DialogContent>
          <Stack spacing={2}>
            <Stack spacing={0.5}>
              <Typography variant="body2">
                訂單 <Typography component="span" sx={{ fontFamily: 'monospace' }}>{target.order.order_number || '—'}</Typography>
                ・{target.order.name || target.order.nickname || '未取得'}
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1}>
                <StatusBadge status={target.order.status} />
                <Typography variant="body2" color="text.secondary">→</Typography>
                <StatusBadge status={target.nextStatus} />
              </Stack>
              <Typography variant="caption" color="text.secondary">{bookingStatusDescription(target.nextStatus)}</Typography>
            </Stack>

            {isCancel && (
              <Alert severity="warning">
                取消後這張訂單不再佔用房況；若已收款需退還，請改推到「待退款」。
              </Alert>
            )}

            {needsRemit && (
              <TextField
                label="匯款末5碼"
                required
                value={remit}
                onChange={(e) => setRemit(e.target.value)}
                placeholder="核對到帳的匯款末5碼"
                helperText="「已預定」代表訂金已經核對入帳，所以這一欄必填。"
                autoFocus
                fullWidth
              />
            )}

            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
      )}
      <DialogActions>
        <Button variant="outlined" color="inherit" onClick={onClose} disabled={busy}>返回</Button>
        <Button variant="contained" color={isCancel ? 'error' : 'primary'} onClick={confirm} disabled={busy}>
          {busy ? '處理中…' : isCancel ? '確認取消訂單' : `推進到「${bookingStatusLabel(target?.nextStatus)}」`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

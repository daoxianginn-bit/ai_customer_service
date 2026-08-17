import type { ReactNode } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Drawer,
  IconButton, Stack, Typography,
} from '@mui/material';
import { X } from 'lucide-react';
import { useConfirm } from './ConfirmDialogProvider';

// ========================================================================
// CRUD 四層式架構的第 4 層：新增/編輯表單。
//
// 規範規定欄位 ≤ 6 用置中 Dialog、> 6 用右側 Drawer (520px)。這裡把兩者包成同一個
// 元件、由 fieldCount 自動決定，呼叫端就不需要每個頁面自己判斷（也避免有人憑感覺選，
// 最後同一個系統裡兩種樣式亂用）。真的需要指定時可以用 variant 覆寫。
//
// 另外實作規範要求的「表單變更但未儲存離開時需觸發防呆提示」：只要 dirty=true，
// 關閉前一律先跳二次確認，避免填了一長串資料被一次點掉。
// ========================================================================

const DRAWER_WIDTH = 520;
const DIALOG_FIELD_THRESHOLD = 6;

interface FormPanelProps {
  open: boolean;
  title: string;
  /** 欄位數量，用來決定 Dialog 或 Drawer；給了 variant 就以 variant 為準 */
  fieldCount?: number;
  variant?: 'dialog' | 'drawer';
  /** 表單是否有未儲存的變更；true 時關閉會先跳防呆確認 */
  dirty?: boolean;
  saving?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  children: ReactNode;
  /** 額外的左側動作（例如「刪除」），跟儲存/取消同一列 */
  extraActions?: ReactNode;
}

export default function FormPanel({
  open, title, fieldCount = 0, variant, dirty, saving,
  onClose, onSubmit, submitLabel = '儲存', children, extraActions,
}: FormPanelProps) {
  const confirm = useConfirm();
  const mode = variant ?? (fieldCount > DIALOG_FIELD_THRESHOLD ? 'drawer' : 'dialog');

  const requestClose = async () => {
    if (saving) return; // 儲存中不讓關，避免請求還在飛就把畫面收掉
    if (dirty) {
      const ok = await confirm({
        title: '尚未儲存的變更會遺失',
        message: '這張表單有修改過但還沒儲存，確定要關閉嗎？',
        confirmLabel: '關閉不儲存',
        cancelLabel: '繼續編輯',
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  const footer = (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ width: '100%' }}>
      {extraActions}
      <Box sx={{ flexGrow: 1 }} />
      <Button variant="outlined" color="inherit" onClick={requestClose} disabled={saving}>取消</Button>
      <Button variant="contained" onClick={onSubmit} disabled={saving}>
        {saving ? '儲存中…' : submitLabel}
      </Button>
    </Stack>
  );

  if (mode === 'drawer') {
    return (
      <Drawer
        anchor="right"
        open={open}
        onClose={requestClose}
        PaperProps={{ sx: { width: DRAWER_WIDTH, maxWidth: '100vw', display: 'flex', flexDirection: 'column' } }}
      >
        <Stack direction="row" alignItems="center" sx={{ p: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>{title}</Typography>
          <IconButton onClick={requestClose} disabled={saving} aria-label="關閉"><X size={18} /></IconButton>
        </Stack>
        <Divider />
        <Box sx={{ p: 2, flex: 1, overflowY: 'auto' }}>{children}</Box>
        <Divider />
        <Box sx={{ p: 2 }}>{footer}</Box>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onClose={requestClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 16, fontWeight: 600, pr: 6 }}>
        {title}
        <IconButton
          onClick={requestClose}
          disabled={saving}
          aria-label="關閉"
          sx={{ position: 'absolute', right: 12, top: 12 }}
        >
          <X size={18} />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>{children}</DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>{footer}</DialogActions>
    </Dialog>
  );
}

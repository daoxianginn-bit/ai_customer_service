import { Chip } from '@mui/material';
import { ALL_BOOKING_STATUSES } from '../../lib/bookingStatus';

// ========================================================================
// 訂單狀態標籤的 MUI 版本，對應 Tailwind 版的 ui/StatusBadge。
//
// 顏色不再各自寫死色碼，改成映射到 theme 的語意色：狀態的「意義」（進行中/警示/
// 完成/失敗）由這裡決定，實際色碼由 theme 統一控制，之後要調色只改 theme 一處。
// 文字仍以 bookingStatus.ts 為單一來源，跟後端、行事曆用同一份定義。
// ========================================================================

type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

// 依訂單流程的語意分色，不是照 Tailwind 舊版的顏色逐一照抄——
// 舊版有些顏色只是為了視覺區隔，語意上其實同一類。
const BOOKING_STATUS_COLOR: Record<string, ChipColor> = {
  inquiring: 'default',              // 待報價：還沒開始，中性
  quoted: 'info',                    // 已報價：等客人回應
  awaiting_deposit: 'warning',       // 待預定：等匯款，要盯
  reserved: 'primary',               // 已預定：已收訂金
  awaiting_balance: 'warning',       // 待收尾款：要盯
  confirmed: 'success',              // 已確認：收齊了
  awaiting_refund: 'error',          // 待退款：異常流程
  refunded: 'default',               // 已退款：結案
  cancelled: 'default',              // 已取消：結案
  pending_manual_conflict: 'error',  // 待人工確認：系統偵測到衝突，最需要注意
};

// 訂單狀態以外的狀態代碼（真人客服轉接紀錄等），跟訂單狀態不共用定義。
const OTHER_STATUS: Record<string, { label: string; color: ChipColor }> = {
  open: { label: '進行中', color: 'error' },
  closed: { label: '已結束', color: 'default' },
  Running: { label: 'Running', color: 'info' },
  Idle: { label: 'Idle', color: 'default' },
  Failed: { label: 'Failed', color: 'error' },
  success: { label: '成功', color: 'success' },
  failed: { label: '失敗', color: 'error' },
};

const BOOKING_LABEL: Record<string, string> = Object.fromEntries(
  ALL_BOOKING_STATUSES.map((s) => [s.value, s.label])
);

interface StatusChipMuiProps {
  status: string;
  /** 覆蓋預設文字（狀態代碼不在對照表裡但已知文字時用） */
  label?: string;
}

export default function StatusChipMui({ status, label }: StatusChipMuiProps) {
  const other = OTHER_STATUS[status];
  const text = label ?? BOOKING_LABEL[status] ?? other?.label ?? status;
  const color = BOOKING_STATUS_COLOR[status] ?? other?.color ?? 'default';

  return (
    <Chip
      label={text}
      color={color}
      // outlined 在高密度表格裡比實心底色乾淨，不會整排都是色塊
      variant={color === 'default' ? 'filled' : 'outlined'}
      sx={{ fontWeight: 500 }}
    />
  );
}

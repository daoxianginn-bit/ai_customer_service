import { Box, Chip, type ChipProps } from '@mui/material';
import { bookingStatusMeta, type StatusTone } from '../../lib/bookingStatus';

// ========================================================================
// 狀態 Badge（V2 §21、§94、§130）：顏色只由 tone 決定，全站五種色調。
// 訂單狀態直接傳 status 代碼，label／tone 從 bookingStatus.ts 取；其他狀態（轉接、排程結果）
// 自己給 label + tone。淡底 + 深字，不用實心高飽和色塊。
// ========================================================================

const TONE_SX: Record<StatusTone, { bg: string; fg: string; dot: string }> = {
  neutral: { bg: 'grey.100', fg: 'text.secondary', dot: 'grey.400' },
  info:    { bg: 'info.light', fg: 'info.dark', dot: 'info.main' },
  success: { bg: 'success.light', fg: 'success.dark', dot: 'success.main' },
  warning: { bg: 'warning.light', fg: 'warning.dark', dot: 'warning.main' },
  danger:  { bg: 'error.light', fg: 'error.dark', dot: 'error.main' },
};

interface StatusBadgeProps extends Omit<ChipProps, 'color' | 'label'> {
  /** 訂單狀態代碼；給了就自動取 label 與 tone */
  status?: string | null;
  label?: string;
  tone?: StatusTone;
  /** 前面加一個小圓點（列表裡掃描用） */
  dot?: boolean;
}

export default function StatusBadge({ status, label, tone, dot = true, size = 'small', sx, ...rest }: StatusBadgeProps) {
  const meta = status ? bookingStatusMeta(status) : null;
  const text = label ?? meta?.label ?? status ?? '';
  const t: StatusTone = tone ?? meta?.tone ?? 'neutral';
  const c = TONE_SX[t];

  return (
    <Chip
      size={size}
      label={
        dot ? (
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
            <Box component="span" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: c.dot, flexShrink: 0 }} />
            {text}
          </Box>
        ) : text
      }
      sx={{ bgcolor: c.bg, color: c.fg, fontWeight: 500, border: 'none', ...sx }}
      {...rest}
    />
  );
}

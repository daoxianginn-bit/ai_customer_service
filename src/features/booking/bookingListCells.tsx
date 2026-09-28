import { Box, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import { Home, Users } from 'lucide-react';
import { BALANCE_PAID_STATUSES, DEPOSIT_OR_LATER_STATUSES, bookingStatusMeta, type StatusTone } from '../../lib/bookingStatus';
import { formatMoney, formatShortDate, todayIso } from '../../lib/format';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import { bookingSourceLabel, type BookingRow } from './bookingQueries';
import { hasUnpaidExtraCharges } from '../../lib/extraCharges';

// ========================================================================
// 訂單列表的欄位呈現（表格與手機卡片共用）。
//
// 原本每一欄都是同樣大小的純文字，一整頁看起來只有一片灰，要逐格讀才知道哪筆重要。
// 這裡把「掃描時真正要的資訊」做出層次：
//   1. 每列左邊一條狀態色軌（跟 Badge 同一套 tone），同一類的訂單自然成群
//   2. 客人名字是主角（訂單編號降成第二行的等寬小字）
//   3. 入住日期旁邊直接標「今天／明天／3 天後」，不用自己對照今天是幾號
//   4. 金額用一條收款進度條表示「收到多少、還差多少」，比兩行小字快
// ========================================================================

export const TONE_COLOR: Record<StatusTone, string> = {
  neutral: 'grey.400', info: 'info.main', success: 'success.main', warning: 'warning.main', danger: 'error.main',
};

/** 卡片用：整張卡的左邊框 */
export const rowRailSx = (status: string) => ({
  borderLeft: '4px solid',
  borderLeftColor: TONE_COLOR[bookingStatusMeta(status).tone],
});

/** 表格用：border 要下在第一個 td，下在 tr 上會被 MUI 的 border-collapse 吃掉 */
export const tableRailSx = (status: string) => ({
  '& td:first-of-type': { borderLeft: '4px solid', borderLeftColor: TONE_COLOR[bookingStatusMeta(status).tone] },
});

/** 入住日離今天多遠：掃清單時最常問的問題 */
export function checkinHint(checkinDate?: string | null): { label: string; urgent: boolean } | null {
  if (!checkinDate) return null;
  const today = todayIso();
  const diff = Math.round((new Date(`${checkinDate}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400e3);
  if (diff === 0) return { label: '今天', urgent: true };
  if (diff === 1) return { label: '明天', urgent: true };
  if (diff > 1 && diff <= 7) return { label: `${diff} 天後`, urgent: diff <= 3 };
  return null;
}

/**
 * 這筆訂單要不要顯示收款進度：OTA 匯進來的訂單錢不經過我們、取消與退款類的「未收多少」沒有意義，
 * 顯示了只會讓人以為有一筆錢沒收到。
 */
const NO_PAYMENT_TRACKING = ['external_synced', 'cancelled', 'awaiting_refund', 'refunded'];
export const tracksPayment = (status: string) => !NO_PAYMENT_TRACKING.includes(status);

/**
 * 依狀態推算已收多少：待確認之前是 0、已預定起收了訂金、待入住起全收。
 * 追加款另外算：已付的算已收、未付的算未收——尾款收完之後才加的追加款，就會讓「款項已結清」的單重新出現未收。
 */
export function paymentState(r: BookingRow): { total: number; paid: number; due: number; percent: number } {
  const base = Number(r.total_amount || 0);
  const extraPaid = Number(r.extra_paid_total || 0);
  const total = base + extraPaid + Number(r.extra_unpaid_total || 0);
  const basePaid = BALANCE_PAID_STATUSES.includes(r.status) ? base
    : DEPOSIT_OR_LATER_STATUSES.includes(r.status) ? Number(r.deposit || 0) : 0;
  const paid = basePaid + extraPaid;
  const due = Math.max(0, total - paid);
  return { total, paid, due, percent: total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0 };
}

export function CustomerCell({ r }: { r: BookingRow }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" fontWeight={600} noWrap>{r.name || r.nickname || '未取得'}</Typography>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace' }}>{r.order_number || '—'}</Typography>
        {r.name && r.nickname && r.name !== r.nickname && <Typography variant="caption" color="text.secondary" noWrap>{r.nickname}</Typography>}
      </Stack>
    </Box>
  );
}

export function DatesCell({ r }: { r: BookingRow }) {
  const hint = checkinHint(r.checkin_date);
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Typography variant="body2" fontWeight={500} noWrap>
          {formatShortDate(r.checkin_date) || '—'}
          <Box component="span" sx={{ color: 'text.disabled', mx: 0.5 }}>→</Box>
          {formatShortDate(r.checkout_date) || '—'}
        </Typography>
        {hint && (
          <Box component="span" sx={{
            px: 0.75, py: 0.125, borderRadius: 0.75, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
            bgcolor: hint.urgent ? 'warning.light' : 'grey.100', color: hint.urgent ? 'warning.dark' : 'text.secondary',
          }}>{hint.label}</Box>
        )}
      </Stack>
      <Typography variant="caption" color="text.secondary">{r.nights ? `${r.nights} 晚` : '—'}・{bookingSourceLabel(r)}</Typography>
    </Box>
  );
}

export function RoomCell({ r }: { r: BookingRow }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={0.4} alignItems="center" sx={{ color: 'text.secondary', flexShrink: 0 }}>
        <Users size={13} /><Typography variant="body2">{r.headcount ?? '—'}</Typography>
      </Stack>
      <Stack direction="row" spacing={0.4} alignItems="center" sx={{ minWidth: 0 }}>
        <Home size={13} style={{ flexShrink: 0, opacity: 0.55 }} />
        <Typography variant="body2" noWrap>{r.whole_house ? '包棟' : r.room_type_label || '—'}</Typography>
      </Stack>
    </Stack>
  );
}

/** 金額＋收款進度：一條細槓比「訂金 x／尾款 y」兩行小字快得多 */
export function MoneyCell({ r, align = 'right' }: { r: BookingRow; align?: 'left' | 'right' }) {
  const p = paymentState(r);
  const settled = p.due === 0 && p.total > 0;
  return (
    <Tooltip title={p.total > 0 ? `總額 ${formatMoney(p.total)}・已收 ${formatMoney(p.paid)}${p.due > 0 ? `・未收 ${formatMoney(p.due)}` : ''}` : ''}>
      <Box sx={{ minWidth: 92, textAlign: align }}>
        <Typography variant="body2" fontWeight={600} sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatMoney(r.total_amount) || '—'}</Typography>
        {p.total > 0 && tracksPayment(r.status) && (
          <>
            <LinearProgress
              variant="determinate" value={p.percent}
              sx={{ height: 4, borderRadius: 2, my: 0.4, bgcolor: 'grey.200', '& .MuiLinearProgress-bar': { borderRadius: 2, bgcolor: settled ? 'success.main' : p.percent > 0 ? 'warning.main' : 'grey.300' } }}
            />
            <Typography variant="caption" color={settled ? 'success.main' : 'text.secondary'} noWrap>
              {settled ? '款項已結清' : `未收 ${formatMoney(p.due, { withCurrency: false })}`}
            </Typography>
          </>
        )}
      </Box>
    </Tooltip>
  );
}

/** 尾款已收、還有追加款沒收：會計要另外收，訂單列表上要看得出來 */
export function ExtraUnpaidTag({ r }: { r: BookingRow }) {
  if (!BALANCE_PAID_STATUSES.includes(r.status) || !hasUnpaidExtraCharges(r)) return null;
  return (
    <Tooltip title={`尾款已收，還有追加款 ${formatMoney(r.extra_unpaid_total)} 未收`}>
      <Box component="span" sx={{ px: 0.75, py: 0.125, borderRadius: 0.75, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', bgcolor: '#fef9c3', color: '#a16207' }}>未收追加款</Box>
    </Tooltip>
  );
}

/** 狀態：Badge 前面補流程編號，跟篩選列的 1~9 對得起來 */
export function StatusCell({ r }: { r: BookingRow }) {
  const meta = bookingStatusMeta(r.status);
  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      {meta.order != null && meta.order >= 1 && meta.order <= 9 && (
        <Box sx={{
          width: 18, height: 18, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 700, bgcolor: 'grey.100', color: 'text.secondary',
        }}>{meta.order}</Box>
      )}
      <StatusBadge status={r.status} />
      <ExtraUnpaidTag r={r} />
    </Stack>
  );
}

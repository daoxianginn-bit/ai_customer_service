import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Link, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatDateRange, formatDateTime } from '../../lib/format';
import { usePermission } from '../../app/Can';
import { useBreakpoint } from '../../app/useBreakpoint';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { bookingSourceLabel, type BookingRow } from './bookingQueries';
import { resolveOtaConflict } from './bookingActions';

// ========================================================================
// 候補／衝突（V2 §4.2）：三種「系統自己解不了、要人看」的訂單集中在一頁。
//   OTA 房況衝突：OTA 同步進來的日期跟本地訂單重疊（bookings.ota_conflict_with）
//   撞期待確認：LINE 訂房流程算不出房、被系統攔下（status=pending_manual_conflict，無候補對象）
//   候補中：同上，但記了「等哪一筆有結果」（waitlist_blocked_by），排程會自動重新報價
// 沒有新資料表：全部從 bookings 既有欄位讀。
// ========================================================================

interface ConflictData {
  ota: BookingRow[];
  manual: BookingRow[];
  waitlist: BookingRow[];
  related: Record<string, BookingRow>;
}

async function fetchConflicts(): Promise<ConflictData> {
  const [otaRes, pendingRes] = await Promise.all([
    supabase.from('bookings').select('*').not('ota_conflict_with', 'is', null).order('checkin_date'),
    supabase.from('bookings').select('*').eq('status', 'pending_manual_conflict').order('checkin_date'),
  ]);
  if (otaRes.error) throw otaRes.error;
  if (pendingRes.error) throw pendingRes.error;
  const ota = (otaRes.data || []) as BookingRow[];
  const pending = (pendingRes.data || []) as BookingRow[];
  const manual = pending.filter((b) => !b.waitlist_blocked_by);
  const waitlist = pending.filter((b) => !!b.waitlist_blocked_by);

  // 相關訂單（撞到誰、等誰）一次撈回來，列表上才顯示得出對方是誰
  const ids = Array.from(new Set([...ota.map((b) => b.ota_conflict_with), ...waitlist.map((b) => b.waitlist_blocked_by)].filter(Boolean))) as string[];
  const related: Record<string, BookingRow> = {};
  if (ids.length) {
    const { data } = await supabase.from('bookings').select('id, order_number, name, nickname, checkin_date, checkout_date, status, room_type_label, whole_house').in('id', ids);
    for (const r of (data || []) as BookingRow[]) related[r.id] = r;
  }
  return { ota, manual, waitlist, related };
}

function Row({ booking, related, relatedLabel, note, actions }: { booking: BookingRow; related?: BookingRow | null; relatedLabel?: string; note?: string; actions?: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Link component={RouterLink} to={`/bookings/${booking.id}`} variant="body2" sx={{ fontWeight: 600 }} underline="hover">
              {booking.name || booking.nickname || '未取得'}
            </Link>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{booking.order_number || '—'}</Typography>
            <StatusBadge status={booking.status} />
            <Typography variant="caption" color="text.secondary">{bookingSourceLabel(booking)}</Typography>
          </Stack>
          <Typography variant="body2" sx={{ mt: 0.5 }}>
            {formatDateRange(booking.checkin_date, booking.checkout_date) || '日期未定'}
            {booking.headcount ? `・${booking.headcount} 人` : ''}・{booking.whole_house ? '包棟' : booking.room_type_label || '房型未定'}
          </Typography>
          {related && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {relatedLabel}：<Link component={RouterLink} to={`/bookings/${related.id}`} underline="hover">{related.order_number || related.id}</Link>
              ・{related.name || related.nickname || '未取得'}・{formatDateRange(related.checkin_date, related.checkout_date)}・{related.status ? <StatusBadge status={related.status} dot={false} size="small" sx={{ height: 18, fontSize: 11 }} /> : null}
            </Typography>
          )}
          {note && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{note}</Typography>}
        </Box>
        {actions && <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>{actions}</Stack>}
      </Stack>
    </Paper>
  );
}

function Section({ title, description, count, children }: { title: string; description: string; count: number; children: ReactNode }) {
  return (
    <Box>
      <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1">{title}</Typography>
        <Typography variant="body2" color={count ? 'error.main' : 'text.secondary'} sx={{ fontWeight: 600 }}>{count}</Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>{description}</Typography>
      {count === 0 ? <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>目前沒有。</Typography> : <Stack spacing={1}>{children}</Stack>}
    </Box>
  );
}

export default function BookingConflictsPage() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const canEdit = usePermission('booking.edit');
  const [data, setData] = useState<ConflictData | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setData(await fetchConflicts()); } catch (e: any) { setError(e.message || '載入失敗'); setData({ ota: [], manual: [], waitlist: [], related: {} }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const clearOta = async (b: BookingRow) => {
    const ok = await confirm({
      title: '標記為已查核',
      message: `確定 ${bookingSourceLabel(b)} 訂單 ${b.order_number || ''}（${formatDateRange(b.checkin_date, b.checkout_date)}）跟本地訂單沒有實際撞期？只會清掉撞期旗標，訂單本身不變。`,
      confirmLabel: '清除旗標',
    });
    if (!ok) return;
    try {
      await resolveOtaConflict(b);
      enqueueSnackbar('已清除撞期旗標', { variant: 'success' });
      load();
    } catch (e: any) {
      enqueueSnackbar(`清除失敗：${e.message}`, { variant: 'error' });
    }
  };

  return (
    <Box>
      <PageHeaderV2 secondary={<Button color="inherit" startIcon={<RefreshCw size={16} />} onClick={load}>{isMobile ? '' : '重新整理'}</Button>} />
      {error && <ResultState status={500} description={error} onRetry={load} backTo={false} />}
      {data === null ? (
        <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={72} />)}</Stack>
      ) : (
        <Stack spacing={4}>
          <Section title="OTA 房況衝突" count={data.ota.length} description="從 Airbnb／Booking 等平台同步進來的訂單，日期跟本地訂單重疊。請到平台後台確認哪一筆是真的，處理完再清除旗標（下次同步若已不撞期也會自動清除）。">
            {data.ota.map((b) => (
              <Row
                key={b.id}
                booking={b}
                related={b.ota_conflict_with ? data.related[b.ota_conflict_with] : null}
                relatedLabel="撞到本地訂單"
                note={b.ota_conflict_detected_at ? `偵測於 ${formatDateTime(String(b.ota_conflict_detected_at))}` : undefined}
                actions={canEdit && <Button size="small" variant="outlined" color="inherit" onClick={() => clearOta(b)}>已查核，清除旗標</Button>}
              />
            ))}
          </Section>

          <Section title="撞期待人工確認" count={data.manual.length} description="LINE 訂房流程算不出可用房間、被系統攔下的訂單。請核實實際空房後，到訂單頁改成正確狀態（有房→待確認／待預定，沒房→取消）。">
            {data.manual.map((b) => (
              <Row key={b.id} booking={b} actions={<Button size="small" variant="contained" component={RouterLink} to={`/bookings/${b.id}`}>處理</Button>} />
            ))}
          </Section>

          <Section title="候補中" count={data.waitlist.length} description="被別筆訂單卡住的詢問。等那筆有結果（已預定或取消），候補排程會自動重新試算並推播給客人；不用人工動作，除非想直接幫客人改單。">
            {data.waitlist.map((b) => (
              <Row
                key={b.id}
                booking={b}
                related={b.waitlist_blocked_by ? data.related[b.waitlist_blocked_by] : null}
                relatedLabel="等待這筆有結果"
                actions={<Button size="small" variant="outlined" color="inherit" component={RouterLink} to={`/bookings/${b.id}`}>開啟訂單</Button>}
              />
            ))}
          </Section>
        </Stack>
      )}
    </Box>
  );
}

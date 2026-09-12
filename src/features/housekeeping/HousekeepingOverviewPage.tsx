import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Grid, Link, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { RefreshCw } from 'lucide-react';
import { formatDate, formatDateRange } from '../../lib/format';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import { fetchHousekeepingKpis, type HousekeepingKpis } from './housekeepingQueries';

// ========================================================================
// 房務總覽（V2 §45）：今日退房／今日入住／待洗布巾／低庫存。沒有清潔管理表，
// 「待清潔」就是今日退房的房間；架構保留，之後有清潔狀態再接上。
// ========================================================================

function Kpi({ label, value, hint, href, warn }: { label: string; value: number | null; hint?: string; href: string; warn?: boolean }) {
  const hl = warn && value != null && value > 0;
  return (
    <Paper component={RouterLink} to={href} variant="outlined" sx={{ p: 2, display: 'block', textDecoration: 'none', color: 'inherit', height: '100%', borderColor: hl ? 'warning.main' : undefined, '&:hover': { borderColor: 'primary.main' } }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      {value == null ? <Skeleton width={48} height={36} /> : <Typography sx={{ fontSize: 28, lineHeight: '36px', fontWeight: 600, color: hl ? 'warning.dark' : 'text.primary' }}>{value}</Typography>}
      {hint && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{hint}</Typography>}
    </Paper>
  );
}

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
        <Typography variant="subtitle2">{title}</Typography>{action}
      </Stack>
      {children}
    </Paper>
  );
}

export default function HousekeepingOverviewPage() {
  const [data, setData] = useState<HousekeepingKpis | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setData(await fetchHousekeepingKpis()); } catch (e: any) { setError(e.message || '載入失敗'); setData(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <Box>
      <PageHeaderV2 secondary={<Button color="inherit" startIcon={<RefreshCw size={16} />} onClick={load}>重新整理</Button>} />
      {error && <ResultState status={500} description={error} onRetry={load} backTo={false} />}
      <Grid container spacing={1.5} sx={{ mb: 3 }}>
        <Grid item xs={6} md={3}><Kpi label="今日退房" value={data?.checkoutsToday ?? null} hint="退房後房間待清潔" href="/bookings/calendar" warn /></Grid>
        <Grid item xs={6} md={3}><Kpi label="今日入住" value={data?.checkinsToday ?? null} hint="今天要備妥的房間" href="/bookings?view=upcoming" /></Grid>
        <Grid item xs={6} md={3}><Kpi label="待洗布巾" value={data?.laundryPiecesToday ?? null} hint="今日入住訂單的用量（件）" href="/housekeeping/laundry" /></Grid>
        <Grid item xs={6} md={3}><Kpi label="低庫存耗材" value={data ? data.lowStock.length : null} hint="低於補貨門檻" href="/housekeeping/consumables" warn /></Grid>
      </Grid>

      <Grid container spacing={2} alignItems="stretch">
        <Grid item xs={12} md={7}>
          <Block title={`今日退房・${formatDate(new Date())}`} action={<Link component={RouterLink} to="/bookings/calendar" variant="body2" underline="hover">房況行事曆 →</Link>}>
            {!data && <Stack spacing={1}>{[0, 1].map((i) => <Skeleton key={i} variant="rounded" height={48} />)}</Stack>}
            {data && data.checkoutsList.length === 0 && <Typography variant="body2" color="text.secondary">今天沒有退房。</Typography>}
            <Stack spacing={1}>
              {data?.checkoutsList.map((b) => (
                <Stack key={b.id} direction="row" spacing={1.5} alignItems="center" component={RouterLink} to={`/bookings/${b.id}`} sx={{ textDecoration: 'none', color: 'inherit', p: 1, borderRadius: 1, border: '1px solid', borderColor: 'divider', '&:hover': { borderColor: 'primary.main' } }}>
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{b.name || b.nickname || '未取得'}{b.headcount ? `・${b.headcount} 人` : ''}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{b.whole_house ? '包棟' : b.room_type_label || '房型未定'}・{formatDateRange(b.checkin_date, b.checkout_date)}</Typography>
                  </Box>
                  <StatusBadge status={b.status} />
                </Stack>
              ))}
            </Stack>
          </Block>
        </Grid>
        <Grid item xs={12} md={5}>
          <Block title="低庫存耗材" action={<Link component={RouterLink} to="/housekeeping/consumables" variant="body2" underline="hover">耗材管理 →</Link>}>
            {!data && <Skeleton variant="rounded" height={48} />}
            {data && data.lowStock.length === 0 && <Typography variant="body2" color="text.secondary">庫存都在門檻之上。</Typography>}
            <Stack spacing={0.75}>
              {data?.lowStock.map((c) => (
                <Stack key={c.id} direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2">{c.name}</Typography>
                  <Typography variant="body2" color="warning.dark">{c.stock_quantity} {c.unit}<Typography component="span" variant="caption" color="text.secondary">／門檻 {c.restock_threshold}</Typography></Typography>
                </Stack>
              ))}
            </Stack>
          </Block>
        </Grid>
      </Grid>
    </Box>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Chip, Grid, Link, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { hasPermission } from '../../app/permissions';
import { formatDate, formatShortDate, todayIso, addDaysIso } from '../../lib/format';
import { useBreakpoint } from '../../app/useBreakpoint';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import type { BookingRow } from '../booking/bookingQueries';
import { bookingSourceLabel } from '../booking/bookingQueries';
import { deriveBookingTasks, fetchHandoverTask, fetchSystemErrorTask, fetchTaskBookings, sortTasks, type Task, type TaskSeverity } from '../tasks/taskQueries';
import { fetchKpis, fetchSystemHealth, fetchTodayConversationStats, fetchUpcomingCheckins, type DashboardKpis, type HealthItem } from './dashboardQueries';

// ========================================================================
// 工作台（V2 §19、§110、§134）：一進後台先回答「今天有誰要來、有什麼要處理、系統有沒有壞」。
// 純唯讀：沒有任何會改資料的控制項，要動手就點進對應頁面。
// 每個區塊各自載入、各自 Skeleton（§2426），一個區塊慢不會拖住整頁。
// ========================================================================

const SEVERITY_TONE: Record<TaskSeverity, 'danger' | 'warning' | 'info'> = { critical: 'danger', warning: 'warning', normal: 'info' };
const SEVERITY_LABEL: Record<TaskSeverity, string> = { critical: '緊急', warning: '待處理', normal: '例行' };

function KpiCard({ label, value, hint, href, tone }: { label: string; value: number | null; hint?: string; href: string; tone?: 'danger' | 'warning' }) {
  const highlight = value != null && value > 0 && tone;
  return (
    <Paper
      component={RouterLink}
      to={href}
      variant="outlined"
      sx={{
        p: 2, display: 'block', textDecoration: 'none', color: 'inherit', height: '100%',
        borderColor: highlight === 'danger' ? 'error.main' : highlight === 'warning' ? 'warning.main' : undefined,
        '&:hover': { borderColor: 'primary.main' },
      }}
    >
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      {value == null
        ? <Skeleton width={48} height={36} />
        : <Typography sx={{ fontSize: 28, lineHeight: '36px', fontWeight: 600, color: highlight === 'danger' ? 'error.main' : highlight === 'warning' ? 'warning.dark' : 'text.primary' }}>{value}</Typography>}
      {hint && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{hint}</Typography>}
    </Paper>
  );
}

function Block({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
        <Typography variant="subtitle2">{title}</Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}

const HEALTH_LABEL: Record<HealthItem['level'], string> = { ok: '正常', warning: '警告', error: '異常', unset: '未設定' };

function greeting(): string {
  const h = new Date().getHours();
  return h < 11 ? '早安' : h < 18 ? '午安' : '晚安';
}

export default function DashboardPage() {
  const { role, profile } = useAuth();
  const { isMobile } = useBreakpoint();
  const canSeeHealth = hasPermission(role, 'integration.view');
  const canSeeErrors = hasPermission(role, 'audit.view');

  const [kpis, setKpis] = useState<DashboardKpis | null>(null);
  const [convStats, setConvStats] = useState<{ conversations: number; handovers: number } | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [upcoming, setUpcoming] = useState<BookingRow[] | null>(null);
  const [health, setHealth] = useState<HealthItem[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    // 各區塊獨立載入：一個失敗不擋其他區塊
    fetchKpis().then(setKpis).catch((e) => setError(e.message));
    fetchTodayConversationStats().then(setConvStats).catch(() => setConvStats({ conversations: 0, handovers: 0 }));
    Promise.all([
      fetchTaskBookings().then(deriveBookingTasks),
      fetchHandoverTask().catch(() => null),
      canSeeErrors ? fetchSystemErrorTask().catch(() => null) : Promise.resolve(null),
    ]).then(([booking, handover, sys]) => setTasks(sortTasks([...booking, ...(handover ? [handover] : []), ...(sys ? [sys] : [])])))
      .catch((e) => { setTasks([]); setError(e.message); });
    fetchUpcomingCheckins().then(setUpcoming).catch(() => setUpcoming([]));
    if (canSeeHealth) fetchSystemHealth().then(setHealth).catch(() => setHealth([]));
  }, [canSeeHealth, canSeeErrors]);

  useEffect(() => { load(); }, [load]);

  const today = todayIso();
  const tomorrow = addDaysIso(today, 1);
  const dayLabel = (d: string) => (d === today ? '今天' : d === tomorrow ? '明天' : formatShortDate(d));
  const groupedUpcoming = (upcoming || []).reduce<Record<string, BookingRow[]>>((acc, b) => {
    const k = b.checkin_date || '';
    (acc[k] ||= []).push(b);
    return acc;
  }, {});

  const shownTasks = (tasks || []).slice(0, 8);
  const hasUnhealthy = (health || []).some((h) => h.level === 'error' || h.level === 'warning');

  return (
    <Box>
      <PageHeaderV2
        title={`${profile?.display_name ? `${profile.display_name}，` : ''}${greeting()}`}
        description={`${formatDate(today)}・今天的營運狀況與需要處理的事項`}
        secondary={<Button color="inherit" startIcon={<RefreshCw size={16} />} onClick={load}>重新整理</Button>}
      />

      {error && <ResultState status={500} description={error} onRetry={load} backTo={false} />}

      {/* 第一列 KPI（§19.1）：桌面 4 欄、平板／手機 2 欄（§134） */}
      <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
        <Grid item xs={6} md={3}><KpiCard label="今日入住" value={kpis?.checkinsToday ?? null} href={`/bookings?from=${today}&to=${today}`} /></Grid>
        <Grid item xs={6} md={3}><KpiCard label="今日退房" value={kpis?.checkoutsToday ?? null} href="/bookings/calendar" /></Grid>
        <Grid item xs={6} md={3}><KpiCard label="待核款" value={kpis?.paymentVerify ?? null} hint="客人已回報匯款，等核對" href="/bookings?status=awaiting_confirmation" tone="warning" /></Grid>
        <Grid item xs={6} md={3}><KpiCard label="待客服" value={kpis?.handovers ?? null} hint={convStats ? `今日對話 ${convStats.conversations} 則・轉接 ${convStats.handovers} 次` : undefined} href="/service" tone="warning" /></Grid>
      </Grid>
      <Grid container spacing={1.5} sx={{ mb: 3 }}>
        <Grid item xs={6} md={3}><KpiCard label="待收尾款" value={kpis?.balanceDue ?? null} href="/bookings?status=awaiting_balance" tone="warning" /></Grid>
        <Grid item xs={6} md={3}><KpiCard label="押金處理" value={kpis?.depositReturn ?? null} hint="已退房，押金待核對／退還" href="/bookings?status=deposit_processing" /></Grid>
        <Grid item xs={6} md={3}><KpiCard label="待退款" value={kpis?.refund ?? null} href="/bookings?status=awaiting_refund" tone="danger" /></Grid>
        <Grid item xs={6} md={3}>
          <KpiCard
            label="候補／衝突"
            value={kpis ? kpis.waitlist + kpis.manualConflict + kpis.otaConflict : null}
            hint={kpis ? `候補 ${kpis.waitlist}・撞期 ${kpis.manualConflict}・OTA ${kpis.otaConflict}` : undefined}
            href="/bookings/conflicts"
            tone="danger"
          />
        </Grid>
      </Grid>

      <Grid container spacing={2} alignItems="stretch">
        {/* 今日待辦（§19.2）：Critical → Warning → Normal */}
        <Grid item xs={12} lg={7}>
          <Block title="今日待辦" action={<Link component={RouterLink} to="/bookings/tasks" variant="body2" underline="hover">全部待辦 →</Link>}>
            {tasks === null && <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={56} />)}</Stack>}
            {tasks !== null && tasks.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>沒有待處理事項，今天可以專心接待。</Typography>
            )}
            <Stack spacing={1}>
              {shownTasks.map((t) => (
                <Stack key={t.id} direction="row" spacing={1.5} alignItems="flex-start" sx={{ p: 1.25, borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                  <StatusBadge label={SEVERITY_LABEL[t.severity]} tone={SEVERITY_TONE[t.severity]} sx={{ mt: 0.25, flexShrink: 0 }} />
                  <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{t.title}</Typography>
                    <Typography variant="body2" color="text.secondary" noWrap>{t.detail}</Typography>
                    {t.meta && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{t.meta}</Typography>}
                  </Box>
                  <Button size="small" variant={t.severity === 'critical' ? 'contained' : 'outlined'} color={t.severity === 'critical' ? 'error' : 'inherit'} component={RouterLink} to={t.href} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {isMobile ? <ArrowRight size={16} /> : t.actionLabel}
                  </Button>
                </Stack>
              ))}
              {tasks && tasks.length > shownTasks.length && (
                <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center' }}>還有 {tasks.length - shownTasks.length} 項，到「待辦事項」查看全部</Typography>
              )}
            </Stack>
          </Block>
        </Grid>

        {/* 未來 7 日入住（§19.3）：簡潔 Timeline */}
        <Grid item xs={12} lg={5}>
          <Block title="未來 7 日入住" action={<Link component={RouterLink} to={`/bookings?view=upcoming`} variant="body2" underline="hover">查看訂單 →</Link>}>
            {upcoming === null && <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="text" height={28} />)}</Stack>}
            {upcoming !== null && upcoming.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>未來 7 天沒有已鎖房的入住。</Typography>
            )}
            <Stack spacing={1.5}>
              {Object.entries(groupedUpcoming).map(([d, list]) => (
                <Box key={d}>
                  <Typography variant="caption" sx={{ fontWeight: 600, color: d === today ? 'primary.main' : 'text.secondary' }}>{dayLabel(d)}{d !== today && d !== tomorrow ? '' : `・${formatShortDate(d)}`}</Typography>
                  <Stack spacing={0.5} sx={{ mt: 0.5, pl: 1.5, borderLeft: '2px solid', borderColor: d === today ? 'primary.main' : 'divider' }}>
                    {list.map((b) => (
                      <Stack key={b.id} direction="row" spacing={1} alignItems="center" component={RouterLink} to={`/bookings/${b.id}`} sx={{ textDecoration: 'none', color: 'inherit', '&:hover': { color: 'primary.main' } }}>
                        <Typography variant="body2" sx={{ minWidth: 0, flexGrow: 1 }} noWrap>
                          {b.name || b.nickname || '未取得'}{b.headcount ? ` ${b.headcount} 人` : ''}
                          <Typography component="span" variant="caption" color="text.secondary"> ・{b.whole_house ? '包棟' : b.room_type_label || bookingSourceLabel(b)}{b.nights ? `・${b.nights} 晚` : ''}</Typography>
                        </Typography>
                        <StatusBadge status={b.status} dot={false} />
                      </Stack>
                    ))}
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Block>
        </Grid>

        {/* 系統健康（§19.4、§145）：不佔主要版面，異常才醒目；只有管理員看得到（讀 settings） */}
        {canSeeHealth && (
          <Grid item xs={12}>
            <Paper variant="outlined" sx={{ p: 1.5, px: 2, borderColor: hasUnhealthy ? 'warning.main' : undefined }}>
              <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="subtitle2" sx={{ mr: 1 }}>系統健康</Typography>
                {health === null && <Skeleton width={320} height={24} />}
                {(health || []).map((h) => (
                  <Stack key={h.key} direction="row" spacing={0.75} alignItems="center" component={RouterLink} to={h.href} sx={{ textDecoration: 'none', color: 'inherit' }} title={h.detail}>
                    <Typography variant="body2" color="text.secondary">{h.label}</Typography>
                    <Chip size="small" label={HEALTH_LABEL[h.level]} sx={{
                      height: 20, fontSize: 12,
                      bgcolor: h.level === 'ok' ? 'success.light' : h.level === 'warning' ? 'warning.light' : h.level === 'error' ? 'error.light' : 'grey.100',
                      color: h.level === 'ok' ? 'success.dark' : h.level === 'warning' ? 'warning.dark' : h.level === 'error' ? 'error.dark' : 'text.secondary',
                    }} />
                    {h.level !== 'ok' && h.detail && !isMobile && <Typography variant="caption" color="text.secondary">{h.detail}</Typography>}
                  </Stack>
                ))}
              </Stack>
            </Paper>
          </Grid>
        )}
      </Grid>
    </Box>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Accordion, AccordionDetails, AccordionSummary, Avatar, Box, Button, FormControlLabel, Grid, IconButton, Link, Paper, Skeleton, Stack, Switch,
  Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ChevronDown, ChevronLeft, Copy, MessageSquare, RefreshCw, Trash2 } from 'lucide-react';
import { formatDate, formatDateRange, formatDateTime, formatMoney, formatRelative, formatTime } from '../../lib/format';
import { useBreakpoint } from '../../app/useBreakpoint';
import { usePermission } from '../../app/Can';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { SOURCE_LABEL } from '../service/serviceQueries';
import { CUSTOMER_STATUS_META, customerStatus, fetchCustomerDetail, type CustomerDetail } from './customerQueries';
import { purgeCustomerData, refreshLineProfile, setMarketingOptOut } from './customerActions';

// ========================================================================
// 客戶詳情（V2 §42）：基本資料／消費摘要／訂房紀錄／對話紀錄。訂單與付款狀態即時從 bookings 取。
// 手機：摘要在上、其餘摺疊。
// ========================================================================

function Section({ title, children, action, collapsible, defaultExpanded = true }: { title: string; children: ReactNode; action?: ReactNode; collapsible?: boolean; defaultExpanded?: boolean }) {
  if (collapsible) {
    return (
      <Accordion defaultExpanded={defaultExpanded} disableGutters variant="outlined" sx={{ '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ChevronDown size={18} />}><Typography variant="subtitle2">{title}</Typography></AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>{children}</AccordionDetails>
      </Accordion>
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
        <Typography variant="subtitle2">{title}</Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h6" sx={{ fontSize: 20 }}>{value}</Typography>
    </Box>
  );
}

export default function CustomerDetailPage() {
  const { id = '' } = useParams();
  const lineUserId = decodeURIComponent(id);
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const canEdit = usePermission('customer.edit');
  // 清除個資：權限模型裡只有主帳號拿得到 customer.personal_data.delete（後端 delete-customer-data 再驗一次）
  const canPurge = usePermission('customer.personal_data.delete');

  const [data, setData] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'notfound' | string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await fetchCustomerDetail(lineUserId);
      if (!d) setError('notfound'); else setData(d);
    } catch (e: any) { setError(e.message || '載入失敗'); } finally { setLoading(false); }
  }, [lineUserId]);
  useEffect(() => { load(); }, [load]);

  const refreshProfile = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const p = await refreshLineProfile(data.customer.line_user_id, data.customer.channel_id);
      enqueueSnackbar(p ? `已更新為「${p.displayName}」` : '目前仍抓不到暱稱（客人可能未加好友或已封鎖）', { variant: p ? 'success' : 'warning' });
      if (p) load();
    } catch (e: any) { enqueueSnackbar(`同步失敗：${e.message}`, { variant: 'error' }); } finally { setBusy(false); }
  };

  const toggleOptOut = async (optOut: boolean) => {
    if (!data) return;
    try {
      await setMarketingOptOut(data.customer.line_user_id, data.customer.channel_id, optOut);
      setData({ ...data, customer: { ...data.customer, marketing_opt_out: optOut } });
    } catch (e: any) { enqueueSnackbar(`更新失敗：${e.message}`, { variant: 'error' }); }
  };

  const purge = async () => {
    if (!data) return;
    const name = data.customer.nickname || data.customer.line_user_id;
    const ok = await confirm({
      title: '清除客戶資料',
      message: `會刪除「${name}」的聯絡人資料、對話紀錄與轉接紀錄；訂單會保留但失去與 LINE 帳號的關聯。此操作無法復原。`,
      confirmLabel: '清除',
      danger: true,
      requireTypedText: name,
    });
    if (!ok) return;
    try {
      await purgeCustomerData(data.customer.line_user_id);
      enqueueSnackbar('已清除客戶資料', { variant: 'success' });
      navigate('/customers', { replace: true });
    } catch (e: any) { enqueueSnackbar(`清除失敗：${e.message}`, { variant: 'error' }); }
  };

  if (error === 'notfound') return <ResultState status={404} description="找不到這位客戶，可能已被清除。" backTo="/customers" />;
  if (error) return <ResultState status={500} description={error} onRetry={load} backTo="/customers" />;
  if (loading || !data) {
    return <Stack spacing={2}><Skeleton variant="text" width={240} height={36} /><Skeleton variant="rounded" height={120} /><Skeleton variant="rounded" height={240} /></Stack>;
  }

  const c = data.customer;
  const meta = CUSTOMER_STATUS_META[customerStatus(c)];

  const summary = (
    <Grid container spacing={2}>
      <Grid item xs={6} sm={3}><Stat label="累積訂單" value={c.bookingCount} /></Grid>
      <Grid item xs={6} sm={3}><Stat label="成立訂單" value={c.paidCount} /></Grid>
      <Grid item xs={6} sm={3}><Stat label="累積消費" value={c.totalSpend ? formatMoney(c.totalSpend) : '—'} /></Grid>
      <Grid item xs={6} sm={3}><Stat label="最近入住" value={formatDate(c.lastCheckin) || '—'} /></Grid>
    </Grid>
  );

  const profile = (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{c.line_user_id}</Typography>
        <Tooltip title="複製 LINE ID"><IconButton size="small" onClick={() => navigator.clipboard.writeText(c.line_user_id)} aria-label="複製"><Copy size={14} /></IconButton></Tooltip>
      </Stack>
      <Typography variant="body2">第一次互動：{formatDateTime(c.first_message_at) || '—'}</Typography>
      <Typography variant="body2">最後互動：{formatDateTime(c.last_message_at) || '—'}{c.last_message_at ? `（${formatRelative(c.last_message_at)}）` : ''}</Typography>
      <Typography variant="body2">目前：{c.is_human_mode ? '真人服務中（AI 暫停）' : 'AI 服務中'}</Typography>
      <FormControlLabel
        control={<Switch checked={c.marketing_opt_out} onChange={(e) => toggleOptOut(e.target.checked)} disabled={!canEdit} />}
        label={<Typography variant="body2">拒收行銷訊息{c.marketing_opt_out ? '（客製訊息發送不會列出此人）' : ''}</Typography>}
      />
    </Stack>
  );

  const bookings = data.bookings.length === 0 ? <Typography variant="body2" color="text.secondary">還沒有訂單。</Typography> : (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small">
        <TableHead><TableRow><TableCell>訂單</TableCell><TableCell>入住 → 退房</TableCell><TableCell align="right">人數</TableCell><TableCell align="right">金額</TableCell><TableCell>狀態</TableCell></TableRow></TableHead>
        <TableBody>
          {data.bookings.map((b) => (
            <TableRow key={b.id} hover sx={{ cursor: 'pointer' }} onClick={() => navigate(`/bookings/${b.id}`)}>
              <TableCell><Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{b.order_number || '—'}</Typography></TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDateRange(b.checkin_date, b.checkout_date) || '—'}{b.nights ? `・${b.nights} 晚` : ''}</TableCell>
              <TableCell align="right">{b.headcount ?? '—'}</TableCell>
              <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{formatMoney(b.total_amount) || '—'}</TableCell>
              <TableCell><StatusBadge status={b.status} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );

  const conversations = data.conversations.length === 0 ? <Typography variant="body2" color="text.secondary">沒有對話紀錄（依保留天數設定自動清除）。</Typography> : (
    <Stack spacing={0.75}>
      {data.conversations.map((m) => (
        <Stack key={m.id} direction="row" spacing={1} alignItems="flex-start">
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, width: 96 }}>{formatTime(m.created_at)}・{m.direction === 'inbound' ? '客人' : SOURCE_LABEL[m.source] || m.source}</Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>{m.content}</Typography>
        </Stack>
      ))}
    </Stack>
  );

  const openChat = <Button size="small" variant="outlined" color="inherit" startIcon={<MessageSquare size={14} />} component={RouterLink} to={`/service?user=${encodeURIComponent(c.line_user_id)}`}>開啟對話</Button>;

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <IconButton component={RouterLink} to="/customers" size="small" aria-label="回客戶列表"><ChevronLeft size={20} /></IconButton>
        <Avatar src={c.avatar_url || undefined} sx={{ width: 44, height: 44 }}>{(c.nickname || '?').slice(0, 1)}</Avatar>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant={isMobile ? 'h6' : 'h5'} component="h1" noWrap>{c.nickname || '未取得暱稱'}</Typography>
            <StatusBadge label={meta.label} tone={meta.tone} />
          </Stack>
          <Typography variant="caption" color="text.secondary">LINE 聯絡人</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          {canEdit && <Button size="small" variant="outlined" color="inherit" startIcon={<RefreshCw size={14} />} onClick={refreshProfile} disabled={busy}>{isMobile ? '抓暱稱' : '重新抓取暱稱'}</Button>}
          {!isMobile && openChat}
          {canPurge && <Tooltip title="只有主帳號能清除客戶資料"><IconButton color="error" onClick={purge} aria-label="清除客戶資料"><Trash2 size={18} /></IconButton></Tooltip>}
        </Stack>
      </Stack>

      <Stack spacing={2}>
        <Section title="消費摘要">{summary}</Section>
        <Grid container spacing={2} alignItems="flex-start">
          <Grid item xs={12} md={4}>
            {isMobile ? <Section title="基本資料" collapsible defaultExpanded={false}>{profile}</Section> : <Section title="基本資料">{profile}</Section>}
          </Grid>
          <Grid item xs={12} md={8}>
            <Stack spacing={2}>
              {isMobile ? <Section title={`訂房紀錄（${data.bookings.length}）`} collapsible>{bookings}</Section> : <Section title={`訂房紀錄（${data.bookings.length}）`} action={<Link component={RouterLink} to={`/bookings?q=${encodeURIComponent(c.nickname || c.line_user_id)}`} variant="body2" underline="hover">在訂單列表查看 →</Link>}>{bookings}</Section>}
              {isMobile ? <Section title="最近對話" collapsible defaultExpanded={false}>{conversations}{openChat}</Section> : <Section title="最近對話（最新 20 則）" action={openChat}>{conversations}</Section>}
            </Stack>
          </Grid>
        </Grid>
      </Stack>
    </Box>
  );
}

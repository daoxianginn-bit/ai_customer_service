import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Avatar, Box, Button, Card, CardActionArea, CardContent, Chip, IconButton, MenuItem, Paper, Skeleton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { ChevronLeft, ChevronRight, RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatDate, formatMoney, formatRelative } from '../../lib/format';
import { channelRoleLabel } from '../../lib/lineChannels';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import DataTableMui, { type Column } from '../../components/ui-mui/DataTableMui';
import ResultState from '../../components/ui-mui/ResultState';
import {
  CUSTOMER_QUICK_VIEWS, CUSTOMER_STATUS_META, customerStatus, fetchChannelOptions, listCustomers,
  type CustomerFilters, type CustomerQuickView, type CustomerRow, type LineChannelOption,
} from './customerQueries';

// ========================================================================
// 客戶列表（V2 §41）：客戶／LINE／最近入住／累積訂單／累積消費／最後互動，手機轉卡片。
// 篩選在網址（?q=&view=&from=&to=&channel=&page=）；點一列進 /customers/:id。
// ========================================================================

const PAGE_SIZE = 20;
const VIEWS = new Set<string>(CUSTOMER_QUICK_VIEWS.map((v) => v.value));

export default function CustomerListPage() {
  const navigate = useNavigate();
  const { isMobile, isWide } = useBreakpoint();
  const [params, setParams] = useSearchParams();
  const [channels, setChannels] = useState<LineChannelOption[]>([]);

  const state = useMemo(() => ({
    keyword: params.get('q') || '',
    from: params.get('from') || '',
    to: params.get('to') || '',
    view: (VIEWS.has(params.get('view') || '') ? params.get('view') : 'all') as CustomerQuickView,
    channelId: params.get('channel') || '',
    page: Math.max(0, Number(params.get('page') || 0) || 0),
  }), [params]);

  const [draft, setDraft] = useState({ keyword: state.keyword, from: state.from, to: state.to });
  useEffect(() => { setDraft({ keyword: state.keyword, from: state.from, to: state.to }); }, [state.keyword, state.from, state.to]);

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => { fetchChannelOptions().then(setChannels); }, []);
  // 預設看客戶用帳號——客戶資料頁的主要使用情境
  const effectiveChannel = state.channelId || channels.find((c) => c.role === 'customer')?.id || channels[0]?.id || '';

  const apply = (patch: Partial<CustomerFilters & { page: number }>) => {
    const next = new URLSearchParams();
    const merged = { ...state, ...draft, ...patch };
    if (merged.keyword) next.set('q', merged.keyword);
    if (merged.from) next.set('from', merged.from);
    if (merged.to) next.set('to', merged.to);
    if (merged.view !== 'all') next.set('view', merged.view);
    if (patch.channelId ?? state.channelId) next.set('channel', patch.channelId ?? state.channelId);
    if ((patch.page ?? 0) > 0) next.set('page', String(patch.page));
    setParams(next);
  };

  const load = useCallback(async () => {
    if (!effectiveChannel) return;
    setLoading(true); setError('');
    try {
      const res = await listCustomers({ channelId: effectiveChannel, keyword: state.keyword, from: state.from, to: state.to, view: state.view }, state.page, PAGE_SIZE);
      setRows(res.rows); setHasMore(res.hasMore);
    } catch (e: any) { setError(e.message || '載入失敗'); } finally { setLoading(false); }
  }, [effectiveChannel, state]);
  useEffect(() => { load(); }, [load]);

  const columns = useMemo<Column<CustomerRow>[]>(() => {
    const cols: Column<CustomerRow>[] = [
      {
        key: 'customer', header: '客戶',
        render: (r) => (
          <Stack direction="row" spacing={1.25} alignItems="center">
            <Avatar src={r.avatar_url || undefined} sx={{ width: 32, height: 32, fontSize: 13 }}>{(r.nickname || '?').slice(0, 1)}</Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>{r.nickname || '未取得暱稱'}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }} noWrap>{r.line_user_id}</Typography>
            </Box>
          </Stack>
        ),
      },
      { key: 'status', header: '狀態', nowrap: true, render: (r) => { const m = CUSTOMER_STATUS_META[customerStatus(r)]; return <StatusBadge label={m.label} tone={m.tone} />; } },
      { key: 'lastCheckin', header: '最近入住', nowrap: true, render: (r) => formatDate(r.lastCheckin) || '—' },
      { key: 'bookingCount', header: '累積訂單', align: 'right', render: (r) => `${r.bookingCount}${r.paidCount && r.paidCount !== r.bookingCount ? `（成立 ${r.paidCount}）` : ''}` },
      { key: 'totalSpend', header: '累積消費（NT$）', align: 'right', nowrap: true, render: (r) => (r.totalSpend ? formatMoney(r.totalSpend, { withCurrency: false }) : '—') },
    ];
    if (isWide) cols.push({ key: 'marketing', header: '行銷', nowrap: true, render: (r) => (r.marketing_opt_out ? <StatusBadge label="拒收" tone="warning" dot={false} /> : <Typography variant="caption" color="text.secondary">可發送</Typography>) });
    cols.push({ key: 'last_message_at', header: '最後互動', nowrap: true, render: (r) => formatRelative(r.last_message_at) || '—' });
    return cols;
  }, [isWide]);

  return (
    <Box>
      <PageHeaderV2 secondary={<Tooltip title="重新整理"><IconButton onClick={load} aria-label="重新整理"><RefreshCw size={18} /></IconButton></Tooltip>} />

      <Stack direction="row" spacing={1} sx={{ overflowX: 'auto', pb: 1, mb: 1.5, '&::-webkit-scrollbar': { display: 'none' } }}>
        {CUSTOMER_QUICK_VIEWS.map((v) => (
          <Chip key={v.value} label={v.label} clickable color={state.view === v.value ? 'primary' : 'default'} variant={state.view === v.value ? 'filled' : 'outlined'}
            onClick={() => apply({ view: v.value, from: '', to: '', page: 0 })} sx={{ flexShrink: 0 }} />
        ))}
      </Stack>

      <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2 }, mb: 2 }}>
        <Stack component="form" direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} flexWrap="wrap" useFlexGap onSubmit={(e) => { e.preventDefault(); apply({ page: 0 }); }}>
          {channels.length > 1 && (
            <TextField select size="small" label="官方帳號" value={effectiveChannel} onChange={(e) => apply({ channelId: e.target.value, page: 0 })} sx={{ minWidth: { md: 200 } }}>
              {channels.map((c) => <MenuItem key={c.id} value={c.id}>{c.name}（{channelRoleLabel(c.role)}）</MenuItem>)}
            </TextField>
          )}
          <TextField size="small" label="關鍵字" placeholder="暱稱或 LINE ID" value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            InputProps={{ startAdornment: <Search size={16} style={{ marginRight: 6, opacity: 0.5 }} /> }} sx={{ minWidth: { md: 240 } }} />
          {!isMobile && (
            <>
              <TextField size="small" type="date" label="互動起" InputLabelProps={{ shrink: true }} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              <TextField size="small" type="date" label="互動迄" InputLabelProps={{ shrink: true }} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Stack direction="row" spacing={1}>
            <Button type="submit" variant="contained" disabled={loading}>查詢</Button>
            <Button color="inherit" startIcon={<RotateCcw size={14} />} onClick={() => { setDraft({ keyword: '', from: '', to: '' }); apply({ keyword: '', from: '', to: '', view: 'all', page: 0 }); }}>重設</Button>
          </Stack>
        </Stack>
      </Paper>

      {error ? <ResultState status={500} description={error} onRetry={load} backTo={false} /> : isMobile ? (
        <Stack spacing={1.25}>
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={84} />)}
          {!loading && rows.length === 0 && <ResultState status="empty" description="沒有符合條件的客戶" backTo={false} />}
          {!loading && rows.map((r) => {
            const m = CUSTOMER_STATUS_META[customerStatus(r)];
            return (
              <Card key={r.line_user_id} variant="outlined">
                <CardActionArea onClick={() => navigate(`/customers/${encodeURIComponent(r.line_user_id)}`)}>
                  <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <Avatar src={r.avatar_url || undefined} sx={{ width: 40, height: 40 }}>{(r.nickname || '?').slice(0, 1)}</Avatar>
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                          <Typography variant="subtitle2" noWrap>{r.nickname || '未取得暱稱'}</Typography>
                          <StatusBadge label={m.label} tone={m.tone} />
                        </Stack>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
                          訂單 {r.bookingCount}・消費 {r.totalSpend ? formatMoney(r.totalSpend) : '—'}・{formatRelative(r.last_message_at) || '未互動'}
                        </Typography>
                      </Box>
                    </Stack>
                  </CardContent>
                </CardActionArea>
              </Card>
            );
          })}
        </Stack>
      ) : (
        <DataTableMui<CustomerRow> columns={columns} rows={rows} rowKey={(r) => r.line_user_id} loading={loading} emptyMessage="沒有符合條件的客戶" onRowClick={(r) => navigate(`/customers/${encodeURIComponent(r.line_user_id)}`)} dense />
      )}

      {!error && (state.page > 0 || hasMore) && (
        <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={1} sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary">第 {state.page + 1} 頁・每頁 {PAGE_SIZE} 筆</Typography>
          <IconButton size="small" disabled={state.page === 0 || loading} onClick={() => apply({ page: state.page - 1 })} aria-label="上一頁"><ChevronLeft size={18} /></IconButton>
          <IconButton size="small" disabled={!hasMore || loading} onClick={() => apply({ page: state.page + 1 })} aria-label="下一頁"><ChevronRight size={18} /></IconButton>
        </Stack>
      )}
    </Box>
  );
}

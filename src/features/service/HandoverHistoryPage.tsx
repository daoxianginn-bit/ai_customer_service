import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Box, Button, Card, CardContent, Link, Stack, Typography } from '@mui/material';
import { RefreshCw } from 'lucide-react';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatDateTime, formatRelative } from '../../lib/format';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import DataTableMui, { type Column } from '../../components/ui-mui/DataTableMui';
import ResultState from '../../components/ui-mui/ResultState';
import { fetchHandoverHistory, type HandoverLog } from './serviceQueries';

// ========================================================================
// 轉接紀錄：客人什麼時候喊了找真人、誰處理、什麼時候結束。從舊「客服中心 → 轉接歷史」搬來。
// 處理中的一列點「開啟對話」直接跳到工作台那位客人。
// ========================================================================

const resolvedLabel = (v: string | null) => (v === 'timeout_auto' ? '自動逾時' : v || '—');

export default function HandoverHistoryPage() {
  const { isMobile } = useBreakpoint();
  const [rows, setRows] = useState<HandoverLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await fetchHandoverHistory()); } catch (e: any) { setError(e.message || '載入失敗'); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const columns: Column<HandoverLog>[] = [
    { key: 'nickname', header: '客人', render: (r) => <Link component={RouterLink} to={`/service?user=${encodeURIComponent(r.line_user_id)}`} underline="hover">{r.nickname || r.line_user_id}</Link> },
    { key: 'triggered_keyword', header: '觸發', render: (r) => r.triggered_keyword || '—' },
    { key: 'started_at', header: '開始', nowrap: true, render: (r) => formatDateTime(r.started_at) },
    { key: 'ended_at', header: '結束', nowrap: true, render: (r) => formatDateTime(r.ended_at) || '—' },
    { key: 'status', header: '狀態', render: (r) => <StatusBadge label={r.status === 'open' ? '處理中' : '已結束'} tone={r.status === 'open' ? 'warning' : 'neutral'} /> },
    { key: 'resolved_by', header: '處理人', render: (r) => resolvedLabel(r.resolved_by) },
  ];

  return (
    <Box>
      <PageHeaderV2 secondary={<Button color="inherit" startIcon={<RefreshCw size={16} />} onClick={load}>重新整理</Button>} />
      {error ? <ResultState status={500} description={error} onRetry={load} backTo={false} /> : isMobile ? (
        <Stack spacing={1}>
          {!loading && rows.length === 0 && <ResultState status="empty" description="還沒有轉接紀錄" backTo={false} />}
          {rows.map((r) => (
            <Card key={r.id} variant="outlined"><CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center">
                <Link component={RouterLink} to={`/service?user=${encodeURIComponent(r.line_user_id)}`} variant="subtitle2" underline="hover">{r.nickname || r.line_user_id}</Link>
                <StatusBadge label={r.status === 'open' ? '處理中' : '已結束'} tone={r.status === 'open' ? 'warning' : 'neutral'} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>觸發：{r.triggered_keyword || '—'}・{formatRelative(r.started_at)}</Typography>
              <Typography variant="caption" color="text.secondary">{formatDateTime(r.started_at)} → {formatDateTime(r.ended_at) || '進行中'}・{resolvedLabel(r.resolved_by)}</Typography>
            </CardContent></Card>
          ))}
        </Stack>
      ) : (
        <DataTableMui<HandoverLog> columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyMessage="還沒有轉接紀錄" dense />
      )}
    </Box>
  );
}

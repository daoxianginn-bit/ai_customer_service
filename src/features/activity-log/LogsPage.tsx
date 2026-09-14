import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Box, Button, Card, CardActionArea, CardContent, Chip, Dialog, DialogContent, DialogTitle, Divider, Drawer, IconButton, InputAdornment, MenuItem, Paper,
  Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { ArrowRight, ChevronLeft, ChevronRight, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { LOG_FEATURE_OPTIONS, LOG_FUNCTION_NAMES, formatLogValue } from '../../lib/operationLog';
import { formatDateTime } from '../../lib/format';
import { useBreakpoint } from '../../app/useBreakpoint';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';

// ========================================================================
// 紀錄頁（操作紀錄／錯誤紀錄／自動化執行紀錄共用，V2 §84）。
//
// 舊版把「異動前 → 異動後」整段塞進表格欄位，一列可以撐到半頁高，前後幾筆看不到；
// 這一版表格只放一行摘要（改了哪幾個欄位／錯誤第一行），完整內容點一列在右側抽屜看，
// 列高固定、掃過去就知道這一天發生什麼事。錯誤列只用左側細紅條標示，不整列刷紅。
// preset 鎖定的條件（錯誤頁 level=error、執行紀錄 feature=排程管理）不出現在篩選列。
// ========================================================================

const PAGE_SIZE = 30;

export interface LogRow {
  id: string;
  feature: string;
  action: string;
  target: string | null;
  actor_type: 'user' | 'system';
  actor_name: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  level: 'info' | 'error';
  status_code: number | null;
  error_message: string | null;
  created_at: string;
}

interface Filters { keyword: string; feature: string; actorType: string; level: string; startDate: string; endDate: string }

const ACTION_COLOR: Record<string, 'success' | 'info' | 'warning' | 'error' | 'default'> = {
  新增: 'success', 建立角色: 'success', 修改: 'info', 修改角色: 'info', 指派角色: 'info', 狀態變更: 'warning', 停用角色: 'warning', 刪除: 'error', 批次刪除: 'error', 刪除角色: 'error',
};

function ActionChip({ row }: { row: LogRow }) {
  const color = row.level === 'error' ? 'error' : ACTION_COLOR[row.action] || 'default';
  return <Chip label={row.action} size="small" color={color} variant={color === 'default' ? 'outlined' : 'filled'} sx={{ height: 22, fontSize: 12, fontWeight: 500 }} />;
}

const truncate = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

/** 表格用的一行摘要：錯誤給第一行訊息；異動給「改了哪些欄位」，只有一個欄位時直接顯示前後值 */
function summary(row: LogRow): ReactNode {
  if (row.level === 'error') {
    const first = (row.error_message || '（沒有錯誤訊息）').split('\n')[0];
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        {row.status_code != null && <Chip label={`HTTP ${row.status_code}`} size="small" variant="outlined" color="error" sx={{ height: 20, fontSize: 11, fontFamily: 'monospace' }} />}
        <Typography variant="body2" color="error.dark" noWrap sx={{ minWidth: 0 }}>{truncate(first, 90)}</Typography>
      </Stack>
    );
  }
  const keys = Array.from(new Set([...Object.keys(row.before || {}), ...Object.keys(row.after || {})]));
  if (keys.length === 0) return <Typography variant="body2" color="text.disabled">—</Typography>;
  if (keys.length === 1) {
    const k = keys[0];
    return (
      <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
        <Typography variant="body2" color="text.secondary" noWrap>{k}</Typography>
        <Typography variant="body2" color="text.disabled" noWrap sx={{ maxWidth: 140 }}>{truncate(formatLogValue(row.before?.[k]), 30)}</Typography>
        <ArrowRight size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
        <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>{truncate(formatLogValue(row.after?.[k]), 60)}</Typography>
      </Stack>
    );
  }
  return <Typography variant="body2" color="text.secondary" noWrap>{keys.length} 個欄位：{truncate(keys.join('、'), 70)}</Typography>;
}

/** 詳細視窗：異動前後並排，一行一個欄位 */
function ChangeTable({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
  if (keys.length === 0) return <Typography variant="body2" color="text.disabled">這筆紀錄沒有欄位異動內容。</Typography>;
  return (
    <Table size="small" sx={{ '& td, & th': { verticalAlign: 'top', px: 1 } }}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: '28%' }}>欄位</TableCell>
          <TableCell sx={{ width: '36%' }}>異動前</TableCell>
          <TableCell>異動後</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {keys.map((k) => (
          <TableRow key={k}>
            <TableCell><Typography variant="body2" color="text.secondary">{k}</Typography></TableCell>
            <TableCell><Typography variant="body2" color="text.disabled" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{formatLogValue(before?.[k])}</Typography></TableCell>
            <TableCell><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', bgcolor: 'success.light', color: 'success.dark', px: 0.75, py: 0.25, borderRadius: 0.5, display: 'inline-block' }}>{formatLogValue(after?.[k])}</Typography></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DetailBody({ row }: { row: LogRow }) {
  const meta: [string, ReactNode][] = [
    ['時間', formatDateTime(row.created_at)],
    ['功能', row.feature],
    ['對象', row.target || '—'],
    ['異動者', row.actor_type === 'system' ? '系統' : row.actor_name],
  ];
  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1} alignItems="center"><ActionChip row={row} />{row.level === 'error' && row.status_code != null && <Chip label={`HTTP ${row.status_code}`} size="small" variant="outlined" color="error" sx={{ height: 22, fontFamily: 'monospace' }} />}</Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
        {meta.map(([label, value]) => (
          <Box key={label}>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
            <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>{value}</Typography>
          </Box>
        ))}
      </Box>
      <Divider />
      {row.level === 'error' ? (
        <Box>
          <Typography variant="subtitle2" gutterBottom>錯誤訊息</Typography>
          <Box component="pre" sx={{ m: 0, p: 1.5, fontSize: 12, lineHeight: 1.6, bgcolor: 'error.light', color: 'error.dark', borderRadius: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '55vh', overflow: 'auto' }}>
            {row.error_message || '（沒有錯誤訊息）'}
          </Box>
        </Box>
      ) : (
        <Box>
          <Typography variant="subtitle2" gutterBottom>異動內容</Typography>
          <Paper variant="outlined" sx={{ overflow: 'auto', maxHeight: '55vh' }}><ChangeTable before={row.before} after={row.after} /></Paper>
        </Box>
      )}
    </Stack>
  );
}

export interface LogsPageProps {
  /** 鎖定條件：錯誤頁 level=error、執行紀錄 feature=排程管理 */
  preset?: { level?: 'error'; feature?: string };
  title?: string;
  description?: string;
}

export default function LogsPage({ preset, title, description }: LogsPageProps = {}) {
  const { isMobile, isDesktop } = useBreakpoint();
  const empty = useMemo<Filters>(() => ({ keyword: '', feature: preset?.feature || '', actorType: '', level: preset?.level || '', startDate: '', endDate: '' }), [preset?.feature, preset?.level]);
  const [draft, setDraft] = useState<Filters>(empty);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [detail, setDetail] = useState<LogRow | null>(null);
  // 手機：四個下拉全部攤開會把清單擠到第二屏，預設只留搜尋列，其餘收在「篩選」後面
  const [moreOpen, setMoreOpen] = useState(false);

  const runQuery = useCallback(async (pageIndex: number, f: Filters) => {
    setLoading(true); setError(null);
    let query = supabase.from('operation_logs').select('*').order('created_at', { ascending: false }).range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);
    if (f.feature) query = query.eq('feature', f.feature);
    if (f.actorType) query = query.eq('actor_type', f.actorType);
    if (f.level) query = query.eq('level', f.level);
    if (f.startDate) query = query.gte('created_at', `${f.startDate}T00:00:00`);
    // 迄日要含當天：選 8/23 是要「8/23 整天」，不是 8/23 00:00 那一瞬間
    if (f.endDate) query = query.lt('created_at', `${f.endDate}T23:59:59.999`);
    if (f.keyword.trim()) {
      const kw = f.keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`target.ilike.%${kw}%,actor_name.ilike.%${kw}%,action.ilike.%${kw}%,error_message.ilike.%${kw}%`);
    }
    const { data, error: qErr } = await query;
    if (qErr) setError(qErr.message);
    else { setRows((data || []) as LogRow[]); setHasMore((data || []).length === PAGE_SIZE); }
    setPage(pageIndex);
    setLoading(false);
  }, []);

  useEffect(() => { runQuery(0, empty); }, [runQuery, empty]);

  const search = () => runQuery(0, draft);
  const reset = () => { setDraft(empty); runQuery(0, empty); };
  const activeCount = (Object.keys(draft) as (keyof Filters)[]).filter((k) => draft[k] !== empty[k]).length;

  const showMore = !isMobile || moreOpen;
  const filters = (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2 }, mb: 2 }}>
      <Stack direction={isMobile ? 'column' : 'row'} spacing={1.5} flexWrap="wrap" useFlexGap alignItems={isMobile ? 'stretch' : 'center'}>
        <Stack direction="row" spacing={1} sx={{ minWidth: { md: 260 }, flex: { md: 1 } }}>
          <TextField
            size="small" placeholder="訂單編號、帳號或錯誤訊息" value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> }}
            sx={{ flex: 1 }}
          />
          {isMobile && <Button variant={moreOpen ? 'contained' : 'outlined'} color="inherit" onClick={() => setMoreOpen((v) => !v)} sx={{ flexShrink: 0, minWidth: 0, px: 1.5 }} aria-label="更多篩選"><SlidersHorizontal size={16} />{activeCount > 0 && <Box component="span" sx={{ ml: 0.5, fontSize: 12 }}>{activeCount}</Box>}</Button>}
        </Stack>
        {showMore && (<>
        {!preset?.level && (
          <TextField select size="small" label="類型" value={draft.level} onChange={(e) => setDraft({ ...draft, level: e.target.value })} sx={{ minWidth: 130 }}>
            <MenuItem value="">全部</MenuItem><MenuItem value="info">資料異動</MenuItem><MenuItem value="error">系統錯誤</MenuItem>
          </TextField>
        )}
        {!preset?.feature && (
          <TextField select size="small" label="功能" value={draft.feature} onChange={(e) => setDraft({ ...draft, feature: e.target.value })} sx={{ minWidth: 170 }}>
            <MenuItem value="">全部功能</MenuItem>
            {LOG_FEATURE_OPTIONS.map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
            <Divider />
            {LOG_FUNCTION_NAMES.map((f) => <MenuItem key={f} value={f} sx={{ fontFamily: 'monospace', fontSize: 13 }}>{f}</MenuItem>)}
          </TextField>
        )}
        <TextField select size="small" label="異動者" value={draft.actorType} onChange={(e) => setDraft({ ...draft, actorType: e.target.value })} sx={{ minWidth: 120 }}>
          <MenuItem value="">全部</MenuItem><MenuItem value="user">使用者</MenuItem><MenuItem value="system">系統</MenuItem>
        </TextField>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField type="date" size="small" label="從" InputLabelProps={{ shrink: true }} value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} sx={{ flex: 1 }} />
          <TextField type="date" size="small" label="到" InputLabelProps={{ shrink: true }} value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} sx={{ flex: 1 }} />
        </Stack>
        </>)}
        <Stack direction="row" spacing={1} sx={{ ml: { md: 'auto' } }}>
          {activeCount > 0 && <Button variant="text" color="inherit" startIcon={<RotateCcw size={14} />} onClick={reset}>清除</Button>}
          <Button variant="contained" onClick={search} disabled={loading} fullWidth={isMobile}>查詢</Button>
        </Stack>
      </Stack>
    </Paper>
  );

  const pager = (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 1, py: 1 }}>
      <Button size="small" color="inherit" startIcon={<ChevronLeft size={16} />} disabled={page === 0 || loading} onClick={() => runQuery(page - 1, draft)}>上一頁</Button>
      <Typography variant="body2" color="text.secondary">第 {page + 1} 頁{rows.length ? `・${rows.length} 筆` : ''}</Typography>
      <Button size="small" color="inherit" endIcon={<ChevronRight size={16} />} disabled={!hasMore || loading} onClick={() => runQuery(page + 1, draft)}>下一頁</Button>
    </Stack>
  );

  const emptyState = <ResultState status="empty" title="查無紀錄" description={activeCount ? '換個條件再查一次。' : '還沒有任何紀錄。'} backTo={false} />;

  const list = isMobile ? (
    <Stack spacing={1.5}>
      {loading && [0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={92} />)}
      {!loading && rows.length === 0 && emptyState}
      {!loading && rows.map((r) => (
        <Card key={r.id} variant="outlined" sx={{ borderLeft: r.level === 'error' ? '3px solid' : undefined, borderLeftColor: 'error.main' }}>
          <CardActionArea onClick={() => setDetail(r)}>
            <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                <Typography variant="subtitle2" noWrap>{r.feature}</Typography>
                <ActionChip row={r} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>{formatDateTime(r.created_at)}・{r.actor_type === 'system' ? '系統' : r.actor_name}{r.target ? `・${r.target}` : ''}</Typography>
              <Box sx={{ mt: 1, minWidth: 0 }}>{summary(r)}</Box>
            </CardContent>
          </CardActionArea>
        </Card>
      ))}
      {!loading && rows.length > 0 && pager}
    </Stack>
  ) : (
    <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ tableLayout: 'fixed', minWidth: 880, '& td': { py: 1.25 } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 150 }}>時間</TableCell>
              <TableCell sx={{ width: 220 }}>功能・動作</TableCell>
              <TableCell sx={{ width: 160 }}>對象</TableCell>
              <TableCell sx={{ width: 170 }}>異動者</TableCell>
              <TableCell>摘要<Typography component="span" variant="caption" color="text.disabled" sx={{ ml: 1 }}>點一列看完整內容</Typography></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && [0, 1, 2, 3, 4].map((i) => (
              <TableRow key={i}>{[0, 1, 2, 3, 4].map((c) => <TableCell key={c}><Skeleton /></TableCell>)}</TableRow>
            ))}
            {!loading && rows.length === 0 && <TableRow><TableCell colSpan={5} sx={{ border: 0, p: 0 }}>{emptyState}</TableCell></TableRow>}
            {!loading && rows.map((r) => (
              <TableRow
                key={r.id} hover onClick={() => setDetail(r)}
                sx={{ cursor: 'pointer', '& td:first-of-type': { borderLeft: '3px solid', borderLeftColor: r.level === 'error' ? 'error.main' : 'transparent' }, ...(detail?.id === r.id ? { bgcolor: 'action.selected' } : {}) }}
              >
                <TableCell><Typography variant="body2" color="text.secondary" noWrap>{formatDateTime(r.created_at)}</Typography></TableCell>
                <TableCell>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>{r.feature}</Typography>
                    <ActionChip row={r} />
                  </Stack>
                </TableCell>
                <TableCell><Typography variant="body2" noWrap sx={{ fontFamily: r.target ? 'monospace' : undefined, fontSize: 13 }} color={r.target ? 'text.primary' : 'text.disabled'}>{r.target || '—'}</Typography></TableCell>
                <TableCell>{r.actor_type === 'system' ? <Chip label="系統" size="small" variant="outlined" sx={{ height: 20, fontSize: 11 }} /> : <Typography variant="body2" noWrap>{r.actor_name}</Typography>}</TableCell>
                <TableCell sx={{ minWidth: 0 }}>{summary(r)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      <Divider />
      {pager}
    </Paper>
  );

  return (
    <Box>
      <PageHeaderV2 title={title} description={description} />
      {filters}
      {error ? <ResultState status={500} description={error} onRetry={() => runQuery(page, draft)} backTo={false} /> : list}

      {/* 桌機：右側抽屜，列表仍看得到、可以連續點好幾筆；手機：整頁對話框 */}
      {isDesktop ? (
        <Drawer anchor="right" open={!!detail} onClose={() => setDetail(null)} PaperProps={{ sx: { width: 520, maxWidth: '100vw' } }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Typography variant="h6">紀錄明細</Typography>
            <IconButton size="small" onClick={() => setDetail(null)} aria-label="關閉"><X size={18} /></IconButton>
          </Box>
          <Box sx={{ p: 2.5, overflow: 'auto' }}>{detail && <DetailBody row={detail} />}</Box>
        </Drawer>
      ) : (
        <Dialog open={!!detail} onClose={() => setDetail(null)} fullScreen={isMobile} fullWidth maxWidth="sm">
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>紀錄明細<IconButton size="small" onClick={() => setDetail(null)} aria-label="關閉"><X size={18} /></IconButton></DialogTitle>
          <DialogContent dividers>{detail && <DetailBody row={detail} />}</DialogContent>
        </Dialog>
      )}
    </Box>
  );
}

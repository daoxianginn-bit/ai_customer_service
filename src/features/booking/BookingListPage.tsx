import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Button, Card, CardActionArea, CardContent, Chip, Drawer, IconButton, MenuItem, Paper, Skeleton, Stack,
  TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ChevronLeft, ChevronRight, ListFilter, Pencil, Plus, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import {
  BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUSES, FLOW_STEP_STATUSES, MANUAL_ACTION_FLOW_STATUSES, MANUAL_ACTION_STATUSES,
  bookingStatusLabel, nextFlowStatus,
} from '../../lib/bookingStatus';
import { formatDateRange, formatMoney } from '../../lib/format';
import { useBreakpoint } from '../../app/useBreakpoint';
import { Can, usePermission } from '../../app/Can';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import DataTableMui, { type Column } from '../../components/ui-mui/DataTableMui';
import BatchActionBar from '../../components/ui-mui/BatchActionBar';
import ResultState from '../../components/ui-mui/ResultState';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import {
  BOOKING_PAGE_SIZE, EMPTY_FILTERS, QUICK_VIEW_OPTIONS, bookingBalance, bookingSourceLabel, fetchBooking, fetchRooms,
  fetchStatusCounts, listBookings, type BookingFilters, type BookingQuickView, type BookingRow,
} from './bookingQueries';
import { deleteBooking, deleteBookings } from './bookingActions';
import BookingEditDialog from './BookingEditDialog';
import AdvanceStatusDialog from './AdvanceStatusDialog';

// ========================================================================
// 訂單列表（V2 §20–21、§101、§143）。
//
// 篩選條件全部放在網址（?view=manual&q=王&status=reserved&page=2），重新整理、分享連結、
// 從詳情頁按上一頁都會回到同一個檢視。狀態只用 Badge 呈現，整列不上色（§21）。
// 手機：表格轉卡片、篩選收進底部抽屜、主要操作固定右下。
//
// 資料查詢在 bookingQueries.ts、寫入在 bookingActions.ts，這個檔案只組畫面。
// ========================================================================

// 訂單清單自動刷新的間隔。LINE 自動成立的訂單會在客服沒有操作的情況下出現，
// 固定重新查詢才不會讓畫面停在半分鐘前的狀態。
const AUTO_REFRESH_MS = 30000;

const FILTER_STATUS_OPTIONS = [{ value: '', label: '全部狀態（不含已取消）' }, ...BOOKING_STATUS_OPTIONS, ...SYSTEM_ONLY_STATUSES];

const QUICK_VIEWS = new Set<string>(QUICK_VIEW_OPTIONS.map((o) => o.value));

function readFilters(params: URLSearchParams): BookingFilters & { page: number } {
  const view = params.get('view') || 'all';
  return {
    keyword: params.get('q') || '',
    startDate: params.get('from') || '',
    endDate: params.get('to') || '',
    status: params.get('status') || '',
    roomType: params.get('room') || '',
    view: (QUICK_VIEWS.has(view) ? view : 'all') as BookingQuickView,
    page: Math.max(0, Number(params.get('page') || 0) || 0),
  };
}

function writeFilters(f: BookingFilters, page: number, keep: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams();
  if (f.view !== 'all') next.set('view', f.view);
  if (f.keyword) next.set('q', f.keyword);
  if (f.startDate) next.set('from', f.startDate);
  if (f.endDate) next.set('to', f.endDate);
  if (f.status) next.set('status', f.status);
  if (f.roomType) next.set('room', f.roomType);
  if (page > 0) next.set('page', String(page));
  // 對話框深連結（?edit= / ?new=）不屬於篩選，原樣保留
  for (const k of ['edit', 'new']) if (keep.get(k)) next.set(k, keep.get(k)!);
  return next;
}

export default function BookingListPage() {
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile, isWide } = useBreakpoint();
  const canDelete = usePermission('booking.delete');
  const canEdit = usePermission('booking.edit');
  const canAdvance = usePermission('booking.payment.verify');

  const [params, setParams] = useSearchParams();
  const urlState = useMemo(() => readFilters(params), [params]);
  // 篩選輸入框是「草稿」，按查詢才寫進網址並重新查；跟網址上生效中的條件分開存，
  // 否則每打一個字就重查一次資料庫。
  const [draft, setDraft] = useState<BookingFilters>(() => {
    const { page: _p, ...f } = readFilters(params);
    return f;
  });
  useEffect(() => {
    const { page: _p, ...f } = urlState;
    setDraft(f);
  }, [urlState]);

  const [rows, setRows] = useState<BookingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [roomOptions, setRoomOptions] = useState<string[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  const [editing, setEditing] = useState<{ open: boolean; booking: BookingRow | null }>({ open: false, booking: null });
  const [advanceTarget, setAdvanceTarget] = useState<{ order: BookingRow; nextStatus: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const applyFilters = (f: BookingFilters, page = 0) => setParams(writeFilters(f, page, params));

  // opts.silent：每 30 秒自動刷新用。背景刷新不能表現得像使用者自己按了「查詢」——
  // 不顯示「載入中」、不清掉批次勾選。
  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = !!opts?.silent;
    if (!silent) { setLoading(true); setLoadError(''); }
    try {
      const { page, ...f } = urlState;
      const [list, counts] = await Promise.all([listBookings(page, f), fetchStatusCounts()]);
      setRows(list.rows);
      setHasMore(list.hasMore);
      setStatusCounts(counts);
      if (!silent) setSelectedIds([]);
    } catch (err: any) {
      if (!silent) setLoadError(err.message || '載入失敗');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [urlState]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetchRooms().then((r) => setRoomOptions(r.map((x) => x.name))); }, []);

  // 用 ref 存「當下這一版的刷新動作」，setInterval 只負責固定時間呼叫它（避免依賴變動重設計時器）。
  const autoRefreshRef = useRef<() => void>(() => {});
  autoRefreshRef.current = () => {
    // 編輯視窗開著時不動：使用者正在改這張單，背景把底下的資料換掉只會造成混淆。
    if (editing.open || advanceTarget) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    load({ silent: true });
  };
  useEffect(() => {
    const timer = setInterval(() => autoRefreshRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // 深連結：?new=1 開新增；?edit=<id> 開編輯（工作台、詳情頁都用這個進來）
  useEffect(() => {
    const editId = params.get('edit');
    if (params.get('new')) {
      setEditing({ open: true, booking: null });
    } else if (editId) {
      const local = rows.find((r) => r.id === editId);
      if (local) setEditing({ open: true, booking: local });
      else fetchBooking(editId).then((b) => { if (b) setEditing({ open: true, booking: b }); });
    }
    // rows 不列進依賴：只在網址參數變動時開，列表背景刷新不該重複開視窗
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('edit'), params.get('new')]);

  const closeDialog = () => {
    setEditing((e) => ({ ...e, open: false }));
    if (params.get('edit') || params.get('new')) {
      const next = new URLSearchParams(params);
      next.delete('edit');
      next.delete('new');
      setParams(next, { replace: true });
    }
  };

  const openNew = () => setEditing({ open: true, booking: null });
  const openEdit = (row: BookingRow) => setEditing({ open: true, booking: row });

  const onSaved = () => {
    closeDialog();
    enqueueSnackbar('訂單已儲存', { variant: 'success' });
    load({ silent: true });
  };

  const onAdvanced = () => {
    setAdvanceTarget(null);
    enqueueSnackbar('狀態已更新', { variant: 'success' });
    load({ silent: true });
  };

  const removeOne = async (row: BookingRow) => {
    const ok = await confirm({
      title: '刪除訂單',
      message: `確定要刪除訂單「${row.order_number || row.name || ''}」嗎？此操作無法復原，會連同房間與布巾用量一起刪除。`,
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;
    setBusyId(row.id);
    try {
      await deleteBooking(row);
      enqueueSnackbar('訂單已刪除', { variant: 'success' });
      load({ silent: true });
    } catch (err: any) {
      enqueueSnackbar(`刪除失敗：${err.message}`, { variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  const removeSelected = async () => {
    const targets = rows.filter((r) => selectedIds.includes(r.id));
    if (!targets.length) return;
    const ok = await confirm({
      title: `批次刪除 ${targets.length} 筆訂單`,
      message: `將刪除：${targets.map((r) => r.order_number || r.name || r.id).join('、')}。此操作無法復原。`,
      confirmLabel: '全部刪除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteBookings(targets);
      enqueueSnackbar(`已刪除 ${targets.length} 筆`, { variant: 'success' });
      setSelectedIds([]);
      load({ silent: true });
    } catch (err: any) {
      enqueueSnackbar(`批次刪除失敗：${err.message}`, { variant: 'error' });
    }
  };

  // 快速檢視的即時筆數。「即將入住」要看日期，statusCounts 算不出來，不顯示數字。
  const quickCount = (view: BookingQuickView): number | null => {
    const sum = (list: string[]) => list.reduce((s, k) => s + (statusCounts[k] || 0), 0);
    switch (view) {
      case 'manual': return sum(MANUAL_ACTION_STATUSES);
      case 'staying': return statusCounts.checked_in || 0;
      case 'completed': return statusCounts.completed || 0;
      case 'cancelled': return sum(['cancelled', 'awaiting_refund', 'refunded']);
      case 'ota': return statusCounts.external_synced || 0;
      default: return null;
    }
  };

  const selectView = (view: BookingQuickView) => applyFilters({ ...draft, view, status: '' });
  const selectStatus = (status: string) => applyFilters({ ...draft, view: 'all', status: draft.status === status ? '' : status });

  const columns = useMemo<Column<BookingRow>[]>(() => {
    const cols: Column<BookingRow>[] = [
      { key: 'order_number', header: '訂單編號', nowrap: true, render: (r) => <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{r.order_number || '—'}</Typography> },
      {
        key: 'customer', header: '客戶',
        render: (r) => (
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>{r.name || r.nickname || '未取得'}</Typography>
            {r.name && r.nickname && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{r.nickname}</Typography>}
          </Box>
        ),
      },
      {
        key: 'dates', header: '入住 → 退房', nowrap: true,
        render: (r) => (
          <Box>
            <Typography variant="body2">{formatDateRange(r.checkin_date, r.checkout_date) || '—'}</Typography>
            {r.nights ? <Typography variant="caption" color="text.secondary">{r.nights} 晚</Typography> : null}
          </Box>
        ),
      },
    ];
    // 人數、房型、來源只在 ≥1440 顯示：1024–1439 加上側欄放不下 11 欄，寧可少三欄也不要橫向捲動
    if (isWide) {
      cols.push(
        { key: 'headcount', header: '人數', align: 'right', render: (r) => (r.headcount != null ? `${r.headcount}` : '—') },
        { key: 'room_type_label', header: '房型', render: (r) => <Typography variant="body2" noWrap sx={{ maxWidth: 180 }}>{r.whole_house ? '包棟' : r.room_type_label || '—'}</Typography> },
        { key: 'source', header: '來源', nowrap: true, render: (r) => <Typography variant="body2" color="text.secondary">{bookingSourceLabel(r)}</Typography> },
      );
    }
    cols.push(
      { key: 'total_amount', header: '金額（NT$）', align: 'right', nowrap: true, render: (r) => formatMoney(r.total_amount, { withCurrency: false }) || '—' },
      {
        key: 'deposit', header: '付款', nowrap: true,
        render: (r) => {
          const bal = bookingBalance(r);
          return (
            <Box>
              <Typography variant="body2">訂金 {formatMoney(r.deposit, { withCurrency: false }) || '—'}</Typography>
              {bal != null && <Typography variant="caption" color="text.secondary">尾款 {formatMoney(bal, { withCurrency: false })}</Typography>}
            </Box>
          );
        },
      },
      { key: 'status', header: '狀態', nowrap: true, render: (r) => <StatusBadge status={r.status} /> },
    );
    return cols;
  }, [isWide]);

  const rowActions = (r: BookingRow) => {
    const next = nextFlowStatus(r.status);
    return (
      <>
        {canAdvance && next && (
          <Button size="small" variant="text" onClick={() => setAdvanceTarget({ order: r, nextStatus: next })} sx={{ whiteSpace: 'nowrap' }}>
            → {bookingStatusLabel(next)}
          </Button>
        )}
        {canEdit && (
          <Tooltip title="編輯"><IconButton size="small" onClick={() => openEdit(r)}><Pencil size={16} /></IconButton></Tooltip>
        )}
        {canDelete && (
          <Tooltip title="刪除"><span><IconButton size="small" color="error" disabled={busyId === r.id} onClick={() => removeOne(r)}><Trash2 size={16} /></IconButton></span></Tooltip>
        )}
      </>
    );
  };

  const filterFields = (
    <>
      <TextField
        size="small" label="關鍵字" placeholder="姓名／暱稱／電話／訂單編號"
        value={draft.keyword} onChange={(e) => setDraft({ ...draft, keyword: e.target.value })}
        InputProps={{ startAdornment: <Search size={16} style={{ marginRight: 6, opacity: 0.5 }} /> }}
        sx={{ minWidth: { md: 240 } }} fullWidth={isMobile}
      />
      <TextField size="small" type="date" label="入住起" InputLabelProps={{ shrink: true }} value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} fullWidth={isMobile} />
      <TextField size="small" type="date" label="入住迄" InputLabelProps={{ shrink: true }} value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} fullWidth={isMobile} />
      <TextField select size="small" label="狀態" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value, view: 'all' })} sx={{ minWidth: { md: 180 } }} fullWidth={isMobile}>
        {FILTER_STATUS_OPTIONS.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
      </TextField>
      <TextField select size="small" label="房型" value={draft.roomType} onChange={(e) => setDraft({ ...draft, roomType: e.target.value })} sx={{ minWidth: { md: 150 } }} fullWidth={isMobile}>
        <MenuItem value="">全部房型</MenuItem>
        <MenuItem value="包棟">包棟</MenuItem>
        {roomOptions.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
      </TextField>
    </>
  );

  const submitFilters = () => { applyFilters(draft); setFilterOpen(false); };
  const resetFilters = () => { applyFilters(EMPTY_FILTERS); setFilterOpen(false); };
  const activeFilterCount = [urlState.keyword, urlState.startDate, urlState.endDate, urlState.status, urlState.roomType].filter(Boolean).length;

  return (
    <Box>
      <PageHeaderV2
        action={
          <Can permission="booking.create">
            {isMobile ? null : <Button variant="contained" startIcon={<Plus size={16} />} onClick={openNew}>新增訂單</Button>}
          </Can>
        }
        secondary={
          <Tooltip title="重新整理"><IconButton onClick={() => load()} aria-label="重新整理"><RefreshCw size={18} /></IconButton></Tooltip>
        }
      />

      {/* 快速檢視（§20）：一列 Chip，手機可橫向捲動 */}
      <Stack direction="row" spacing={1} sx={{ overflowX: 'auto', pb: 1, mb: 1.5, '&::-webkit-scrollbar': { display: 'none' } }}>
        {QUICK_VIEW_OPTIONS.map((o) => {
          const count = quickCount(o.value);
          const active = urlState.view === o.value && !urlState.status;
          return (
            <Tooltip key={o.value} title={o.hint}>
              <Chip
                label={count != null && count > 0 ? `${o.label} ${count}` : o.label}
                clickable
                color={active ? 'primary' : 'default'}
                variant={active ? 'filled' : 'outlined'}
                onClick={() => selectView(o.value)}
              />
            </Tooltip>
          );
        })}
      </Stack>

      {/* 篩選列：桌面常駐；手機收成一顆「篩選」按鈕，點開底部抽屜（§17 Mobile） */}
      {isMobile ? (
        <Stack direction="row" spacing={1} sx={{ mb: 1.5 }}>
          <Button variant="outlined" color="inherit" startIcon={<ListFilter size={16} />} onClick={() => setFilterOpen(true)} fullWidth>
            篩選{activeFilterCount > 0 ? `（${activeFilterCount}）` : ''}
          </Button>
          {activeFilterCount > 0 && <Button color="inherit" onClick={resetFilters}>清除</Button>}
        </Stack>
      ) : (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack component="form" direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center" onSubmit={(e) => { e.preventDefault(); submitFilters(); }}>
            {filterFields}
            <Box sx={{ flexGrow: 1 }} />
            <Button type="submit" variant="contained" disabled={loading}>查詢</Button>
            <Button color="inherit" startIcon={<RotateCcw size={14} />} onClick={resetFilters}>重設</Button>
          </Stack>
          {/* 流程 1~9 的即時筆數：點一關就只看那一關，再點一次清掉 */}
          <Stack direction="row" spacing={0.75} sx={{ mt: 1.5, overflowX: 'auto', '&::-webkit-scrollbar': { display: 'none' } }} alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, mr: 0.5 }}>依狀態</Typography>
            {FLOW_STEP_STATUSES.map((s, i) => (
              <Chip
                key={s} size="small" clickable
                label={`${i + 1} ${bookingStatusLabel(s)}${statusCounts[s] ? ` ${statusCounts[s]}` : ''}`}
                color={urlState.status === s ? 'primary' : 'default'}
                variant={urlState.status === s ? 'filled' : 'outlined'}
                onClick={() => selectStatus(s)}
                sx={{ flexShrink: 0, ...(MANUAL_ACTION_FLOW_STATUSES.includes(s) && urlState.status !== s ? { borderColor: 'warning.main' } : {}) }}
              />
            ))}
            {['pending_manual_conflict', 'awaiting_refund', 'refunded'].map((s) => (
              <Chip
                key={s} size="small" clickable
                label={`${bookingStatusLabel(s)}${statusCounts[s] ? ` ${statusCounts[s]}` : ''}`}
                color={urlState.status === s ? 'primary' : 'default'}
                variant={urlState.status === s ? 'filled' : 'outlined'}
                onClick={() => selectStatus(s)}
                sx={{ flexShrink: 0 }}
              />
            ))}
          </Stack>
        </Paper>
      )}

      <Drawer anchor="bottom" open={filterOpen} onClose={() => setFilterOpen(false)} PaperProps={{ sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, p: 2, maxHeight: '85vh' } }}>
        <Typography variant="h6" sx={{ mb: 2 }}>篩選條件</Typography>
        <Stack spacing={1.5} component="form" onSubmit={(e) => { e.preventDefault(); submitFilters(); }}>
          {filterFields}
          <Stack direction="row" spacing={1} sx={{ pt: 1 }}>
            <Button color="inherit" onClick={resetFilters} fullWidth>重設</Button>
            <Button type="submit" variant="contained" fullWidth>套用</Button>
          </Stack>
        </Stack>
      </Drawer>

      {canDelete && (
        <Box sx={{ mb: 1.5 }}>
          <BatchActionBar selectedCount={selectedIds.length} pageCount={rows.length} onClear={() => setSelectedIds([])}>
            <Button size="small" color="error" variant="contained" startIcon={<Trash2 size={14} />} onClick={removeSelected}>批次刪除</Button>
          </BatchActionBar>
        </Box>
      )}

      {loadError ? (
        <ResultState status={500} description={loadError} onRetry={() => load()} backTo={false} />
      ) : isMobile ? (
        <Stack spacing={1.25}>
          {loading && [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={96} />)}
          {!loading && rows.length === 0 && <ResultState status="empty" description="沒有符合條件的訂單" backTo={false} />}
          {!loading && rows.map((r) => {
            const bal = bookingBalance(r);
            return (
              <Card key={r.id} variant="outlined">
                <CardActionArea onClick={() => navigate(`/bookings/${r.id}`)}>
                  <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                      <Box sx={{ minWidth: 0 }}>
                        <Typography variant="subtitle2" noWrap>{r.name || r.nickname || '未取得'}</Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{r.order_number || '—'}</Typography>
                      </Box>
                      <StatusBadge status={r.status} />
                    </Stack>
                    <Stack direction="row" justifyContent="space-between" sx={{ mt: 1 }}>
                      <Typography variant="body2">{formatDateRange(r.checkin_date, r.checkout_date) || '—'}{r.nights ? `・${r.nights} 晚` : ''}</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{formatMoney(r.total_amount) || '—'}</Typography>
                    </Stack>
                    <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.25 }}>
                      <Typography variant="caption" color="text.secondary">{r.whole_house ? '包棟' : r.room_type_label || '—'}・{bookingSourceLabel(r)}</Typography>
                      {bal != null && <Typography variant="caption" color="text.secondary">尾款 {formatMoney(bal)}</Typography>}
                    </Stack>
                  </CardContent>
                </CardActionArea>
              </Card>
            );
          })}
        </Stack>
      ) : (
        <DataTableMui<BookingRow>
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          emptyMessage="沒有符合條件的訂單"
          selected={canDelete ? selectedIds : undefined}
          onSelectedChange={canDelete ? setSelectedIds : undefined}
          rowActions={canEdit || canDelete ? rowActions : undefined}
          onRowClick={(r) => navigate(`/bookings/${r.id}`)}
          dense
        />
      )}

      {/* 分頁：沒有總筆數（不另外 count 一次），只做上一頁／下一頁 */}
      {!loadError && (urlState.page > 0 || hasMore) && (
        <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={1} sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary">第 {urlState.page + 1} 頁・每頁 {BOOKING_PAGE_SIZE} 筆</Typography>
          <IconButton size="small" disabled={urlState.page === 0 || loading} onClick={() => applyFilters(draft, urlState.page - 1)} aria-label="上一頁"><ChevronLeft size={18} /></IconButton>
          <IconButton size="small" disabled={!hasMore || loading} onClick={() => applyFilters(draft, urlState.page + 1)} aria-label="下一頁"><ChevronRight size={18} /></IconButton>
        </Stack>
      )}

      {/* 手機：主要操作固定右下（§15 Mobile） */}
      {isMobile && (
        <Can permission="booking.create">
          <Box sx={{ position: 'fixed', right: 16, bottom: 16, zIndex: (t) => t.zIndex.speedDial }}>
            <Button variant="contained" startIcon={<Plus size={16} />} onClick={openNew} sx={{ boxShadow: 3, borderRadius: 999, px: 2.5 }}>新增訂單</Button>
          </Box>
        </Can>
      )}

      <BookingEditDialog open={editing.open} booking={editing.booking} onClose={closeDialog} onSaved={onSaved} />
      <AdvanceStatusDialog target={advanceTarget} onClose={() => setAdvanceTarget(null)} onDone={onAdvanced} />
    </Box>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card, CardContent, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Skeleton, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { CheckCircle2, ChevronDown, RefreshCw, Send, Settings2, Shirt } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { usePermissions } from '../../app/PermissionContext';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatDateRange, formatDateTime, formatMoney, formatRelative, todayIso } from '../../lib/format';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import type { BookingRow } from '../booking/bookingQueries';
import {
  STAGES, fetchQueues, fetchStageTemplates, fetchTemplates, resendLaundry, saveStageTemplates, sortQueue, stageForStatus,
  type MessageTemplate, type QueueData, type StageAction, type StageDef, type StageGroup, type StageKey,
} from './processQueries';
import StagePanel from './StagePanel';
import NotifyDialog from './NotifyDialog';

// ========================================================================
// 訂單處理（訂房營運的第一個頁籤）：輪到人動手的訂單關卡。
// 「款項處理」列出 待確認／待收尾款／押金處理／待退款，「入住處理」列出 待入住／入住中；
// 每列最前面是那一關的高亮動作鈕（顏色依關卡），確認後同一列出現「訊息發送」。
// 清單即時更新：自己的操作先在本機更新，再訂閱 Supabase Realtime（別人改的也會進來），
// 沒有 Realtime 的環境退回每 30 秒背景重抓。跟「待辦事項」並存：那一頁是總覽，這一頁是動手。
// ========================================================================

const POLL_MS = 30_000;

function StageButton({ stage, onClick, size = 'small', fullWidth }: { stage: StageDef; onClick: () => void; size?: 'small' | 'medium'; fullWidth?: boolean }) {
  return (
    <Button variant="contained" size={size} fullWidth={fullWidth} onClick={(e) => { e.stopPropagation(); onClick(); }}
      sx={{ bgcolor: stage.color, color: '#fff', whiteSpace: 'nowrap', boxShadow: 'none', '&:hover': { bgcolor: stage.color, filter: 'brightness(.9)', boxShadow: 'none' }, fontWeight: 600, px: 1.5 }}>
      {stage.action}
    </Button>
  );
}

function ProgressMarks({ action }: { action?: StageAction }) {
  if (!action?.confirmed_at) return <Typography variant="caption" color="text.disabled">尚未確認</Typography>;
  return (
    <Stack spacing={0.25}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'success.main' }}><CheckCircle2 size={14} /><Typography variant="caption">已確認 {formatRelative(action.confirmed_at)}</Typography></Stack>
      {action.notified_at
        ? <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'success.main' }}><Send size={13} /><Typography variant="caption">已通知 {formatRelative(action.notified_at)}</Typography></Stack>
        : <Typography variant="caption" color="warning.main">尚未通知客人</Typography>}
    </Stack>
  );
}

function TemplateSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([fetchTemplates(), fetchStageTemplates()]).then(([t, m]) => {
      setTemplates(t);
      // 沒設定的關卡先帶同名範本，讓管理員看得到「目前實際會用哪一個」
      const filled: Record<string, string> = { ...m };
      for (const s of STAGES) if (!filled[s.key]) { const d = t.find((x) => x.title === s.templateTitle); if (d) filled[s.key] = d.id; }
      setMap(filled);
    }).finally(() => setLoading(false));
  }, [open]);
  const save = async () => {
    setSaving(true);
    try { await saveStageTemplates(map); enqueueSnackbar('預設範本已儲存', { variant: 'success' }); onClose(); }
    catch (e: any) { enqueueSnackbar(e.message || '儲存失敗', { variant: 'error' }); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>各關卡預設通知範本</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>按「訊息發送」時預設帶入的範本；發送前仍可換別的範本或臨時改內容。範本本身到「客戶與行銷 → 訊息發送」維護。</Typography>
        {loading ? <Skeleton variant="rounded" height={240} /> : (
          <Stack spacing={2}>
            {STAGES.map((s) => (
              <TextField key={s.key} select size="small" label={`${s.title}（${s.action}）`} value={map[s.key] || ''} onChange={(e) => setMap({ ...map, [s.key]: e.target.value })} fullWidth>
                <MenuItem value="">（不預設）</MenuItem>
                {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.title}</MenuItem>)}
              </TextField>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>取消</Button><Button variant="contained" onClick={save} disabled={saving || loading}>{saving ? '儲存中…' : '儲存'}</Button></DialogActions>
    </Dialog>
  );
}

export default function ProcessPage() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const { hasPermission } = usePermissions();
  const canNotify = hasPermission('booking.notify');
  const canLaundry = hasPermission('housekeeping.manage');
  const canSettings = hasPermission('booking.edit');

  const [data, setData] = useState<QueueData>({ bookings: [], actions: [], recent: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Record<StageGroup, StageKey | 'all'>>({ payment: 'all', checkin: 'all' });
  const [panel, setPanel] = useState<{ booking: BookingRow; stage: StageDef } | null>(null);
  const [notify, setNotify] = useState<{ booking: BookingRow; stage: StageDef } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resending, setResending] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { setData(await fetchQueues()); setError(null); } catch (e: any) { if (!silent) setError(e.message || '讀取失敗'); } finally { if (!silent) setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // 即時更新：Realtime 有開就吃它的事件；沒開（或斷線）靠 30 秒背景重抓兜底
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => load(true), 800); };
    const channel = supabase.channel('booking-process').on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, schedule).subscribe();
    const poll = window.setInterval(() => { if (document.visibilityState === 'visible') load(true); }, POLL_MS);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); supabase.removeChannel(channel); };
  }, [load]);

  const actionFor = (bookingId: string, stage: StageKey) => data.actions.find((a) => a.booking_id === bookingId && a.stage === stage);

  // 自己的操作立刻反映在清單上（不用等重抓）：狀態變了就從原佇列移走／移到新佇列
  const applyLocal = (updated: BookingRow) => {
    setData((prev) => {
      const still = STAGES.some((s) => s.statuses.includes(updated.status));
      const bookings = prev.bookings.filter((b) => b.id !== updated.id);
      return { ...prev, bookings: still ? [...bookings, updated] : bookings };
    });
    load(true);
  };

  const rowsFor = (group: StageGroup) => {
    const stages = STAGES.filter((s) => s.group === group && (filter[group] === 'all' || s.key === filter[group]));
    return stages.flatMap((s) => sortQueue(s, data.bookings.filter((b) => s.statuses.includes(b.status))).map((b) => ({ booking: b, stage: s })));
  };
  const countFor = (stage: StageDef) => data.bookings.filter((b) => stage.statuses.includes(b.status)).length;

  const doResendLaundry = async () => {
    const date = todayIso();
    const ok = await confirm({ title: '重發今天的洗滌單？', message: `會用「待入住→入住中」排程的洗滌單設定，把 ${date} 入住訂單目前的布巾數量重新加總發給同一批收件人，訊息開頭標示【更新】。`, confirmLabel: '重發' });
    if (!ok) return;
    setResending(true);
    try { const r = await resendLaundry(date); enqueueSnackbar(r.summary, { variant: 'success' }); }
    catch (e: any) { enqueueSnackbar(e.message || '重發失敗', { variant: 'error' }); } finally { setResending(false); }
  };

  const renderRows = (group: StageGroup) => {
    const rows = rowsFor(group);
    if (loading) return <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={isMobile ? 120 : 52} />)}</Stack>;
    if (!rows.length) return <Paper variant="outlined" sx={{ p: 3, textAlign: 'center' }}><Typography variant="body2" color="text.secondary">目前沒有需要處理的訂單 🎉</Typography></Paper>;
    if (isMobile) {
      return (
        <Stack spacing={1.5}>
          {rows.map(({ booking: b, stage }) => {
            const a = actionFor(b.id, stage.key);
            return (
              <Card key={b.id} variant="outlined" sx={{ borderLeft: '4px solid', borderLeftColor: stage.color }}>
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ fontFamily: 'monospace' }}>{b.order_number}</Typography>
                      <Typography variant="body2" noWrap>{b.name || b.nickname || '未取得'}・{b.headcount ?? '?'} 人・{b.room_type_label || (b.whole_house ? '包棟' : '—')}</Typography>
                    </Box>
                    <StatusBadge status={b.status} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>{formatDateRange(b.checkin_date, b.checkout_date)}・總額 {formatMoney(b.total_amount)}・<Box component="span" sx={{ color: stage.color, fontWeight: 600 }}>{stage.amountLabel} {formatMoney(stage.amountOf(b))}</Box></Typography>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.25 }}>
                    <StageButton stage={stage} onClick={() => setPanel({ booking: b, stage })} size="medium" fullWidth />
                    {a?.confirmed_at && canNotify && b.line_user_id && <Button variant="outlined" size="medium" startIcon={<Send size={16} />} onClick={() => setNotify({ booking: b, stage })} sx={{ whiteSpace: 'nowrap' }}>訊息發送</Button>}
                  </Stack>
                  <Box sx={{ mt: 0.75 }}><ProgressMarks action={a} /></Box>
                </CardContent>
              </Card>
            );
          })}
        </Stack>
      );
    }
    return (
      <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 960, '& td': { py: 1 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 140 }}>動作</TableCell>
                <TableCell sx={{ width: 140 }}>訂單編號</TableCell>
                <TableCell>客人</TableCell>
                <TableCell sx={{ width: 180 }}>入住 → 退房</TableCell>
                <TableCell sx={{ width: 150 }}>人數・房型</TableCell>
                <TableCell sx={{ width: 150 }} align="right">總額／本關金額</TableCell>
                <TableCell sx={{ width: 110 }}>狀態</TableCell>
                <TableCell sx={{ width: 170 }}>進度</TableCell>
                <TableCell sx={{ width: 150 }} align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(({ booking: b, stage }) => {
                const a = actionFor(b.id, stage.key);
                return (
                  <TableRow key={b.id} hover onClick={() => setPanel({ booking: b, stage })} sx={{ cursor: 'pointer', '& td:first-of-type': { borderLeft: '4px solid', borderLeftColor: stage.color } }}>
                    <TableCell><StageButton stage={stage} onClick={() => setPanel({ booking: b, stage })} /></TableCell>
                    <TableCell><Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{b.order_number}</Typography></TableCell>
                    <TableCell><Typography variant="body2" noWrap>{b.name || b.nickname || '未取得'}</Typography>{b.phone && <Typography variant="caption" color="text.secondary">{b.phone}</Typography>}</TableCell>
                    <TableCell><Typography variant="body2" noWrap>{formatDateRange(b.checkin_date, b.checkout_date)}</Typography>{b.nights ? <Typography variant="caption" color="text.secondary">{b.nights} 晚</Typography> : null}</TableCell>
                    <TableCell><Typography variant="body2" noWrap>{b.headcount ?? '?'} 人・{b.room_type_label || (b.whole_house ? '包棟' : '—')}</Typography></TableCell>
                    <TableCell align="right"><Typography variant="body2" color="text.secondary">{formatMoney(b.total_amount)}</Typography><Typography variant="body2" sx={{ color: stage.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{stage.amountLabel} {formatMoney(stage.amountOf(b))}</Typography></TableCell>
                    <TableCell><StatusBadge status={b.status} /></TableCell>
                    <TableCell><ProgressMarks action={a} /></TableCell>
                    <TableCell align="right">
                      {a?.confirmed_at && (
                        <Tooltip title={!b.line_user_id ? '這筆訂單沒有 LINE 帳號' : !canNotify ? '沒有「發送訂單通知」權限' : ''}><span>
                          <Button size="small" variant="outlined" startIcon={<Send size={14} />} onClick={(e) => { e.stopPropagation(); setNotify({ booking: b, stage }); }} disabled={!b.line_user_id || !canNotify} sx={{ whiteSpace: 'nowrap' }}>訊息發送</Button>
                        </span></Tooltip>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Paper>
    );
  };

  const renderRecent = (group: StageGroup) => {
    const items = data.recent.filter((r) => STAGES.find((s) => s.key === r.action.stage)?.group === group);
    if (!items.length) return null;
    return (
      <Accordion disableGutters variant="outlined" sx={{ mt: 1.5, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ChevronDown size={18} />}><Typography variant="subtitle2">最近處理（7 天）<Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>{items.length} 筆・可在這裡補發或重發通知</Typography></Typography></AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
            {items.map(({ action: a, booking: b }) => {
              const stage = STAGES.find((s) => s.key === a.stage)!;
              const stillHere = stageForStatus(b.status)?.key === a.stage;
              return (
                <Stack key={`${a.booking_id}-${a.stage}`} direction={isMobile ? 'column' : 'row'} spacing={1} alignItems={isMobile ? 'stretch' : 'center'} sx={{ py: 1 }}>
                  <Chip label={stage.action} size="small" sx={{ bgcolor: stage.colorLight, color: stage.color, fontWeight: 600, alignSelf: 'flex-start' }} />
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 130 }}>{b.order_number}</Typography>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{b.name || b.nickname || '未取得'}・{formatDateRange(b.checkin_date, b.checkout_date)}</Typography>
                  <StatusBadge status={b.status} />
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 150 }}>確認 {formatDateTime(a.confirmed_at)}{a.notified_at ? `・已通知` : '・未通知'}</Typography>
                  {!stillHere && (
                    <Tooltip title={!b.line_user_id ? '這筆訂單沒有 LINE 帳號' : ''}><span>
                      <Button size="small" variant={a.notified_at ? 'text' : 'outlined'} startIcon={<Send size={14} />} onClick={() => setNotify({ booking: b, stage })} disabled={!b.line_user_id || !canNotify}>{a.notified_at ? '重發' : '訊息發送'}</Button>
                    </span></Tooltip>
                  )}
                </Stack>
              );
            })}
          </Stack>
        </AccordionDetails>
      </Accordion>
    );
  };

  const filterChips = (group: StageGroup) => (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      <Chip label={`全部 ${STAGES.filter((s) => s.group === group).reduce((n, s) => n + countFor(s), 0)}`} size="small" variant={filter[group] === 'all' ? 'filled' : 'outlined'} onClick={() => setFilter({ ...filter, [group]: 'all' })} />
      {STAGES.filter((s) => s.group === group).map((s) => (
        <Chip key={s.key} label={`${s.title} ${countFor(s)}`} size="small" onClick={() => setFilter({ ...filter, [group]: filter[group] === s.key ? 'all' : s.key })}
          sx={{ bgcolor: filter[group] === s.key ? s.color : s.colorLight, color: filter[group] === s.key ? '#fff' : s.color, fontWeight: 600, '&:hover': { bgcolor: s.color, color: '#fff' } }} />
      ))}
    </Stack>
  );

  const totalPending = useMemo(() => data.bookings.length, [data.bookings]);

  if (error) return <Box><PageHeaderV2 /><ResultState status={500} description={error} onRetry={() => load()} backTo={false} /></Box>;

  return (
    <Box>
      <PageHeaderV2
        adornment={totalPending > 0 ? <Chip label={`${totalPending} 筆待處理`} size="small" color="warning" /> : undefined}
        secondary={<Stack direction="row" spacing={1}>
          <Tooltip title="重新整理"><span><Button size="small" color="inherit" startIcon={<RefreshCw size={14} />} onClick={() => load(true)}>重新整理</Button></span></Tooltip>
          {canSettings && <Button size="small" color="inherit" startIcon={<Settings2 size={14} />} onClick={() => setSettingsOpen(true)}>預設範本</Button>}
        </Stack>}
      />

      <Stack spacing={4}>
        <Box>
          <Stack direction={isMobile ? 'column' : 'row'} justifyContent="space-between" alignItems={isMobile ? 'stretch' : 'center'} spacing={1.5} sx={{ mb: 1.5 }}>
            <Typography variant="h6">款項處理</Typography>
            {filterChips('payment')}
          </Stack>
          {renderRows('payment')}
          {renderRecent('payment')}
        </Box>

        <Box>
          <Stack direction={isMobile ? 'column' : 'row'} justifyContent="space-between" alignItems={isMobile ? 'stretch' : 'center'} spacing={1.5} sx={{ mb: 1.5 }}>
            <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
              <Typography variant="h6">入住處理</Typography>
              {canLaundry && <Button size="small" variant="outlined" startIcon={<Shirt size={14} />} onClick={doResendLaundry} disabled={resending}>{resending ? '重發中…' : '重發今日洗滌單'}</Button>}
            </Stack>
            {filterChips('checkin')}
          </Stack>
          <Alert severity="info" icon={false} sx={{ mb: 1.5, fontSize: 13 }}>待入住→入住中、入住中→押金處理由排程在入住日／退房日自動轉，這裡只設定密碼、調整洗物數量與通知客人。改了洗物數量而當天洗滌單已送出時，用右上「重發今日洗滌單」。</Alert>
          {renderRows('checkin')}
          {renderRecent('checkin')}
        </Box>
      </Stack>

      {panel && (
        <StagePanel
          open stage={panel.stage} booking={panel.booking} action={actionFor(panel.booking.id, panel.stage.key)}
          onClose={() => setPanel(null)}
          onChanged={applyLocal}
          onNotify={(b, s) => { setPanel(null); setNotify({ booking: b, stage: s }); }}
        />
      )}
      {notify && (
        <NotifyDialog open stage={notify.stage} booking={notify.booking} onClose={() => setNotify(null)} onSent={() => { setNotify(null); load(true); }} />
      )}
      <TemplateSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Box>
  );
}

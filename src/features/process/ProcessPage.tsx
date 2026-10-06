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
  DEFAULT_WINDOW_DAYS, GROUP_HINTS, GROUP_LABELS, STAGES, WINDOW_OPTIONS, damageSummary, fetchQueues, fetchStageTemplates, fetchTemplates,
  groupsOf, resendLaundry, saveStageTemplates, sortQueue, stageApplies, stageByKey, stageUsesWindow, withinCheckinWindow,
  type MessageTemplate, type QueueData, type StageAction, type StageDef, type StageGroup, type StageKey,
} from './processQueries';
import StagePanel from './StagePanel';
import NotifyDialog from './NotifyDialog';

// ========================================================================
// 訂單處理（訂房營運的第一個頁籤）：輪到人動手的訂單關卡，一個人只看到自己做得到的。
//   款項處理（會計）：訂金入款・尾款入款・押金退款・取消退款
//   入住準備（房務）：洗滌清單・入住密碼——預設只看未來 14 天要準備的
//   退房檢查（房務）：房況檢查——回報損壞，會計的押金退款直接帶入建議扣款
// 沒有權限的關卡整組不顯示（不是反灰）：房務打開只有後兩組、會計只有第一組，畫面上不會有按不了的東西。
// 清單即時更新：自己的操作先在本機更新，再訂閱 Supabase Realtime，沒有 Realtime 就每 30 秒背景重抓。
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

function ProgressMarks({ action, stage }: { action?: StageAction; stage: StageDef }) {
  if (!action?.confirmed_at) return <Typography variant="caption" color="text.disabled">尚未{stage.key === 'room_check' ? '檢查' : '確認'}</Typography>;
  return (
    <Stack spacing={0.25}>
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'success.main' }}><CheckCircle2 size={14} /><Typography variant="caption">已確認 {formatRelative(action.confirmed_at)}</Typography></Stack>
      {!stage.templateTitle ? null : action.notified_at
        ? <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'success.main' }}><Send size={13} /><Typography variant="caption">已通知 {formatRelative(action.notified_at)}</Typography></Stack>
        : <Typography variant="caption" color="warning.main">尚未通知客人</Typography>}
    </Stack>
  );
}

/** 這一關在列上要多顯示什麼：會計看金額、房務看房況／布巾 */
function RowExtra({ stage, booking }: { stage: StageDef; booking: BookingRow }) {
  if (stage.key === 'deposit_processing') {
    const d = damageSummary(booking);
    return <Chip size="small" label={d.label} color={!d.checked ? 'default' : booking.damage_found ? 'warning' : 'success'} variant={d.checked ? 'filled' : 'outlined'} sx={{ height: 20, fontSize: 11 }} />;
  }
  if (stage.key === 'checkin_password') {
    return booking.check_in_password
      ? <Typography variant="body2" sx={{ fontFamily: 'monospace', letterSpacing: 2 }}>{booking.check_in_password}</Typography>
      : <Typography variant="caption" color="warning.main">尚未設定密碼</Typography>;
  }
  if (stage.amountLabel) {
    return (
      <>
        <Typography variant="body2" color="text.secondary">{formatMoney(booking.total_amount)}</Typography>
        <Typography variant="body2" sx={{ color: stage.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{stage.amountLabel} {formatMoney(stage.amountOf(booking))}</Typography>
      </>
    );
  }
  return <Typography variant="body2" color="text.secondary">{formatMoney(booking.total_amount)}</Typography>;
}

function TemplateSettingsDialog({ open, onClose, stages }: { open: boolean; onClose: () => void; stages: StageDef[] }) {
  const { enqueueSnackbar } = useSnackbar();
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [map, setMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const withTemplate = stages.filter((s) => s.templateTitle);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([fetchTemplates(), fetchStageTemplates()]).then(([t, m]) => {
      setTemplates(t);
      // 沒設定的關卡先帶同名範本，讓管理員看得到「目前實際會用哪一個」
      const filled: Record<string, string> = { ...m };
      for (const s of withTemplate) if (!filled[s.key]) { const d = t.find((x) => x.title === s.templateTitle); if (d) filled[s.key] = d.id; }
      setMap(filled);
    }).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>按「訊息發送」時預設帶入的範本；發送前仍可換別的範本或臨時改內容。範本本身到「客戶與行銷 → 訊息發送」維護。洗滌清單與房況檢查不發客人通知，所以不在這裡。</Typography>
        {loading ? <Skeleton variant="rounded" height={240} /> : (
          <Stack spacing={2}>
            {withTemplate.map((s) => (
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
  const canLaundry = hasPermission('booking.linen.manage') || hasPermission('housekeeping.manage');
  const canSettings = hasPermission('booking.edit');

  // 只留這個人做得到的關卡：房務看不到金流、會計看不到布巾
  const myStages = useMemo(() => STAGES.filter((s) => hasPermission(s.permission)), [hasPermission]);
  const myGroups = useMemo(() => groupsOf(myStages), [myStages]);

  const [data, setData] = useState<QueueData>({ bookings: [], actions: [], recent: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Partial<Record<StageGroup, StageKey | 'all'>>>({});
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const [panel, setPanel] = useState<{ booking: BookingRow; stage: StageDef } | null>(null);
  const [notify, setNotify] = useState<{ booking: BookingRow; stage: StageDef } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resending, setResending] = useState(false);

  // 只有看得到「待補布巾數量」的人才去算那一關，不然每 30 秒替會計白跑一組最大的查詢。
  const canBackfillLinen = useMemo(() => myStages.some((s) => s.key === 'linen_backfill'), [myStages]);
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try { setData(await fetchQueues(canBackfillLinen)); setError(null); } catch (e: any) { if (!silent) setError(e.message || '讀取失敗'); } finally { if (!silent) setLoading(false); }
  }, [canBackfillLinen]);
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

  // 自己的操作立刻反映在清單上（不用等重抓）
  const applyLocal = (updated: BookingRow) => {
    setData((prev) => {
      const still = STAGES.some((s) => stageApplies(s, updated));
      const bookings = prev.bookings.filter((b) => b.id !== updated.id);
      return { ...prev, bookings: still ? [...bookings, updated] : bookings };
    });
    load(true);
  };

  const bookingsFor = (stage: StageDef) => data.bookings.filter((b) => stageApplies(stage, b) && (!stageUsesWindow(stage) || withinCheckinWindow(b, windowDays)));
  const rowsFor = (group: StageGroup) => {
    const active = filter[group] || 'all';
    return myStages.filter((s) => s.group === group && (active === 'all' || s.key === active))
      .flatMap((s) => sortQueue(s, bookingsFor(s)).map((b) => ({ booking: b, stage: s })));
  };
  const countFor = (stage: StageDef) => bookingsFor(stage).length;

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
              <Card key={`${b.id}-${stage.key}`} variant="outlined" sx={{ borderLeft: '4px solid', borderLeftColor: stage.color }}>
                <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle2" sx={{ fontFamily: 'monospace' }}>{b.order_number}</Typography>
                      <Typography variant="body2" noWrap>{b.name || b.nickname || '未取得'}・{b.headcount ?? '?'} 人・{b.room_type_label || (b.whole_house ? '包棟' : '—')}</Typography>
                    </Box>
                    <StatusBadge status={b.status} />
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">{formatDateRange(b.checkin_date, b.checkout_date)}</Typography>
                    <RowExtra stage={stage} booking={b} />
                  </Stack>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.25 }}>
                    <StageButton stage={stage} onClick={() => setPanel({ booking: b, stage })} size="medium" fullWidth />
                    {a?.confirmed_at && canNotify && !!stage.templateTitle && b.line_user_id && (
                      <Button variant="outlined" size="medium" startIcon={<Send size={16} />} onClick={() => setNotify({ booking: b, stage })} sx={{ whiteSpace: 'nowrap' }}>{stage.notifyLabel || '訊息發送'}</Button>
                    )}
                  </Stack>
                  <Box sx={{ mt: 0.75 }}><ProgressMarks action={a} stage={stage} /></Box>
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
                <TableCell sx={{ width: 170 }} align="right">{group === 'payment' ? '總額／本關金額' : group === 'checkout' ? '房況' : '總額'}</TableCell>
                <TableCell sx={{ width: 110 }}>狀態</TableCell>
                <TableCell sx={{ width: 170 }}>進度</TableCell>
                <TableCell sx={{ width: 150 }} align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(({ booking: b, stage }) => {
                const a = actionFor(b.id, stage.key);
                return (
                  <TableRow key={`${b.id}-${stage.key}`} hover onClick={() => setPanel({ booking: b, stage })} sx={{ cursor: 'pointer', '& td:first-of-type': { borderLeft: '4px solid', borderLeftColor: stage.color }, ...(panel?.booking.id === b.id && panel?.stage.key === stage.key ? { bgcolor: 'action.selected' } : {}) }}>
                    <TableCell><StageButton stage={stage} onClick={() => setPanel({ booking: b, stage })} /></TableCell>
                    <TableCell><Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{b.order_number}</Typography></TableCell>
                    <TableCell><Typography variant="body2" noWrap>{b.name || b.nickname || '未取得'}</Typography>{b.phone && <Typography variant="caption" color="text.secondary">{b.phone}</Typography>}</TableCell>
                    <TableCell><Typography variant="body2" noWrap>{formatDateRange(b.checkin_date, b.checkout_date)}</Typography>{b.nights ? <Typography variant="caption" color="text.secondary">{b.nights} 晚</Typography> : null}</TableCell>
                    <TableCell><Typography variant="body2" noWrap>{b.headcount ?? '?'} 人・{b.room_type_label || (b.whole_house ? '包棟' : '—')}</Typography></TableCell>
                    <TableCell align="right"><RowExtra stage={stage} booking={b} /></TableCell>
                    <TableCell><StatusBadge status={b.status} /></TableCell>
                    <TableCell><ProgressMarks action={a} stage={stage} /></TableCell>
                    <TableCell align="right">
                      {a?.confirmed_at && !!stage.templateTitle && (
                        <Tooltip title={!b.line_user_id ? '這筆訂單沒有 LINE 帳號' : !canNotify ? '沒有「發送訂單通知」權限' : ''}><span>
                          <Button size="small" variant="outlined" startIcon={<Send size={14} />} onClick={(e) => { e.stopPropagation(); setNotify({ booking: b, stage }); }} disabled={!b.line_user_id || !canNotify} sx={{ whiteSpace: 'nowrap' }}>{stage.notifyLabel || '訊息發送'}</Button>
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
    const items = data.recent.filter((r) => myStages.some((s) => s.key === r.action.stage && s.group === group));
    if (!items.length) return null;
    return (
      <Accordion disableGutters variant="outlined" sx={{ mt: 1.5, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ChevronDown size={18} />}><Typography variant="subtitle2">最近處理（7 天）<Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>{items.length} 筆</Typography></Typography></AccordionSummary>
        <AccordionDetails sx={{ pt: 0 }}>
          <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
            {items.map(({ action: a, booking: b }) => {
              const stage = stageByKey(a.stage);
              const stillHere = stageApplies(stage, b);
              return (
                <Stack key={`${a.booking_id}-${a.stage}`} direction={isMobile ? 'column' : 'row'} spacing={1} alignItems={isMobile ? 'stretch' : 'center'} sx={{ py: 1 }}>
                  <Chip label={stage.action} size="small" sx={{ bgcolor: stage.colorLight, color: stage.color, fontWeight: 600, alignSelf: 'flex-start' }} />
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', minWidth: 130 }}>{b.order_number}</Typography>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{b.name || b.nickname || '未取得'}・{formatDateRange(b.checkin_date, b.checkout_date)}</Typography>
                  <StatusBadge status={b.status} />
                  <Typography variant="caption" color="text.secondary" sx={{ minWidth: 150 }}>確認 {formatDateTime(a.confirmed_at)}{stage.templateTitle ? (a.notified_at ? '・已通知' : '・未通知') : ''}</Typography>
                  {!stillHere && !!stage.templateTitle && (
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

  const filterChips = (group: StageGroup) => {
    const stages = myStages.filter((s) => s.group === group);
    if (stages.length < 2) return null;
    const active = filter[group] || 'all';
    return (
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip label={`全部 ${stages.reduce((n, s) => n + countFor(s), 0)}`} size="small" variant={active === 'all' ? 'filled' : 'outlined'} onClick={() => setFilter({ ...filter, [group]: 'all' })} />
        {stages.map((s) => (
          <Chip key={s.key} label={`${s.title} ${countFor(s)}`} size="small" onClick={() => setFilter({ ...filter, [group]: active === s.key ? 'all' : s.key })}
            sx={{ bgcolor: active === s.key ? s.color : s.colorLight, color: active === s.key ? '#fff' : s.color, fontWeight: 600, '&:hover': { bgcolor: s.color, color: '#fff' } }} />
        ))}
      </Stack>
    );
  };

  const windowChips = (
    <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="caption" color="text.secondary">入住日</Typography>
      {WINDOW_OPTIONS.map((d) => (
        <Chip key={d} size="small" label={d === 0 ? '全部' : `${d} 天內`} variant={windowDays === d ? 'filled' : 'outlined'} color={windowDays === d ? 'primary' : 'default'} onClick={() => setWindowDays(d)} />
      ))}
    </Stack>
  );

  const totalPending = useMemo(() => {
    const seen = new Set<string>();
    for (const s of myStages) for (const b of bookingsFor(s)) seen.add(`${b.id}-${s.key}`);
    return seen.size;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myStages, data.bookings, windowDays]);

  if (error) return <Box><PageHeaderV2 /><ResultState status={500} description={error} onRetry={() => load()} backTo={false} /></Box>;
  if (!myGroups.length) return <Box><PageHeaderV2 /><ResultState status={403} description="你的角色沒有任何訂單處理的權限。需要處理款項、洗滌清單、入住密碼或房況，請聯繫管理員。" backTo={false} /></Box>;

  return (
    <Box>
      <PageHeaderV2
        adornment={totalPending > 0 ? <Chip label={`${totalPending} 件待處理`} size="small" color="warning" /> : undefined}
        secondary={<Stack direction="row" spacing={1}>
          <Button size="small" color="inherit" startIcon={<RefreshCw size={14} />} onClick={() => load(true)}>重新整理</Button>
          {canSettings && <Button size="small" color="inherit" startIcon={<Settings2 size={14} />} onClick={() => setSettingsOpen(true)}>預設範本</Button>}
        </Stack>}
      />

      <Stack spacing={4}>
        {myGroups.map((group) => (
          <Box key={group}>
            <Stack direction={isMobile ? 'column' : 'row'} justifyContent="space-between" alignItems={isMobile ? 'stretch' : 'center'} spacing={1.5} sx={{ mb: 1.5 }}>
              <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
                <Typography variant="h6">{GROUP_LABELS[group]}</Typography>
                {group === 'checkin' && canLaundry && <Button size="small" variant="outlined" startIcon={<Shirt size={14} />} onClick={doResendLaundry} disabled={resending}>{resending ? '重發中…' : '重發今日洗滌單'}</Button>}
              </Stack>
              <Stack direction={isMobile ? 'column' : 'row'} spacing={1.5} alignItems={isMobile ? 'stretch' : 'center'}>
                {group === 'checkin' && windowChips}
                {filterChips(group)}
              </Stack>
            </Stack>
            <Alert severity="info" icon={false} sx={{ mb: 1.5, fontSize: 13 }}>{GROUP_HINTS[group]}</Alert>
            {renderRows(group)}
            {renderRecent(group)}
          </Box>
        ))}
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
      <TemplateSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} stages={myStages} />
    </Box>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Grid, IconButton, Link, Menu, MenuItem,
  Paper, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ChevronDown, ChevronLeft, MoreVertical, Pencil, Trash2, X } from 'lucide-react';
import {
  FLOW_STEP_STATUSES, MANUAL_ACTION_STATUSES, bookingStatusLabel, bookingStatusMeta, flowStepIndex, nextFlowStatus,
} from '../../lib/bookingStatus';
import { formatDate, formatDateTime, formatMoney, formatRelative } from '../../lib/format';
import { linenItemLabel, usageTotal, type LinenItem, type LinenUsageRow } from '../../lib/linenCost';
import { roomLabel, type RoomOption } from '../../lib/rooms';
import { useBreakpoint } from '../../app/useBreakpoint';
import { usePermission } from '../../app/Can';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import {
  bookingBalance, bookingSourceLabel, fetchBooking, fetchBookingLinen, fetchBookingLogs, fetchLinenSetup, fetchRooms,
  type BookingLogRow, type BookingRow,
} from './bookingQueries';
import { deleteBooking } from './bookingActions';
import BookingEditDialog from './BookingEditDialog';
import AdvanceStatusDialog from './AdvanceStatusDialog';

// ========================================================================
// 訂單詳情（V2 §22–24）。列表點一列進來；回答「這張單現在在哪、下一步要做什麼、錢收到哪」。
// 桌面雙欄：左邊訂房／金額／備註／布巾，右邊狀態流程／客戶／紀錄；手機單欄、次要區塊摺疊、
// 主要操作固定底部。危險操作（取消、刪除）都先確認並列出 訂單編號／客戶／影響。
// ========================================================================

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>
        {value === null || value === undefined || value === '' ? '—' : value}
      </Typography>
    </Box>
  );
}

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

export default function BookingDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const canDelete = usePermission('booking.delete');
  const canEdit = usePermission('booking.edit');
  const canCancel = usePermission('booking.cancel');
  const canAdvance = usePermission('booking.payment.verify');
  const canRefund = usePermission('booking.refund.process');
  // 訂單時間軸讀 operation_logs（RLS：audit.view）；booking.history.view 是介面上的開關
  const canHistory = usePermission('booking.history.view');
  const canAuditLogs = usePermission('audit.view');
  const canAudit = canHistory && canAuditLogs;

  const [booking, setBooking] = useState<BookingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'notfound' | string | null>(null);
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [usage, setUsage] = useState<LinenUsageRow[]>([]);
  const [linenItems, setLinenItems] = useState<LinenItem[]>([]);
  const [logs, setLogs] = useState<BookingLogRow[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [advanceTarget, setAdvanceTarget] = useState<{ order: BookingRow; nextStatus: string } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setLoading(true); setLoadError(null); }
    try {
      const b = await fetchBooking(id);
      if (!b) { setLoadError('notfound'); setBooking(null); return; }
      setBooking(b);
      const [linen, roomList, setup, logRows] = await Promise.all([
        fetchBookingLinen(b.id),
        fetchRooms(),
        fetchLinenSetup(),
        // operation_logs 只有管理員讀得到（RLS）；沒權限就不打，避免每次進頁面都吃一個 403
        canAudit && b.order_number ? fetchBookingLogs(b.order_number).catch(() => []) : Promise.resolve([]),
      ]);
      setRoomIds(linen.roomIds);
      setUsage(linen.usage);
      setRooms(roomList);
      setLinenItems(setup.items);
      setLogs(logRows);
    } catch (err: any) {
      setLoadError(err.message || '載入失敗');
    } finally {
      setLoading(false);
    }
  }, [id, canAudit]);

  useEffect(() => { load(); }, [load]);

  const remove = async () => {
    if (!booking) return;
    const ok = await confirm({
      title: '刪除訂單',
      message: (
        <Stack spacing={0.5}>
          <Typography variant="body2">訂單 <b>{booking.order_number || '—'}</b>・{booking.name || booking.nickname || '未取得'}</Typography>
          <Typography variant="body2" color="text.secondary">會連同房間與布巾用量一起刪除，且無法復原。若只是客人不來了，請改用「取消訂單」保留紀錄。</Typography>
        </Stack>
      ),
      confirmLabel: '刪除',
      danger: true,
      requireTypedText: booking.order_number || undefined,
    });
    if (!ok) return;
    try {
      await deleteBooking(booking);
      enqueueSnackbar('訂單已刪除', { variant: 'success' });
      navigate('/bookings', { replace: true });
    } catch (err: any) {
      enqueueSnackbar(`刪除失敗：${err.message}`, { variant: 'error' });
    }
  };

  if (loadError === 'notfound') return <ResultState status={404} description="找不到這張訂單，可能已被刪除。" backTo="/bookings" />;
  if (loadError) return <ResultState status={500} description={loadError} onRetry={() => load()} backTo="/bookings" />;

  if (loading || !booking) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="text" width={240} height={36} />
        <Grid container spacing={2}>
          <Grid item xs={12} md={7}><Skeleton variant="rounded" height={220} /></Grid>
          <Grid item xs={12} md={5}><Skeleton variant="rounded" height={220} /></Grid>
        </Grid>
      </Stack>
    );
  }

  const b = booking;
  const meta = bookingStatusMeta(b.status);
  const step = flowStepIndex(b.status);
  const next = nextFlowStatus(b.status);
  const balance = bookingBalance(b);
  const selectedRooms = rooms.filter((r) => roomIds.includes(r.id));
  const roomText = selectedRooms.length ? selectedRooms.map(roomLabel).join('、') : b.room_type_label || '—';
  const isOta = b.status === 'external_synced';
  const usageRows = usage.filter((u) => u.quantity > 0);
  const breakdown = [b.adults != null ? `大人 ${b.adults}` : '', b.kids != null ? `小孩 ${b.kids}` : '', b.infants != null ? `嬰兒 ${b.infants}` : ''].filter(Boolean);
  const headcountText = b.headcount != null ? `${b.headcount} 人${breakdown.length ? `（${breakdown.join('・')}）` : ''}` : null;

  // 推進狀態＝確認付款（booking.payment.verify）；待退款 → 已退款是另一個權限（booking.refund.process）
  const canStep = canAdvance && !!next && !isOta;
  const canMarkRefunded = canRefund && b.status === 'awaiting_refund';
  const primaryAction = canStep
    ? <Button variant="contained" onClick={() => setAdvanceTarget({ order: b, nextStatus: next! })} fullWidth={isMobile}>下一步：{bookingStatusLabel(next)}</Button>
    : canMarkRefunded
      ? <Button variant="contained" onClick={() => setAdvanceTarget({ order: b, nextStatus: 'refunded' })} fullWidth={isMobile}>標記已退款</Button>
      : canEdit ? <Button variant="contained" startIcon={<Pencil size={16} />} onClick={() => setEditOpen(true)} fullWidth={isMobile}>編輯訂單</Button> : null;

  const bookingInfo = (
    <Grid container spacing={2}>
      <Grid item xs={6} sm={3}><Field label="入住日期" value={formatDate(b.checkin_date)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="退房日期" value={formatDate(b.checkout_date)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="晚數" value={b.nights != null ? `${b.nights} 晚` : null} /></Grid>
      <Grid item xs={6} sm={3}><Field label="人數" value={headcountText} /></Grid>
      <Grid item xs={12} sm={6}><Field label={b.whole_house ? '房型（包棟）' : '房型'} value={roomText} /></Grid>
      <Grid item xs={6} sm={3}><Field label="來源" value={bookingSourceLabel(b)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="建立時間" value={formatDateTime(b.created_at)} /></Grid>
      {isOta && b.external_confirmation_code && <Grid item xs={12}><Field label="平台確認碼" value={b.external_confirmation_code} mono /></Grid>}
    </Grid>
  );

  const paymentInfo = (
    <Grid container spacing={2}>
      <Grid item xs={6} sm={3}><Field label="房價" value={formatMoney(b.room_amount ?? b.total_amount)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="押金" value={formatMoney(b.security_deposit)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="訂單總額" value={<b>{formatMoney(b.total_amount) || '—'}</b>} /></Grid>
      <Grid item xs={6} sm={3}><Field label="訂金" value={formatMoney(b.deposit)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="尾款" value={balance != null ? formatMoney(balance) : null} /></Grid>
      <Grid item xs={6} sm={3}><Field label="匯款末5碼" value={b.remit_last5} mono /></Grid>
      <Grid item xs={6} sm={3}><Field label="匯款期限" value={formatDateTime(b.payment_deadline_at)} /></Grid>
      <Grid item xs={6} sm={3}><Field label="入住密碼" value={b.check_in_password} mono /></Grid>
    </Grid>
  );

  const notes = (
    <Stack spacing={1.5}>
      <Field label="顧客備註（客人在 LINE 填寫）" value={b.guest_notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{b.guest_notes}</span> : null} />
      <Field label="內部備註" value={b.notes ? <span style={{ whiteSpace: 'pre-wrap' }}>{b.notes}</span> : null} />
    </Stack>
  );

  const linen = usageRows.length > 0 && (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small">
        <TableHead><TableRow><TableCell>品項</TableCell><TableCell align="right">單價</TableCell><TableCell align="right">件數</TableCell><TableCell align="right">小計</TableCell></TableRow></TableHead>
        <TableBody>
          {usageRows.map((r) => {
            const item = linenItems.find((i) => i.id === r.linen_item_id);
            return (
              <TableRow key={r.linen_item_id}>
                <TableCell>{item ? linenItemLabel(item) : '（已刪除的品項）'}</TableCell>
                <TableCell align="right">{r.unit_price}</TableCell>
                <TableCell align="right">{r.quantity}</TableCell>
                <TableCell align="right">{formatMoney(r.quantity * r.unit_price)}</TableCell>
              </TableRow>
            );
          })}
          <TableRow><TableCell colSpan={3} align="right" sx={{ color: 'text.secondary' }}>換洗 {b.linen_change_count ?? 1} 次・合計</TableCell><TableCell align="right" sx={{ fontWeight: 700 }}>{formatMoney(usageTotal(usageRows))}</TableCell></TableRow>
        </TableBody>
      </Table>
    </Box>
  );

  const statusPanel = (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <StatusBadge status={b.status} size="medium" />
        <Typography variant="caption" color="text.secondary">{step ? `流程 ${step}/${FLOW_STEP_STATUSES.length}` : '例外流程'}</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary">{meta.description}</Typography>
      {MANUAL_ACTION_STATUSES.includes(b.status) && <Alert severity="warning" sx={{ py: 0 }}>這一關要人工處理，系統不會自動往前推。</Alert>}

      {/* 1~9 主流程：目前這關實心、已過的淡色、未到的灰 */}
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
        {FLOW_STEP_STATUSES.map((s, i) => {
          const n = i + 1;
          const isCurrent = step === n;
          const isDone = step != null && n < step;
          return (
            <Box key={s} title={bookingStatusLabel(s)} sx={{
              width: 30, height: 30, borderRadius: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700,
              bgcolor: isCurrent ? 'primary.main' : isDone ? 'primary.light' : 'grey.100',
              color: isCurrent ? 'primary.contrastText' : isDone ? 'primary.dark' : 'text.disabled',
            }}>{n}</Box>
          );
        })}
      </Stack>
      {step && <Typography variant="caption" color="text.secondary">目前：{step}. {bookingStatusLabel(b.status)}{next ? `，下一關：${bookingStatusLabel(next)}` : '（最後一關）'}</Typography>}

      {!isMobile && (
        <Stack spacing={1}>
          {canStep && (
            <Button variant="contained" fullWidth onClick={() => setAdvanceTarget({ order: b, nextStatus: next! })}>下一步：{bookingStatusLabel(next)}</Button>
          )}
          {canMarkRefunded && (
            <Button variant="contained" fullWidth onClick={() => setAdvanceTarget({ order: b, nextStatus: 'refunded' })}>標記已退款</Button>
          )}
          {canCancel && !meta.isFinal && !isOta && b.status !== 'awaiting_refund' && (
            <Button variant="outlined" color="error" fullWidth startIcon={<X size={16} />} onClick={() => setAdvanceTarget({ order: b, nextStatus: 'cancelled' })}>取消訂單</Button>
          )}
        </Stack>
      )}
      {isOta && <Alert severity="info" sx={{ py: 0 }}>外部平台訂單只用來佔用日期；要改或取消請回到來源平台操作。</Alert>}
    </Stack>
  );

  const customerPanel = (
    <Stack spacing={1.5}>
      <Field label="姓名" value={b.name} />
      <Field label="LINE 暱稱" value={b.nickname} />
      <Field label="電話" value={b.phone ? <Link href={`tel:${b.phone}`} underline="hover">{b.phone}</Link> : null} />
      <Field label="LINE User ID" value={b.line_user_id} mono />
      {b.phone && (
        <Link component={RouterLink} to={`/customers?q=${encodeURIComponent(b.phone)}`} variant="body2" underline="hover">查看客戶資料 →</Link>
      )}
    </Stack>
  );

  const relations = (
    <>
      {b.ota_conflict_with && <Alert severity="error">這筆 OTA 訂單跟本地訂單撞期，待人工查核。<Link component={RouterLink} to={`/bookings/${b.ota_conflict_with}`} sx={{ ml: 1 }}>查看撞期訂單</Link></Alert>}
      {b.waitlist_blocked_by && <Alert severity="warning">候補中：等 <Link component={RouterLink} to={`/bookings/${b.waitlist_blocked_by}`}>這筆訂單</Link> 有結果後，系統會重新試算並通知客人。</Alert>}
      {b.supersedes_booking_id && <Alert severity="info">這筆是重新報價後開的新單，取代了 <Link component={RouterLink} to={`/bookings/${b.supersedes_booking_id}`}>舊訂單</Link>。</Alert>}
    </>
  );

  const timeline = (
    <Stack spacing={1.5}>
      {canAudit && logs.length > 0 ? logs.map((l) => (
        <Stack key={l.id} direction="row" spacing={1.5}>
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', mt: 0.9, flexShrink: 0, bgcolor: l.level === 'error' ? 'error.main' : l.action === '狀態變更' ? 'primary.main' : 'grey.400' }} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2">
              {l.action}
              {l.action === '狀態變更' && l.after && l.after['訂單狀態'] != null && <>：{bookingStatusLabel(String(l.before?.['訂單狀態'] ?? ''))} → <b>{bookingStatusLabel(String(l.after['訂單狀態']))}</b></>}
              {l.action === '修改' && l.after && <Typography component="span" variant="caption" color="text.secondary">（{Object.keys(l.after).join('、')}）</Typography>}
              {l.level === 'error' && <Typography component="span" variant="caption" color="error.main">（{l.error_message}）</Typography>}
            </Typography>
            <Typography variant="caption" color="text.secondary" title={formatDateTime(l.created_at)}>
              {formatDateTime(l.created_at)}・{l.actor_type === 'system' ? '系統' : l.actor_name}・{formatRelative(l.created_at)}
            </Typography>
          </Box>
        </Stack>
      )) : (
        <>
          {/* 沒有紀錄（或沒權限看）時只列真的存得到的兩個時間點，不去推測中間經過哪些關卡 */}
          <Field label="建立" value={formatDateTime(b.created_at)} />
          <Field label="最後異動" value={formatDateTime(b.updated_at)} />
          {b.reserved_at ? <Field label="確認預訂" value={formatDateTime(String(b.reserved_at))} /> : null}
          {!canAudit && <Typography variant="caption" color="text.secondary">完整操作紀錄需要管理員權限。</Typography>}
        </>
      )}
    </Stack>
  );

  return (
    <Box sx={{ pb: isMobile ? 10 : 0 }}>
      {/* 頁首：麻雀雖小——返回、編號、狀態、動作 */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <IconButton component={RouterLink} to="/bookings" size="small" aria-label="回訂單列表"><ChevronLeft size={20} /></IconButton>
        <Box sx={{ minWidth: 0, flexGrow: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant={isMobile ? 'h6' : 'h5'} component="h1" noWrap>{b.name || b.nickname || '未取得'}</Typography>
            <StatusBadge status={b.status} />
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>訂單 {b.order_number || '—'}</Typography>
        </Box>
        {!isMobile && (
          <Stack direction="row" spacing={1}>
            {canEdit && <Button variant="outlined" color="inherit" startIcon={<Pencil size={16} />} onClick={() => setEditOpen(true)}>編輯</Button>}
            {(canStep || canMarkRefunded) && primaryAction}
          </Stack>
        )}
        {(canDelete || (isMobile && canCancel)) && (
          <>
            <IconButton onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="更多操作"><MoreVertical size={18} /></IconButton>
            <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
              {isMobile && canEdit && <MenuItem onClick={() => { setMenuAnchor(null); setEditOpen(true); }}><Pencil size={16} style={{ marginRight: 8 }} />編輯訂單</MenuItem>}
              {isMobile && canCancel && !meta.isFinal && !isOta && b.status !== 'awaiting_refund' && (
                <MenuItem onClick={() => { setMenuAnchor(null); setAdvanceTarget({ order: b, nextStatus: 'cancelled' }); }}><X size={16} style={{ marginRight: 8 }} />取消訂單</MenuItem>
              )}
              {canDelete && <MenuItem onClick={() => { setMenuAnchor(null); remove(); }} sx={{ color: 'error.main' }}><Trash2 size={16} style={{ marginRight: 8 }} />刪除訂單</MenuItem>}
            </Menu>
          </>
        )}
      </Stack>

      <Stack spacing={1.5} sx={{ mb: 2 }}>{relations}</Stack>

      <Grid container spacing={2} alignItems="flex-start">
        <Grid item xs={12} md={7} lg={8}>
          <Stack spacing={2}>
            <Section title="訂房資訊">{bookingInfo}</Section>
            {isMobile ? (
              <>
                <Section title="狀態與流程" collapsible>{statusPanel}</Section>
                <Section title="金額與付款" collapsible>{paymentInfo}</Section>
                <Section title="客戶" collapsible defaultExpanded={false}>{customerPanel}</Section>
                <Section title="備註" collapsible defaultExpanded={!!(b.guest_notes || b.notes)}>{notes}</Section>
                {linen && <Section title="布巾洗滌" collapsible defaultExpanded={false}>{linen}</Section>}
                <Section title="系統紀錄" collapsible defaultExpanded={false}>{timeline}</Section>
              </>
            ) : (
              <>
                <Section title="金額與付款">{paymentInfo}</Section>
                <Section title="備註">{notes}</Section>
                {linen && <Section title="布巾洗滌">{linen}</Section>}
              </>
            )}
          </Stack>
        </Grid>
        {!isMobile && (
          <Grid item xs={12} md={5} lg={4}>
            <Stack spacing={2}>
              <Section title="狀態與流程">{statusPanel}</Section>
              <Section title="客戶">{customerPanel}</Section>
              <Section title="系統紀錄">{timeline}</Section>
            </Stack>
          </Grid>
        )}
      </Grid>

      {/* 手機：主要操作固定底部（§15 Mobile） */}
      {isMobile && primaryAction && (
        <Paper elevation={8} square sx={{ position: 'fixed', left: 0, right: 0, bottom: 0, p: 1.5, zIndex: (t) => t.zIndex.appBar, borderTop: '1px solid', borderColor: 'divider' }}>
          {primaryAction}
        </Paper>
      )}

      <BookingEditDialog open={editOpen} booking={b} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); enqueueSnackbar('訂單已儲存', { variant: 'success' }); load({ silent: true }); }} />
      <AdvanceStatusDialog target={advanceTarget} onClose={() => setAdvanceTarget(null)} onDone={() => { setAdvanceTarget(null); enqueueSnackbar('狀態已更新', { variant: 'success' }); load({ silent: true }); }} />
    </Box>
  );
}

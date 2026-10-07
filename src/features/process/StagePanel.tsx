import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, Dialog, DialogContent, Divider, IconButton, InputAdornment, Skeleton, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ArrowRight, Check, Minus, Plus, RotateCcw, Send, Shuffle, X } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { usePermissions } from '../../app/PermissionContext';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatDateRange, formatDateTime, formatMoney } from '../../lib/format';
import { bookingStatusLabel } from '../../lib/bookingStatus';
import { computeUsage, linenItemLabel, normalizeChangeCount, type LinenItem, type LinenUsageRow, type RoomLinenDefault } from '../../lib/linenCost';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import { computeBalanceDue, extraChargeCode, hasUnpaidExtraCharges, type ExtraCharge } from '../../lib/extraCharges';
import { fetchExtraCharges, setExtraChargesPaid } from '../booking/extraChargeQueries';
import AddExtraChargesDialog from '../booking/AddExtraChargesDialog';
import { fetchBookingLinen, fetchLinenSetup, fetchRooms, type BookingRow } from '../booking/bookingQueries';
import { roomLabel, type RoomOption } from '../../lib/rooms';
import { advanceBookingStatus, saveBookingLinen, BookingActionError } from '../booking/bookingActions';
import { damageSummary, markStageConfirmed, saveStageEdits, type StageAction, type StageDef, type StageEditPatch } from './processQueries';

// ========================================================================
// 處理視窗：點一筆訂單後彈出置中視窗（手機整頁），只顯示「這一關需要看的」——訂單編號、訂房資訊、
// 金額（會計看完整、房務只看總額）、這一關的可編輯欄位、內部備註。底部：取消／高亮動作鈕（＝確認）／並推進。
// 確認完直接切到第二步「發送通知」；不發客人通知的關卡（洗滌、房況）確認完就結束。
// ========================================================================

function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontFamily: mono ? 'monospace' : undefined, wordBreak: 'break-all' }}>{value ?? '—'}</Typography>
    </Box>
  );
}

/** 手機上用加減鈕調數量，不用叫出鍵盤 */
function QtyStepper({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ py: 0.75, borderBottom: '1px solid', borderColor: 'divider' }}>
      <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }}>{label}</Typography>
      <IconButton size="small" onClick={() => onChange(Math.max(0, value - 1))} disabled={disabled || value <= 0} aria-label={`${label} 減一`}><Minus size={16} /></IconButton>
      <Typography variant="h6" sx={{ width: 40, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
      <IconButton size="small" onClick={() => onChange(value + 1)} disabled={disabled} aria-label={`${label} 加一`}><Plus size={16} /></IconButton>
    </Stack>
  );
}

export interface StagePanelProps {
  open: boolean;
  stage: StageDef;
  booking: BookingRow;
  action?: StageAction;
  onClose: () => void;
  /** 訂單或關卡紀錄改了：上層立刻更新清單 */
  onChanged: (updated: BookingRow) => void;
  onNotify: (booking: BookingRow, stage: StageDef) => void;
}

export default function StagePanel({ open, stage, booking, action, onClose, onChanged, onNotify }: StagePanelProps) {
  const { enqueueSnackbar } = useSnackbar();
  const { profile } = useAuth();
  const { hasPermission } = usePermissions();
  const { isMobile } = useBreakpoint();
  const canAct = hasPermission(stage.permission);
  const canSeePayment = hasPermission('booking.payment.view');
  const canNotify = hasPermission('booking.notify') && !!stage.templateTitle;
  const canVerifyPayment = hasPermission('booking.payment.verify');
  // 跟訂單詳情的追加款明細同一套權限：訂單編輯或款項核對
  const canAddExtras = hasPermission('booking.edit') || canVerifyPayment;
  const [addingExtra, setAddingExtra] = useState(false);
  // 視窗內新增追加款後的未付合計。不呼叫 onChanged：上層換了新的 booking 物件會觸發表單初始化，
  // 把使用者已經填的備註、末五碼清掉。
  const [unpaidOverride, setUnpaidOverride] = useState<number | null>(null);
  const shown = unpaidOverride == null ? booking : ({ ...booking, extra_unpaid_total: unpaidOverride } as BookingRow);

  const [notes, setNotes] = useState('');
  const [remit, setRemit] = useState('');
  const [password, setPassword] = useState('');
  const [refund, setRefund] = useState('');
  const [refundNote, setRefundNote] = useState('');
  const [damaged, setDamaged] = useState<boolean | null>(null);
  const [deduction, setDeduction] = useState('');
  const [damageNote, setDamageNote] = useState('');
  const [linen, setLinen] = useState<{ items: LinenItem[]; defaults: RoomLinenDefault[]; roomIds: string[]; usage: LinenUsageRow[] } | null>(null);
  const [linenLoading, setLinenLoading] = useState(false);
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  // 開啟當下這筆訂單有沒有房間。只有本來沒有的才讓房務在這裡選——已經排好房的訂單，
  // booking_rooms 會影響檔期衝突判斷，不該由這一關改動。
  const roomsWereEmptyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<BookingRow | null>(null);
  const [remitError, setRemitError] = useState('');
  const [extras, setExtras] = useState<ExtraCharge[]>([]);
  const [extrasPicked, setExtrasPicked] = useState<string[]>([]);
  const [extrasError, setExtrasError] = useState('');

  const has = (f: string) => stage.fields.includes(f as never);

  useEffect(() => {
    if (!open) return;
    setNotes(booking.notes || '');
    // 尾款末五碼沒填過就帶訂金那一組（多數人兩次都用同一個帳號匯款），不對再改
    setRemit(has('balance_remit') ? (booking.balance_remit_last5 || booking.remit_last5 || '') : (booking.remit_last5 || ''));
    setPassword(booking.check_in_password || '');
    const defRefund = booking.refund_amount ?? stage.defaultRefund?.(booking) ?? null;
    setRefund(defRefund == null ? '' : String(defRefund));
    setRefundNote(booking.refund_note || '');
    setDamaged(booking.damage_found ?? null);
    setDeduction(booking.damage_deduction == null ? '' : String(booking.damage_deduction));
    setDamageNote(booking.damage_note || '');
    setDone(null); setRemitError(''); setLinen(null);
    if (has('linen')) {
      setLinenLoading(true);
      // 房間清單只有「待補布巾數量」那一關用得到。洗滌清單不給改房間，就不要為它多打一支查詢，
      // 行為也維持跟以前完全一樣。
      const needRooms = stage.key === 'linen_backfill';
      Promise.all([fetchLinenSetup(), fetchBookingLinen(booking.id), needRooms ? fetchRooms() : Promise.resolve([])])
        .then(([setup, mine, allRooms]) => {
          setRooms(allRooms);
          // 一開啟就記住「進來的時候有沒有房間」。房間選擇器只開放給本來就沒有房間的訂單，
          // 這個判斷必須鎖在開啟當下——不然使用者剛選完房、roomIds 有值了，選擇器就自己消失。
          roomsWereEmptyRef.current = needRooms && mine.roomIds.length === 0;
          setLinen({ items: setup.items, defaults: setup.defaults, roomIds: mine.roomIds, usage: mine.usage });
        })
        .finally(() => setLinenLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, booking, stage]);

  // 追加款獨立載入，只在開啟／換訂單／換關卡時重抓。以前跟上面的表單初始化綁在一起，
  // 依賴 booking 物件：父層任何一次重新整理（換了新物件）都會把使用者剛取消的勾選整批重設回全勾。
  const extrasKnownRef = useRef<Set<string>>(new Set());
  const loadExtras = useCallback(async (resetPicked: boolean) => {
    const rows = await fetchExtraCharges(booking.id);
    const active = rows.filter((r) => !r.voided_at);
    setExtras(active);
    const unpaidIds = active.filter((r) => !r.is_paid).map((r) => r.id);
    // 追加款收款：預設全勾（通常是一起收的），沒收到的自己取消勾選；重新載入時保留使用者已經做的選擇，新出現的預設勾選
    setExtrasPicked((prev) => (resetPicked ? unpaidIds : [...prev.filter((id) => unpaidIds.includes(id)), ...unpaidIds.filter((id) => !prev.includes(id) && !extrasKnownRef.current.has(id))]));
    extrasKnownRef.current = new Set(active.map((r) => r.id));
  }, [booking.id]);
  useEffect(() => {
    if (!open) return;
    setExtras([]); setExtrasPicked([]); setExtrasError(''); setUnpaidOverride(null); extrasKnownRef.current = new Set();
    // 會計的關卡都看得到追加款明細（尾款裡含了多少、還有哪些沒收）
    if (stage.money === 'full') loadExtras(true);
  }, [open, booking.id, stage.key, stage.money, loadExtras]);

  const resetLinen = () => {
    if (!linen) return;
    setLinen({ ...linen, usage: computeUsage(linen.roomIds, linen.defaults, normalizeChangeCount(booking.linen_change_count), linen.items) });
    enqueueSnackbar('已回復為房型預設用量', { variant: 'info' });
  };
  const setQty = (item: LinenItem, qty: number) => {
    if (!linen) return;
    const others = linen.usage.filter((u) => u.linen_item_id !== item.id);
    setLinen({ ...linen, usage: qty > 0 ? [...others, { linen_item_id: item.id, quantity: qty, unit_price: item.unit_price ?? 0, is_manual: true }] : others });
  };

  const run = async (advance: boolean) => {
    if (!canAct) return;
    if (has('remit') && !remit.trim()) { setRemitError('請先填寫匯款末5碼'); return; }
    if (has('extras') && !extrasPicked.length) { setExtrasError('請勾選已經收到的追加款'); return; }
    setBusy(true);
    try {
      const patch: StageEditPatch = { notes: notes.trim() || null };
      if (has('balance_remit')) patch.balance_remit_last5 = remit.trim() || null;
      if (has('password')) patch.check_in_password = password.trim() || null;
      if (has('refund')) { patch.refund_amount = refund === '' ? null : Number(refund); patch.refund_note = refundNote.trim() || null; }
      if (has('damage')) {
        patch.damage_found = damaged;
        patch.damage_deduction = damaged && deduction !== '' ? Number(deduction) : damaged ? 0 : null;
        patch.damage_note = damageNote.trim() || null;
      }
      await saveStageEdits(booking, patch);
      if (linen) await saveBookingLinen(booking.id, linen.roomIds, linen.usage, true);
      let updated: BookingRow = { ...booking, ...patch } as BookingRow;
      // 追加款：這一關勾的收款；尾款確認時，尾款裡含的未付追加款就是一起收了，一併標成已付
      // （不然確認完尾款，那幾筆還是未付，尾款又冒出一筆沒收的錢）。只標開視窗時看到的那幾筆，
      // 視窗開著期間別人新增的不算在這次收的錢裡。
      const unpaidShown = extras.filter((r) => !r.is_paid).map((r) => r.id);
      const toMark = has('extras') ? extrasPicked : stage.key === 'awaiting_balance' ? unpaidShown : [];
      if (toMark.length) {
        await setExtraChargesPaid(booking.id, toMark, true);
        setExtras((prev) => prev.map((r) => (toMark.includes(r.id) ? { ...r, is_paid: true } : r)));
        const markedTotal = extras.filter((r) => toMark.includes(r.id)).reduce((sum, r) => sum + r.amount, 0);
        updated = { ...updated, extra_unpaid_total: Math.max(0, Number(shown.extra_unpaid_total || 0) - markedTotal) };
      }
      if ((advance || stage.confirmAdvances) && stage.nextStatus) {
        await advanceBookingStatus(updated, stage.nextStatus, { remitLast5: remit.trim(), skipExtraCharges: true });
        updated = { ...updated, status: stage.nextStatus, ...(has('remit') ? { remit_last5: remit.trim() } : {}) };
      }
      await markStageConfirmed(booking.id, stage.key, profile?.email || profile?.id || 'unknown');
      onChanged(updated);
      setDone(updated);
      enqueueSnackbar(advance || stage.confirmAdvances ? `已確認，訂單進入「${bookingStatusLabel(updated.status)}」` : '已確認', { variant: 'success' });
    } catch (e: any) {
      enqueueSnackbar(e instanceof BookingActionError ? e.message : `儲存失敗：${e.message}`, { variant: 'error' });
    } finally { setBusy(false); }
  };

  const showAddExtra = canAddExtras && !['cancelled', 'awaiting_refund', 'refunded', 'external_synced'].includes(booking.status);
  // 新增後重抓明細，並把訂單的未付合計（資料庫觸發器維護）同步給上層，尾款金額才會跟著變
  const onExtrasAdded = async () => {
    setAddingExtra(false);
    const rows = (await fetchExtraCharges(booking.id)).filter((r) => !r.voided_at);
    setExtras(rows);
    setExtrasPicked((prev) => {
      const unpaid = rows.filter((r) => !r.is_paid).map((r) => r.id);
      return [...prev.filter((id) => unpaid.includes(id)), ...unpaid.filter((id) => !extrasKnownRef.current.has(id))];
    });
    extrasKnownRef.current = new Set(rows.map((r) => r.id));
    setUnpaidOverride(rows.filter((r) => !r.is_paid).reduce((sum, r) => sum + r.amount, 0));
  };

  const balance = computeBalanceDue(shown);
  const nights = booking.nights ?? null;
  const stageAmount = stage.amountOf(shown);
  const damage = damageSummary(booking);

  const header = (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 2.5, py: 1.5, borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
        <Chip label={stage.action} size="small" sx={{ bgcolor: stage.color, color: '#fff', fontWeight: 600 }} />
        <Typography variant="h6" noWrap sx={{ fontFamily: 'monospace', fontSize: 16 }}>{booking.order_number}</Typography>
        <StatusBadge status={(done || booking).status} />
      </Stack>
      <IconButton size="small" onClick={onClose} aria-label="關閉" disabled={busy}><X size={18} /></IconButton>
    </Box>
  );

  const info = (
    <Stack spacing={2.5}>
      <Box>
        <Typography variant="subtitle2" gutterBottom>訂房資訊</Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
          <Field label="客人" value={<>{booking.name || booking.nickname || '未取得'}{booking.phone ? <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>{booking.phone}</Typography> : null}</>} />
          <Field label="入住 → 退房" value={`${formatDateRange(booking.checkin_date, booking.checkout_date)}${nights ? `（${nights} 晚）` : ''}`} />
          <Field label="人數" value={booking.headcount != null ? `${booking.headcount} 人` : '—'} />
          <Field label="房型" value={booking.room_type_label || (booking.whole_house ? '包棟' : '—')} />
        </Box>
      </Box>

      {stage.money === 'full' ? (
        <Box>
          <Typography variant="subtitle2" gutterBottom>金額</Typography>
          {stage.amountLabel && (
            <Box sx={{ mb: 1.5, px: 1.5, py: 1, borderRadius: 1, bgcolor: stage.colorLight, display: 'inline-flex', alignItems: 'baseline', gap: 1 }}>
              <Typography variant="caption" sx={{ color: stage.color, fontWeight: 600 }}>{stage.amountLabel}</Typography>
              <Typography variant="h6" sx={{ color: stage.color, fontWeight: 700 }}>{formatMoney(stageAmount)}</Typography>
            </Box>
          )}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.5 }}>
            <Field label="總額" value={formatMoney(booking.total_amount)} />
            <Field label="訂金" value={formatMoney(booking.deposit)} />
            <Field label="尾款" value={balance != null ? formatMoney(balance) : '—'} />
            <Field label="押金" value={formatMoney(booking.security_deposit)} />
            {canSeePayment && !has('remit') && <Field label="訂金末五碼" value={booking.remit_last5 || '—'} mono />}
            {canSeePayment && !has('balance_remit') && booking.balance_remit_last5 && <Field label="尾款末五碼" value={booking.balance_remit_last5} mono />}
            {booking.payment_deadline_at && stage.key === 'awaiting_confirmation' && <Field label="匯款期限" value={formatDateTime(booking.payment_deadline_at)} />}
          </Box>
        </Box>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
          <Field label="訂單總額" value={formatMoney(booking.total_amount)} />
          {booking.guest_notes && <Field label="顧客備註" value={booking.guest_notes} />}
        </Box>
      )}

      {stage.money === 'full' && (extras.length > 0 || showAddExtra) && (
        <Box>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="subtitle2" gutterBottom>追加款</Typography>
            {showAddExtra && <Button size="small" startIcon={<Plus size={14} />} onClick={() => setAddingExtra(true)}>增加追加項目</Button>}
          </Stack>
          <Stack spacing={0.25}>
            {extras.map((r) => {
              const pickable = has('extras') && !r.is_paid;
              return (
                <Stack key={r.id} direction="row" spacing={1} alignItems="center">
                  {pickable ? (
                    <Checkbox size="small" sx={{ p: 0.25 }} checked={extrasPicked.includes(r.id)} disabled={!canAct}
                      onChange={(e) => { setExtrasError(''); setExtrasPicked((prev) => e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id)); }} />
                  ) : null}
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'text.secondary', whiteSpace: 'nowrap' }}>{extraChargeCode(booking.order_number, r.seq)}</Typography>
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>{r.title}</Typography>
                  <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>{formatMoney(r.amount)}</Typography>
                  <Chip size="small" label={r.is_paid ? '已付' : '未付'} color={r.is_paid ? 'success' : 'warning'} variant="outlined" sx={{ height: 20, fontSize: 11 }} />
                </Stack>
              );
            })}
          </Stack>
          {stage.key === 'awaiting_balance' && hasUnpaidExtraCharges(shown) && <Typography variant="caption" color="text.secondary">應收尾款已含未付追加款 {formatMoney(shown.extra_unpaid_total)}，確認尾款時會一併標成已付。</Typography>}
          {extrasError && <Typography variant="caption" color="error" component="div">{extrasError}</Typography>}
        </Box>
      )}

      {/* 押金退掉之後就很難再跟客人收，這是最後一道提醒 */}
      {stage.key === 'deposit_processing' && hasUnpaidExtraCharges(shown) && (
        <Alert severity="warning" sx={{ py: 0.5 }}>還有 <b>{formatMoney(shown.extra_unpaid_total)}</b> 追加款未收。要從押金扣抵的話，請自己調整下面的實退金額並寫在退款說明。</Alert>
      )}

      {/* 押金退款要看得到房務回報了什麼，不用自己跑去問 */}
      {stage.key === 'deposit_processing' && (
        <Alert severity={damage.checked ? (booking.damage_found ? 'warning' : 'success') : 'info'} icon={false} sx={{ py: 0.75 }}>
          <Typography variant="body2" fontWeight={600}>{damage.label}</Typography>
          {booking.damage_note && <Typography variant="caption" color="text.secondary">{booking.damage_note}</Typography>}
          {!damage.checked && <Typography variant="caption" color="text.secondary">房務還沒回報，實退金額預設為全額，確定要退再按確認。</Typography>}
        </Alert>
      )}
    </Stack>
  );

  const editor = (
    <Stack spacing={2}>
      <Alert severity="info" icon={false} sx={{ bgcolor: stage.colorLight, color: 'text.primary', fontSize: 13 }}>{stage.hint}</Alert>

      {(has('remit') || has('balance_remit')) && (
        <TextField
          label={has('remit') ? '訂金匯款末5碼' : '尾款匯款末5碼'} value={remit}
          onChange={(e) => { setRemit(e.target.value.replace(/\D/g, '').slice(0, 5)); setRemitError(''); }}
          error={!!remitError} helperText={remitError || (has('balance_remit') ? '預設帶訂金那一組，不同請改掉' : '核對到帳後填入，會寫進訂單')}
          inputProps={{ inputMode: 'numeric', maxLength: 5 }} required={has('remit')} disabled={!canAct} sx={{ maxWidth: 260 }}
        />
      )}

      {has('refund') && (
        <Stack spacing={1.5}>
          <TextField
            label="實退金額" type="number" value={refund} onChange={(e) => setRefund(e.target.value)} disabled={!canAct}
            InputProps={{ startAdornment: <InputAdornment position="start">NT$</InputAdornment> }} inputProps={{ min: 0, inputMode: 'numeric' }}
            helperText={`應退 ${formatMoney(stageAmount)}${stage.key === 'deposit_processing' && damage.deduction > 0 ? `，已扣房務建議的 ${formatMoney(damage.deduction)}` : ''}`}
            sx={{ maxWidth: 260 }}
          />
          <TextField label="退款說明（選填）" value={refundNote} onChange={(e) => setRefundNote(e.target.value)} disabled={!canAct} placeholder="例如：扣除清潔費 500" fullWidth />
        </Stack>
      )}

      {has('password') && (
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <TextField
            label="入住密碼" value={password} onChange={(e) => setPassword(e.target.value)} disabled={!canAct}
            helperText="大門／房門密碼，排程會用 [入住密碼] 發給客人" inputProps={{ inputMode: 'numeric' }}
            sx={{ maxWidth: 200, '& input': { fontSize: 24, letterSpacing: 4, fontFamily: 'monospace' } }}
          />
          <Button size="small" startIcon={<Shuffle size={14} />} onClick={() => setPassword(String(Math.floor(1000 + Math.random() * 9000)))} disabled={!canAct} sx={{ mt: 1.5 }}>隨機</Button>
        </Stack>
      )}

      {has('damage') && (
        <Stack spacing={1.5}>
          <Box>
            <Typography variant="body2" sx={{ mb: 0.75 }}>房間狀況</Typography>
            <ToggleButtonGroup
              exclusive size="small" value={damaged === null ? null : damaged ? 'yes' : 'no'} disabled={!canAct}
              onChange={(_, v) => { if (v === null) return; setDamaged(v === 'yes'); if (v === 'no') setDeduction(''); }}
            >
              <ToggleButton value="no" sx={{ px: 2.5, '&.Mui-selected': { bgcolor: 'success.light', color: 'success.dark' } }}>正常</ToggleButton>
              <ToggleButton value="yes" sx={{ px: 2.5, '&.Mui-selected': { bgcolor: 'warning.light', color: 'warning.dark' } }}>有損壞</ToggleButton>
            </ToggleButtonGroup>
          </Box>
          {damaged && (
            <TextField
              label="建議扣款" type="number" value={deduction} onChange={(e) => setDeduction(e.target.value)} disabled={!canAct}
              InputProps={{ startAdornment: <InputAdornment position="start">NT$</InputAdornment> }} inputProps={{ min: 0, inputMode: 'numeric' }}
              helperText={`押金 ${formatMoney(booking.security_deposit)}，會計退款時會自動扣掉這個金額`} sx={{ maxWidth: 260 }}
            />
          )}
          <TextField label={damaged ? '損壞說明' : '房況說明（選填）'} value={damageNote} onChange={(e) => setDamageNote(e.target.value)} disabled={!canAct} multiline minRows={2} fullWidth placeholder={damaged ? '例如：浴室玻璃杯破一個' : ''} />
        </Stack>
      )}

      {has('linen') && (
        <Box>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="subtitle2">洗物數量</Typography>
            <Button size="small" startIcon={<RotateCcw size={14} />} onClick={resetLinen} disabled={!linen || !canAct}>回復預設</Button>
          </Stack>
          {linenLoading || !linen ? <Skeleton variant="rounded" height={120} /> : linen.items.length === 0 ? (
            <Typography variant="body2" color="text.disabled">尚未建立任何布巾品項。</Typography>
          ) : (
            <Box>
              {linen.items.map((it) => (
                <QtyStepper key={it.id} label={linenItemLabel(it)} value={linen.usage.find((u) => u.linen_item_id === it.id)?.quantity ?? 0} onChange={(v) => setQty(it, v)} disabled={!canAct} />
              ))}
            </Box>
          )}
          {/* 沒有房間就算不出預設用量。第三方平台匯入的包棟訂單一定是這種（OTA 的 iCal 不帶房間資訊），
              所以直接在這裡給選，房務不用再去找有訂單編輯權限的人。只開放給本來就沒有房間的訂單。 */}
          {linen && roomsWereEmptyRef.current && (
            <Box sx={{ mt: 1.5, p: 1.5, border: 1, borderColor: 'warning.light', borderRadius: 1, bgcolor: 'warning.lighter' }}>
              <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mb: 1 }}>
                這筆訂單還沒連結房間，「回復預設」算不出用量。選好這次要備的房間後再按一次「回復預設」。
              </Typography>
              <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75}>
                {rooms.map((r) => {
                  const picked = linen.roomIds.includes(r.id);
                  return (
                    <Chip
                      key={r.id}
                      size="small"
                      label={roomLabel(r)}
                      color={picked ? 'primary' : 'default'}
                      variant={picked ? 'filled' : 'outlined'}
                      onClick={canAct ? () => setLinen({
                        ...linen,
                        roomIds: picked ? linen.roomIds.filter((id) => id !== r.id) : [...linen.roomIds, r.id],
                      }) : undefined}
                      disabled={!canAct}
                    />
                  );
                })}
              </Stack>
              {rooms.length > 0 && (
                <Button
                  size="small"
                  sx={{ mt: 0.5 }}
                  disabled={!canAct}
                  onClick={() => setLinen({ ...linen, roomIds: linen.roomIds.length === rooms.length ? [] : rooms.map((r) => r.id) })}
                >
                  {linen.roomIds.length === rooms.length ? '全部取消' : '整棟全選'}
                </Button>
              )}
            </Box>
          )}
          {linen && !roomsWereEmptyRef.current && linen.roomIds.length === 0 && (
            <Typography variant="caption" color="warning.main">這筆訂單還沒連結房間，「回復預設」算不出用量；請先到訂單編輯勾選房間。</Typography>
          )}
        </Box>
      )}

      <TextField label="內部備註" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} disabled={!canAct} helperText="只有後台看得到，不會發給客人" />
      {!canAct && <Alert severity="info">你沒有「{stage.action}」的權限，只能查看。</Alert>}
    </Stack>
  );

  const doneView = done && (
    <Stack spacing={2} alignItems="center" sx={{ py: 3, textAlign: 'center' }}>
      <Box sx={{ width: 56, height: 56, borderRadius: '50%', bgcolor: 'success.light', color: 'success.dark', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={28} /></Box>
      <Typography variant="h6">已確認</Typography>
      <Typography variant="body2" color="text.secondary">
        訂單目前狀態：<StatusBadge status={done.status} />
        {stage.key === 'room_check' ? '。會計的「押金退款」已經看得到你的回報。' : canNotify ? '。接下來可以把結果通知客人。' : ''}
      </Typography>
      {action?.notified_at && canNotify && <Typography variant="caption" color="text.secondary">這一關已於 {formatDateTime(action.notified_at)} 通知過客人（{action.template_title || '自訂內容'}），可再發一次。</Typography>}
      {canNotify && (
        <Tooltip title={!booking.line_user_id ? '這筆訂單沒有 LINE 帳號，無法推播' : ''}><span>
          <Button variant="contained" size="large" startIcon={<Send size={18} />} onClick={() => onNotify(done, stage)} disabled={!booking.line_user_id} sx={{ bgcolor: stage.color, '&:hover': { bgcolor: stage.color, filter: 'brightness(.92)' } }}>{stage.notifyLabel || '訊息發送'}</Button>
        </span></Tooltip>
      )}
      <Button color="inherit" onClick={onClose}>{canNotify ? '稍後再發，關閉' : '關閉'}</Button>
    </Stack>
  );

  const footer = !done && (
    <Box sx={{ px: 2.5, py: 1.5, borderTop: '1px solid', borderColor: 'divider', display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap', flexShrink: 0 }}>
      <Button color="inherit" onClick={onClose} disabled={busy}>取消</Button>
      {/* 高亮動作鈕就是「確認」：清單上按的是哪顆，視窗裡按的就是同一顆 */}
      <Button variant="contained" onClick={() => run(false)} disabled={busy || !canAct} startIcon={<Check size={16} />} sx={{ bgcolor: stage.color, fontWeight: 600, boxShadow: 'none', '&:hover': { bgcolor: stage.color, filter: 'brightness(.92)', boxShadow: 'none' } }}>
        {busy ? '處理中…' : stage.confirmAdvances ? `${stage.action}（→ ${bookingStatusLabel(stage.nextStatus)}）` : stage.action}
      </Button>
      {stage.nextStatus && !stage.confirmAdvances && (
        <Button variant="outlined" onClick={() => run(true)} disabled={busy || !canAct} endIcon={<ArrowRight size={16} />} sx={{ color: stage.color, borderColor: stage.color, '&:hover': { borderColor: stage.color, bgcolor: stage.colorLight } }}>
          並推進到「{bookingStatusLabel(stage.nextStatus)}」
        </Button>
      )}
    </Box>
  );

  // 外層這個 Box 也要 minHeight: 0。它自己是 DialogContent 的 flex 子項，height:100% 只是
  // 「基準高度」，min-height: auto 一樣會讓它撐到內容的完整高度、溢出的部分被 overflow:hidden 切掉。
  // 只在裡面那層加不夠——外層先撐開了，裡面就永遠分不到「需要捲動」的狀態。
  const content = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {header}
      {/* minHeight: 0 不能省。flex 子項的 min-height 預設是 auto，也就是「不准縮得比內容還小」，
          所以 flex: 1 + overflow: auto 其實不會捲動——這一塊會撐到內容的完整高度，把下面的
          頁尾（確認鈕）連同超出的內容一起擠到對話框外面。畫面高度夠的時候看不出來，
          筆電的 650px 左右就會發生：洗物數量在最底下，剛好是被擠出去看不到的那一段。 */}
      <Box sx={{ p: 2.5, overflow: 'auto', flex: 1, minHeight: 0 }}>
        {done ? doneView : (
          <Stack spacing={3}>
            {info}
            <Divider />
            {editor}
          </Stack>
        )}
      </Box>
      {footer}
    </Box>
  );

  return (
    <>
      <Dialog open={open} onClose={busy ? undefined : onClose} fullScreen={isMobile} maxWidth="sm" fullWidth PaperProps={{ sx: isMobile ? {} : { maxHeight: '90vh' } }}>
        <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{content}</DialogContent>
      </Dialog>
      <AddExtraChargesDialog
        open={addingExtra} booking={booking} charges={extras} canMarkPaid={canVerifyPayment}
        onClose={() => setAddingExtra(false)}
        onSaved={(notice) => { if (notice) enqueueSnackbar(notice, { variant: notice.startsWith('未通知') ? 'warning' : 'info' }); void onExtrasAdded(); }}
      />
    </>
  );
}

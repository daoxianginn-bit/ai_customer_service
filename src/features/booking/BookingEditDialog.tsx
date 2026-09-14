import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControlLabel,
  Grid, IconButton, Link, MenuItem, Paper, Stack, Checkbox, Table, TableBody, TableCell, TableFooter,
  TableHead, TableRow, TextField, Tooltip, Typography, type TextFieldProps,
} from '@mui/material';
import { RefreshCw, X } from 'lucide-react';
import {
  BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUSES, REQUIRES_REMIT_LAST5_STATUS, CHECKIN_PASSWORD_STATUSES,
  FLOW_STEP_STATUSES, flowStepIndex, bookingStatusLabel, nextFlowStatus, MANUAL_ACTION_STATUSES,
} from '../../lib/bookingStatus';
import { computeOrderAmounts } from '../../lib/messageVariables';
import {
  LinenItem, RoomLinenDefault, LinenUsageRow,
  linenItemLabel, nightsBetween, computeUsage, mergeUsage, usageTotal, normalizeChangeCount,
} from '../../lib/linenCost';
import { RoomOption, roomLabel } from '../../lib/rooms';
import { formatDateTime, formatMoney } from '../../lib/format';
import { useBreakpoint } from '../../app/useBreakpoint';
import { usePermission } from '../../app/Can';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import { fetchLinenSetup, fetchMoneyDefaults, fetchRooms, fetchBookingLinen, type BookingRow } from './bookingQueries';
import { logBookingSaveFailed, logBookingSaved, saveBookingLinen, upsertBooking } from './bookingActions';

// ========================================================================
// 訂單編輯對話框（V2 §22、§97）。從舊的 OrderManagement.tsx 抽出來，表單狀態、金額重算、
// 房間／布巾用量、存檔與操作紀錄的邏輯原封不動；只有外觀換成 MUI，手機整頁顯示。
//
// 列表頁（新增／編輯）與詳情頁（編輯）共用；`booking` 為 null 代表新增。
// ========================================================================

interface OrderForm {
  id?: string;
  order_number?: string;
  created_at?: string; // 唯讀顯示用，不可編輯，新增訂單時還沒有值
  name: string;
  nickname: string;
  line_user_id: string;
  phone: string;
  checkin_date: string;
  checkout_date: string;
  headcount: string;
  adults: string;
  kids: string;
  infants: string;
  whole_house: boolean;
  room_type_label: string;
  room_amount: string;
  security_deposit: string;
  total_amount: string;
  deposit: string;
  remit_last5: string;
  check_in_password: string;
  status: string;
  guest_notes: string;
  notes: string;
  linen_change_count: string;
}

const emptyForm = (): OrderForm => ({
  name: '', nickname: '', line_user_id: '', phone: '',
  checkin_date: '', checkout_date: '', headcount: '', adults: '', kids: '', infants: '',
  whole_house: true, room_type_label: '', room_amount: '', security_deposit: '', total_amount: '', deposit: '', remit_last5: '',
  check_in_password: '', status: 'inquiring', guest_notes: '', notes: '', linen_change_count: '1',
});

function rowToForm(row: BookingRow): OrderForm {
  return {
    id: row.id,
    order_number: row.order_number || '',
    created_at: row.created_at || '',
    name: row.name || '',
    nickname: row.nickname || '',
    line_user_id: row.line_user_id || '',
    phone: row.phone || '',
    checkin_date: row.checkin_date || '',
    checkout_date: row.checkout_date || '',
    headcount: row.headcount != null ? String(row.headcount) : '',
    adults: row.adults != null ? String(row.adults) : '',
    kids: row.kids != null ? String(row.kids) : '',
    infants: row.infants != null ? String(row.infants) : '',
    whole_house: !!row.whole_house,
    room_type_label: row.room_type_label || '',
    // 舊訂單沒有 room_amount，改版前 total_amount 存的就是房價，直接沿用當房價
    room_amount: String(row.room_amount ?? row.total_amount ?? ''),
    security_deposit: String(row.security_deposit ?? ''),
    total_amount: row.total_amount != null ? String(row.total_amount) : '',
    deposit: row.deposit != null ? String(row.deposit) : '',
    remit_last5: row.remit_last5 || '',
    check_in_password: row.check_in_password || '',
    status: row.status,
    guest_notes: row.guest_notes || '',
    notes: row.notes || '',
    linen_change_count: String(row.linen_change_count ?? 1),
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, md: 2 } }}>
      <Typography variant="subtitle2" sx={{ mb: 1.5 }}>{title}</Typography>
      {children}
    </Paper>
  );
}

interface Props {
  open: boolean;
  /** null＝新增訂單 */
  booking: BookingRow | null;
  onClose: () => void;
  onSaved: (bookingId: string) => void;
}

export default function BookingEditDialog({ open, booking, onClose, onSaved }: Props) {
  const { isMobile } = useBreakpoint();
  // 狀態相關的按鈕依權限顯示：推進／指定狀態＝確認付款、取消＝取消訂單；沒有權限的人只能改資料
  const canAdvance = usePermission('booking.payment.verify');
  const canCancel = usePermission('booking.cancel');
  const editingId = booking?.id ?? null;

  // 查詢用的參考資料：房間、布巾、押金／訂金比例預設。掛載時抓一次，之後每次開啟共用。
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [linenItems, setLinenItems] = useState<LinenItem[]>([]);
  const [linenDefaults, setLinenDefaults] = useState<RoomLinenDefault[]>([]);
  const [moneyDefaults, setMoneyDefaults] = useState({ wholeHouseSecurity: 3000, percent: 30 });
  const [lookupsReady, setLookupsReady] = useState(false);

  useEffect(() => {
    (async () => {
      const [r, linen, money] = await Promise.all([fetchRooms(), fetchLinenSetup(), fetchMoneyDefaults()]);
      setRooms(r);
      setLinenItems(linen.items);
      setLinenDefaults(linen.defaults);
      setMoneyDefaults(money);
      setLookupsReady(true);
    })();
  }, []);

  const [form, setForm] = useState<OrderForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [usageRows, setUsageRows] = useState<LinenUsageRow[]>([]);
  // 打開表單載入既有資料時不要馬上重算，否則會把之前的人工調整蓋掉
  const skipRecompute = useRef(true);
  // 開啟當下的原始資料快照，存檔時比對出「這次到底改了什麼」寫進操作紀錄。
  // 不能存檔後再回查一次資料庫——那時候查到的已經是改完的新值，比對出來永遠是沒有差異。
  const originalRef = useRef<BookingRow | null>(null);
  const initialisedKey = useRef<string | null>(null);

  // 每次開啟（或換一張訂單）就重新初始化表單；參考資料還沒回來前先等，新增訂單要靠它帶預設押金與房間。
  useEffect(() => {
    if (!open || !lookupsReady) { if (!open) initialisedKey.current = null; return; }
    const key = editingId ?? '__new__';
    if (initialisedKey.current === key) return;
    initialisedKey.current = key;
    setFormError('');
    if (booking) {
      originalRef.current = booking;
      setForm(rowToForm(booking));
      fetchBookingLinen(booking.id).then(({ roomIds, usage }) => {
        skipRecompute.current = true;
        setSelectedRoomIds(roomIds);
        setUsageRows(usage);
      });
    } else {
      originalRef.current = null;
      // 新訂單一開始就是包棟（emptyForm 的 whole_house 是 true），押金欄位直接帶入包棟押金，
      // 不要只放在 placeholder 裡當提示——欄位留空存檔會被存成 0，畫面上看到 3000、實際存 0。
      setForm({ ...emptyForm(), security_deposit: String(moneyDefaults.wholeHouseSecurity) });
      // 新訂單預設「是否包棟」為勾選狀態，房間也跟著預設全選。這是全新訂單，沒有既有資料要保護，
      // skipRecompute 設 false 讓下面的 effect 直接算出預設布巾組合。
      skipRecompute.current = false;
      setSelectedRoomIds(rooms.map((r) => r.id));
      setUsageRows([]);
    }
  }, [open, editingId, booking, lookupsReady, rooms, moneyDefaults.wholeHouseSecurity]);

  // 換房間或改換洗次數才重算；已手動調整過的品項由 mergeUsage 保留。
  // 日期不在依賴裡：換洗次數改由使用者自己填，晚數只是給他參考的提示。
  useEffect(() => {
    if (skipRecompute.current) { skipRecompute.current = false; return; }
    const times = normalizeChangeCount(Number(form.linen_change_count));
    setUsageRows((prev) => mergeUsage(prev, computeUsage(selectedRoomIds, linenDefaults, times, linenItems)));
  }, [selectedRoomIds, form.linen_change_count, linenDefaults, linenItems]);

  // 押金預設值：包棟用「訂房規則」裡的包棟押金；個別租房用目前勾選房間的押金加總。
  const computeDefaultSecurityDeposit = (wholeHouse: boolean, roomIds: string[]) =>
    wholeHouse
      ? moneyDefaults.wholeHouseSecurity
      : roomIds.reduce((sum, id) => sum + Number(rooms.find((r) => r.id === id)?.security_deposit ?? 0), 0);

  const defaultSecurityDeposit = computeDefaultSecurityDeposit(form.whole_house, selectedRoomIds);

  // 依房價重算其餘三個金額，用的是跟 LINE 自動報價同一個函式，人工建單才不會算出不同的數字；
  // 管理員仍可在「押金」欄位手動覆蓋這個預設值。
  const recalcAmounts = () => {
    const room = Number(form.room_amount);
    if (!Number.isFinite(room) || room <= 0) {
      setFormError('請先填房價，才能重算訂單總額與訂金。');
      return;
    }
    const security = form.security_deposit === '' ? defaultSecurityDeposit : Number(form.security_deposit);
    const amounts = computeOrderAmounts(room, security, moneyDefaults.percent);
    setFormError('');
    setForm((f) => ({
      ...f,
      security_deposit: String(amounts.security_deposit),
      total_amount: String(amounts.total_amount),
      deposit: String(amounts.deposit),
    }));
  };

  const toggleRoom = (roomId: string) => {
    setSelectedRoomIds((prev) => (prev.includes(roomId) ? prev.filter((r) => r !== roomId) : [...prev, roomId]));
  };

  const setUsageQuantity = (linenItemId: string, quantity: number) => {
    setUsageRows((prev) => {
      const found = prev.find((r) => r.linen_item_id === linenItemId);
      if (found) {
        return prev.map((r) => (r.linen_item_id === linenItemId ? { ...r, quantity, is_manual: true } : r));
      }
      const price = linenItems.find((i) => i.id === linenItemId)?.unit_price ?? 0;
      return [...prev, { linen_item_id: linenItemId, quantity, unit_price: price, is_manual: true }];
    });
  };

  const resetUsageToDefaults = () => {
    setUsageRows(computeUsage(selectedRoomIds, linenDefaults, normalizeChangeCount(Number(form.linen_change_count)), linenItems));
  };

  // overrideStatus：「儲存並前往下一階段」「取消訂單」用的，帶入這次要寫進去的狀態。
  // 不先 setForm 再存——setState 是非同步的，這一輪讀到的還會是舊狀態。
  const saveForm = async (overrideStatus?: string) => {
    const targetStatus = overrideStatus ?? form.status;
    if (targetStatus === REQUIRES_REMIT_LAST5_STATUS && !form.remit_last5.trim()) {
      setFormError('狀態改成「已預定」時，請先填寫匯款末5碼再儲存。');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const checkin = form.checkin_date || null;
      const checkout = form.checkout_date || null;
      let nights: number | null = null;
      if (checkin && checkout) {
        const diff = Math.round((new Date(`${checkout}T00:00:00`).getTime() - new Date(`${checkin}T00:00:00`).getTime()) / 86400000);
        nights = diff > 0 ? diff : null;
      }

      const payload = {
        name: form.name || null,
        nickname: form.nickname || null,
        line_user_id: form.line_user_id || '',
        phone: form.phone || null,
        checkin_date: checkin,
        checkout_date: checkout,
        nights,
        headcount: form.headcount === '' ? null : Number(form.headcount),
        adults: form.adults === '' ? null : Number(form.adults),
        kids: form.kids === '' ? null : Number(form.kids),
        infants: form.infants === '' ? null : Number(form.infants),
        whole_house: form.whole_house,
        // 房型改由勾選房間決定，這個欄位變成顯示用的摘要（列表、篩選、訊息變數都還在用）。
        // 一間房都沒選時保留原本手打的文字，避免舊訂單的房型資訊被清空。
        room_type_label: selectedRoomIds.length
          ? rooms.filter((r) => selectedRoomIds.includes(r.id)).map(roomLabel).join('、')
          : form.room_type_label || null,
        linen_change_count: normalizeChangeCount(Number(form.linen_change_count)),
        room_amount: form.room_amount === '' ? null : Number(form.room_amount),
        // 留空時存的是畫面上 placeholder 顯示的那個預設金額，不是 0。
        security_deposit: form.security_deposit === '' ? defaultSecurityDeposit : Number(form.security_deposit),
        total_amount: form.total_amount === '' ? null : Number(form.total_amount),
        deposit: form.deposit === '' ? null : Number(form.deposit),
        remit_last5: form.remit_last5 || null,
        // 只有「待入住」「入住中」才允許有值——不是這些狀態時一律清空，不要讓舊密碼在不該生效的狀態下還留著。
        check_in_password: CHECKIN_PASSWORD_STATUSES.includes(targetStatus) ? (form.check_in_password || null) : null,
        status: targetStatus,
        guest_notes: form.guest_notes || null,
        notes: form.notes || null,
        updated_at: new Date().toISOString(),
      };

      const { id, orderNumber } = await upsertBooking(editingId, payload);
      await saveBookingLinen(id, selectedRoomIds, usageRows, linenItems.length > 0);
      await logBookingSaved({ editingId, original: originalRef.current, payload, orderNumber: editingId ? (form.order_number || '') : orderNumber });
      onSaved(id);
    } catch (err: any) {
      setFormError(`儲存失敗：${err.message}`);
      await logBookingSaveFailed(editingId, form.order_number || null, err);
    } finally {
      setSaving(false);
    }
  };

  // 系統專用狀態不開放手動選，但如果這張訂單「現在剛好就是」系統專用狀態，下拉還是要能顯示目前值。
  const currentSystemOnlyStatus = SYSTEM_ONLY_STATUSES.find((s) => s.value === form.status);
  const formStatusOptions = currentSystemOnlyStatus ? [currentSystemOnlyStatus, ...BOOKING_STATUS_OPTIONS] : BOOKING_STATUS_OPTIONS;

  const field = (key: keyof OrderForm, label: string, extra: Partial<TextFieldProps> = {}) => (
    <TextField
      fullWidth
      size="small"
      label={label}
      value={form[key] as string}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      {...extra}
    />
  );

  const step = flowStepIndex(form.status);
  const next = nextFlowStatus(form.status);

  const statusPanel = (
    <Paper variant="outlined" sx={{ p: 2, position: { lg: 'sticky' }, top: { lg: 8 } }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="caption" color="text.secondary">訂單狀態</Typography>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 0.5 }}>
            <StatusBadge status={form.status} />
            <Typography variant="caption" color="text.secondary">
              {step ? `流程 ${step}/${FLOW_STEP_STATUSES.length}` : '例外流程'}
            </Typography>
          </Stack>
        </Box>

        <Box>
          <Typography variant="caption" color="text.secondary">本次訂單總額</Typography>
          <Typography variant="h4" sx={{ mt: 0.25 }}>{form.total_amount === '' ? '—' : formatMoney(form.total_amount)}</Typography>
        </Box>

        {/* 只顯示前一關／目前這關／下一關：編輯畫面要回答的是「現在在哪、下一步是什麼」。 */}
        {step && (
          <Box>
            <Typography variant="caption" color="text.secondary">目前流程</Typography>
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.5 }}>
              {FLOW_STEP_STATUSES.map((s, i) => {
                const n = i + 1;
                if (n < step - 1 || n > step + 1) return null;
                const current = n === step;
                return (
                  <Box key={s} sx={{ flex: 1, textAlign: 'center', borderRadius: 1, border: '2px solid', borderColor: current ? 'primary.main' : 'divider', bgcolor: current ? 'primary.light' : 'transparent', px: 1, py: 0.75 }}>
                    <Typography variant="caption" sx={{ fontWeight: 700, color: current ? 'primary.dark' : 'text.disabled', display: 'block' }}>{n}</Typography>
                    <Typography variant="caption" noWrap sx={{ display: 'block' }}>{bookingStatusLabel(s)}</Typography>
                  </Box>
                );
              })}
            </Stack>
          </Box>
        )}

        <Stack spacing={1}>
          {canAdvance && next && (
            <Button fullWidth variant="contained" onClick={() => saveForm(next)} disabled={saving}>
              儲存並前往「{bookingStatusLabel(next)}」
            </Button>
          )}
          {canCancel && form.status !== 'cancelled' && (
            <Button fullWidth variant="outlined" color="error" startIcon={<X size={16} />} onClick={() => saveForm('cancelled')} disabled={saving}>
              取消訂單
            </Button>
          )}
        </Stack>

        {canAdvance && (
          <TextField
            select fullWidth size="small" label="直接指定狀態"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
            helperText={formStatusOptions.find((o) => o.value === form.status)?.description}
          >
            {formStatusOptions.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
          </TextField>
        )}

        {editingId && (
          <>
            <Divider />
            <Box>
              <Typography variant="caption" color="text.secondary">建立時間</Typography>
              <Typography variant="body2">{formatDateTime(form.created_at) || '—'}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {MANUAL_ACTION_STATUSES.includes(form.status) ? '等待人工處理' : '流程進行中'}
              </Typography>
            </Box>
          </>
        )}
      </Stack>
    </Paper>
  );

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="lg" fullWidth fullScreen={isMobile}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <span>{editingId ? `編輯訂單 · ${form.order_number || ''}` : '新增訂單'}</span>
        <IconButton aria-label="關閉" onClick={onClose} disabled={saving} size="small"><X size={18} /></IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ bgcolor: 'background.default' }}>
        {!lookupsReady ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>載入中…</Typography>
        ) : (
          <Grid container spacing={2} alignItems="flex-start">
            <Grid item xs={12} lg={8}>
              <Stack spacing={2}>
                <Section title="住宿與客人資料">
                  <Grid container spacing={1.5}>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="訂單編號" value={editingId ? form.order_number || '' : '（儲存後自動產生）'} disabled />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      {/* 只有新增訂單時能填；訂單一旦建立就鎖住——LINE user ID 決定這張訂單屬於哪位聯絡人。 */}
                      {field('line_user_id', 'LINE User ID', { disabled: !!editingId, placeholder: '非 LINE 客戶可留空' })}
                    </Grid>
                    <Grid item xs={12} sm={6}>{field('name', '客戶姓名')}</Grid>
                    <Grid item xs={12} sm={6}>{field('nickname', 'LINE 暱稱')}</Grid>
                    <Grid item xs={12} sm={6}>{field('phone', '電話')}</Grid>
                    <Grid item xs={12} sm={6}>
                      <FormControlLabel
                        sx={{ mt: { sm: 0.5 } }}
                        control={
                          <Checkbox
                            checked={form.whole_house}
                            onChange={(e) => {
                              const wholeHouse = e.target.checked;
                              // 這個勾選框只決定押金要用「包棟押金」還是「已選房間的押金加總」，刻意不動房間選取。
                              setForm({
                                ...form,
                                whole_house: wholeHouse,
                                security_deposit: String(computeDefaultSecurityDeposit(wholeHouse, selectedRoomIds)),
                              });
                            }}
                          />
                        }
                        label="是否包棟"
                      />
                    </Grid>
                    <Grid item xs={12}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                        房型（可複選，選的是「房型與空間」裡的房間）
                      </Typography>
                      {rooms.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">還沒有「房間」類型的資料，請先到「房型與空間」新增。</Typography>
                      ) : (
                        <Stack direction="row" flexWrap="wrap" gap={0.75}>
                          {rooms.map((r) => {
                            const on = selectedRoomIds.includes(r.id);
                            return (
                              <Chip
                                key={r.id}
                                label={roomLabel(r)}
                                clickable
                                color={on ? 'primary' : 'default'}
                                variant={on ? 'filled' : 'outlined'}
                                onClick={() => toggleRoom(r.id)}
                              />
                            );
                          })}
                        </Stack>
                      )}
                      {selectedRoomIds.length === 0 && form.room_type_label && (
                        <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mt: 1 }}>
                          這張訂單目前只有文字房型「{form.room_type_label}」。勾選實際房間之後，布巾成本與房間篩選才算得到它。
                        </Typography>
                      )}
                    </Grid>
                    <Grid item xs={6} sm={3}>{field('checkin_date', '入住日期', { type: 'date', InputLabelProps: { shrink: true } })}</Grid>
                    <Grid item xs={6} sm={3}>{field('checkout_date', '退房日期', { type: 'date', InputLabelProps: { shrink: true } })}</Grid>
                    <Grid item xs={6} sm={3}>{field('headcount', '入住人數', { type: 'number' })}</Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField fullWidth size="small" label="晚數" value={nightsBetween(form.checkin_date, form.checkout_date) || '—'} disabled />
                    </Grid>
                    <Grid item xs={4}>{field('adults', '大人', { type: 'number' })}</Grid>
                    <Grid item xs={4}>{field('kids', '小孩', { type: 'number' })}</Grid>
                    <Grid item xs={4}>{field('infants', '嬰兒', { type: 'number' })}</Grid>
                  </Grid>
                </Section>

                <Section title="費用資訊">
                  <Grid container spacing={1.5}>
                    <Grid item xs={6}>{field('room_amount', '房價（不含押金）', { type: 'number' })}</Grid>
                    <Grid item xs={6}>{field('security_deposit', '押金', { type: 'number', placeholder: String(defaultSecurityDeposit) })}</Grid>
                    <Grid item xs={6}>{field('total_amount', '訂單總額（房價＋押金）', { type: 'number' })}</Grid>
                    <Grid item xs={6}>{field('deposit', `訂金（房價 ${moneyDefaults.percent}%）`, { type: 'number' })}</Grid>
                    <Grid item xs={12}>
                      <Link component="button" type="button" variant="caption" underline="hover" onClick={recalcAmounts} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        <RefreshCw size={13} /> 依房價重算：訂單總額 ＝ 房價＋押金 {defaultSecurityDeposit}，訂金 ＝ 房價 {moneyDefaults.percent}%
                      </Link>
                    </Grid>
                  </Grid>
                </Section>

                <Section title="款項核對與備註">
                  <Grid container spacing={1.5}>
                    <Grid item xs={12} sm={6}>
                      {field('remit_last5', '匯款末5碼', { required: form.status === REQUIRES_REMIT_LAST5_STATUS, placeholder: '狀態設為「已預定」時必填' })}
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      {/* 客人到現場要能報這組密碼給客服核對，所以是明碼輸入。 */}
                      {field('check_in_password', '入住密碼', {
                        disabled: !CHECKIN_PASSWORD_STATUSES.includes(form.status),
                        placeholder: '入住時用來核對身分的密碼／門禁碼',
                        helperText: !CHECKIN_PASSWORD_STATUSES.includes(form.status) ? '僅「待入住」「入住中」狀態可填' : undefined,
                      })}
                    </Grid>
                    {/* 顧客備註跟內部備註刻意分成兩格：一個是客人在 LINE 上打的字（訂房流程自動寫入），一個是客服自己記的。 */}
                    <Grid item xs={12}>{field('guest_notes', '顧客備註（客人在 LINE 訂房流程填寫，可修改）', { multiline: true, minRows: 2, placeholder: '例如：想烤肉、需要嬰兒床' })}</Grid>
                    <Grid item xs={12}>{field('notes', '內部備註', { multiline: true, minRows: 3, placeholder: '內部備註，客戶不會看到' })}</Grid>
                  </Grid>
                </Section>

                {linenItems.length > 0 && (
                  <Section title="布巾備品洗滌成本">
                    <Stack spacing={1.5}>
                      <Stack direction="row" spacing={2} alignItems="flex-start" flexWrap="wrap">
                        <TextField
                          size="small" type="number" label="整趟住宿換洗幾次" sx={{ width: 160 }}
                          inputProps={{ min: 1 }}
                          value={form.linen_change_count}
                          onChange={(e) => setForm({ ...form, linen_change_count: e.target.value })}
                        />
                        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 220, pt: 0.5 }}>
                          依上方勾選的 {selectedRoomIds.length} 間房計算，住 {nightsBetween(form.checkin_date, form.checkout_date) || '—'} 晚。
                          1＝整趟只在退房後洗一次；客人中途要求換洗就往上加。
                        </Typography>
                      </Stack>

                      {selectedRoomIds.length === 0 && usageRows.length === 0 ? (
                        <Typography variant="caption" color="text.secondary">在上方勾選房型後，會依「布巾備品」設定的預設組合自動帶出用量。</Typography>
                      ) : (
                        <Box sx={{ overflowX: 'auto' }}>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell>品項</TableCell>
                                <TableCell align="right" sx={{ width: 80 }}>單價</TableCell>
                                <TableCell sx={{ width: 110 }}>件數</TableCell>
                                <TableCell align="right" sx={{ width: 100 }}>小計</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {usageRows.filter((r) => r.quantity > 0).map((r) => {
                                const item = linenItems.find((i) => i.id === r.linen_item_id);
                                return (
                                  <TableRow key={r.linen_item_id}>
                                    <TableCell>
                                      {item ? linenItemLabel(item) : '（已刪除的品項）'}
                                      {r.is_manual && <Typography component="span" variant="caption" color="warning.dark" sx={{ ml: 1 }}>已手動調整</Typography>}
                                    </TableCell>
                                    <TableCell align="right">{r.unit_price}</TableCell>
                                    <TableCell>
                                      <TextField
                                        size="small" type="number" inputProps={{ min: 0 }} sx={{ width: 90 }}
                                        value={r.quantity}
                                        onChange={(e) => setUsageQuantity(r.linen_item_id, Math.max(0, Number(e.target.value) || 0))}
                                      />
                                    </TableCell>
                                    <TableCell align="right">{formatMoney(r.quantity * r.unit_price)}</TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                            <TableFooter>
                              <TableRow>
                                <TableCell colSpan={3} align="right">布巾成本合計</TableCell>
                                <TableCell align="right" sx={{ fontWeight: 700, color: 'text.primary' }}>{formatMoney(usageTotal(usageRows))}</TableCell>
                              </TableRow>
                            </TableFooter>
                          </Table>
                        </Box>
                      )}

                      <Tooltip title="會清掉手動調整">
                        <Link component="button" type="button" variant="caption" underline="hover" color="text.secondary" onClick={resetUsageToDefaults} sx={{ alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                          <RefreshCw size={13} /> 重新帶入預設組合
                        </Link>
                      </Tooltip>
                    </Stack>
                  </Section>
                )}

                {formError && <Alert severity="error">{formError}</Alert>}
              </Stack>
            </Grid>
            <Grid item xs={12} lg={4}>{statusPanel}</Grid>
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" onClick={onClose} disabled={saving}>關閉</Button>
        <Button variant="contained" onClick={() => saveForm()} disabled={saving || !lookupsReady}>{saving ? '儲存中…' : '儲存變更'}</Button>
      </DialogActions>
    </Dialog>
  );
}

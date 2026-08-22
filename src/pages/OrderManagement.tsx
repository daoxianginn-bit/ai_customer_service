import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ClipboardList, Search, RotateCcw, Save, Plus, Trash2, AlertCircle, AlertTriangle, Shirt, RefreshCw, CalendarDays, ListFilter, DoorOpen, ArrowRight } from 'lucide-react';
import { Button, Modal, StatusBadge, EmptyState, ConfirmDialog } from '../components/ui';
import { BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUSES, REQUIRES_REMIT_LAST5_STATUS, REQUIRES_CHECKIN_PASSWORD_STATUS, FLOW_STEP_STATUSES, flowStepIndex, bookingStatusLabel } from '../lib/bookingStatus';
import { computeOrderAmounts } from '../lib/messageVariables';
import { generateOrderNumber } from '../lib/orderNumber';
import {
  LinenItem, RoomLinenDefault, LinenUsageRow,
  linenItemLabel, currency, nightsBetween, computeUsage, mergeUsage, usageTotal, normalizeChangeCount,
} from '../lib/linenCost';
import { RoomOption, roomLabel } from '../lib/rooms';

const PAGE_SIZE = 15;

const FILTER_STATUS_OPTIONS = [{ value: '', label: '全部狀態' }, ...BOOKING_STATUS_OPTIONS, ...SYSTEM_ONLY_STATUSES];

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
  notes: string;
  linen_change_count: string;
}

const emptyForm = (): OrderForm => ({
  name: '', nickname: '', line_user_id: '', phone: '',
  checkin_date: '', checkout_date: '', headcount: '', adults: '', kids: '', infants: '',
  whole_house: true, room_type_label: '', room_amount: '', security_deposit: '', total_amount: '', deposit: '', remit_last5: '',
  check_in_password: '', status: 'inquiring', notes: '', linen_change_count: '1',
});

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatusHelpIcon() {
  return (
    <div className="group relative inline-flex">
      <AlertCircle className="w-3.5 h-3.5 text-gray-400 cursor-help" />
      <div className="hidden group-hover:block absolute z-20 left-0 top-5 w-80 bg-gray-800 text-white text-xs rounded-lg p-3 space-y-1.5 shadow-lg">
        {[...BOOKING_STATUS_OPTIONS, ...SYSTEM_ONLY_STATUSES].map((s) => (
          <div key={s.value}><strong className="text-white">{s.label}</strong>：<span className="text-gray-300">{s.description}</span></div>
        ))}
      </div>
    </div>
  );
}

const EXCEPTION_STATUS_STYLE: Record<string, string> = {
  awaiting_refund: 'border-red-200 bg-red-50 text-red-700',
  refunded: 'border-gray-200 bg-gray-100 text-gray-600',
  cancelled: 'border-red-100 bg-red-50/60 text-red-500',
  pending_manual_conflict: 'border-amber-200 bg-amber-50 text-amber-700',
  external_synced: 'border-slate-200 bg-slate-50 text-slate-600',
};

// 訂單流程狀態進度列：上排是正常 6 步流程（點了篩選表格），下排是例外/其他流程。
function FlowStatusBar({
  counts,
  activeStatus,
  onSelectStatus,
}: {
  counts: Record<string, number>;
  activeStatus: string;
  onSelectStatus: (status: string) => void;
}) {
  const exceptionPill = (statusValue: string, label: string) => {
    const active = activeStatus === statusValue;
    return (
      <button
        onClick={() => onSelectStatus(statusValue)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
          active ? 'ring-2 ring-offset-1 ring-red-300' : ''
        } ${EXCEPTION_STATUS_STYLE[statusValue] || 'border-gray-200 bg-gray-50 text-gray-600'}`}
      >
        {label}
        <span className="font-bold">{counts[statusValue] || 0}</span>
      </button>
    );
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border p-5 space-y-4">
      <p className="text-xs font-medium text-gray-500 flex items-center gap-1">訂單流程狀態 <StatusHelpIcon /></p>
      <div className="flex flex-wrap items-center gap-1">
        {FLOW_STEP_STATUSES.map((s, i) => {
          const active = activeStatus === s;
          return (
            <div key={s} className="flex items-center">
              <button
                onClick={() => onSelectStatus(s)}
                className={`flex flex-col items-center gap-1 px-4 py-2 rounded-lg border transition-colors min-w-[84px] ${
                  active ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${active ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500'}`}>
                  {i + 1}
                </span>
                <span className="text-xs text-gray-600 whitespace-nowrap">{bookingStatusLabel(s)}</span>
                <span className="text-sm font-bold text-gray-800">{counts[s] || 0}</span>
              </button>
              {i < FLOW_STEP_STATUSES.length - 1 && <ArrowRight className="w-4 h-4 text-gray-300 mx-1 shrink-0" />}
            </div>
          );
        })}
      </div>
      <div className="pt-3 border-t">
        <p className="text-xs text-gray-400 mb-2">例外／其他流程</p>
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex items-center gap-1.5">
            {exceptionPill('awaiting_refund', bookingStatusLabel('awaiting_refund'))}
            <ArrowRight className="w-3.5 h-3.5 text-gray-300" />
            {exceptionPill('refunded', bookingStatusLabel('refunded'))}
          </div>
          {exceptionPill('cancelled', bookingStatusLabel('cancelled'))}
          {SYSTEM_ONLY_STATUSES.map((s) => <span key={s.value}>{exceptionPill(s.value, s.label)}</span>)}
        </div>
      </div>
    </div>
  );
}

// 每筆訂單在表格裡的「流程位置」小圖示：正常流程顯示 1~6 小圓圈鏈，例外狀態顯示標籤取代。
function FlowPositionCell({ status }: { status: string }) {
  const idx = flowStepIndex(status);
  if (idx == null) {
    return <span className="text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap bg-amber-50 text-amber-700 border-amber-200">例外流程</span>;
  }
  return (
    <div className="flex items-center">
      {FLOW_STEP_STATUSES.map((_, i) => (
        <span key={i} className="flex items-center">
          <span
            className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
              i + 1 === idx ? 'bg-green-600 text-white' : i + 1 < idx ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400'
            }`}
          >
            {i + 1}
          </span>
          {i < FLOW_STEP_STATUSES.length - 1 && <span className={`w-2 h-px shrink-0 ${i + 1 < idx ? 'bg-green-300' : 'bg-gray-200'}`} />}
        </span>
      ))}
    </div>
  );
}

export default function OrderManagement() {
  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('');
  const [roomType, setRoomType] = useState('');
  const [roomTypeOptions, setRoomTypeOptions] = useState<string[]>([]);

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<OrderForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 批次刪除：開關打開才顯示勾選欄位，避免平常誤觸；換頁/重新查詢時清掉勾選，
  // 因為畫面上的列已經換了一批，殘留的勾選 id 對不上新的清單。
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [showBatchConfirm, setShowBatchConfirm] = useState(false);

  // 押金與訂金比例的預設值來自「房型與報價」的設定，人工建單時按「重算」就會套用同一套算法，
  // 跟 LINE 自動報價算出來的金額一致。
  const [moneyDefaults, setMoneyDefaults] = useState({ wholeHouseSecurity: 3000, percent: 30 });

  // 布巾備品：實際開了哪幾間房決定送洗成本（「包棟」只是使用權名稱，不影響算法）
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [linenItems, setLinenItems] = useState<LinenItem[]>([]);
  const [linenDefaults, setLinenDefaults] = useState<RoomLinenDefault[]>([]);
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [usageRows, setUsageRows] = useState<LinenUsageRow[]>([]);
  // 打開表單載入既有資料時不要馬上重算，否則會把之前的人工調整蓋掉
  const skipRecompute = useRef(true);

  useEffect(() => {
    fetchRoomTypeOptions();
    fetchLinenSetup();
    fetchMoneyDefaults();
    fetchStatusCounts();
    runQuery(0);
  }, []);

  // 「訂單流程狀態」進度列的即時筆數：輕量查詢（只抓 status 欄位），前端算每個狀態幾筆。
  const fetchStatusCounts = async () => {
    const { data } = await supabase.from('bookings').select('status');
    const counts: Record<string, number> = {};
    for (const row of data || []) counts[row.status] = (counts[row.status] || 0) + 1;
    setStatusCounts(counts);
  };

  // 點流程列的某個步驟：切換篩選列的「訂單狀態」並重新查詢，再點一次同一個步驟會清掉篩選。
  //
  // 這裡不能寫成 setStatus(next); setTimeout(() => runQuery(0), 0)——setState 是非同步的，
  // setTimeout(fn, 0) 排進的還是「這一輪 render」就已經存在的 runQuery 版本，那個版本的
  // runQuery 透過 closure 讀到的 status 仍是「點擊之前」的舊值，不是剛剛按的 statusValue。
  // 結果就是：點下去畫面立刻高亮（highlight 只看 render 用的 status），但下方清單其實是拿
  // 上一輪的狀態去查，感覺起來永遠「慢一拍」——要再點一次、把新的舊值代入才會補上這次的篩選。
  // 修法是讓 runQuery 直接接受要用的狀態值，不要依賴 state 更新完成的時間點。
  const selectStatusFilter = (statusValue: string) => {
    const next = status === statusValue ? '' : statusValue;
    setStatus(next);
    runQuery(0, { status: next });
  };

  // 換房間或改換洗次數才重算；已手動調整過的品項由 mergeUsage 保留。
  // 日期不在依賴裡：換洗次數改由使用者自己填，晚數只是給他參考的提示。
  useEffect(() => {
    if (skipRecompute.current) { skipRecompute.current = false; return; }
    const times = normalizeChangeCount(Number(form.linen_change_count));
    setUsageRows((prev) => mergeUsage(prev, computeUsage(selectedRoomIds, linenDefaults, times, linenItems)));
  }, [selectedRoomIds, form.linen_change_count, linenDefaults, linenItems]);

  const fetchRoomTypeOptions = async () => {
    const { data } = await supabase.from('room_types').select('id, name, floor, capacity, security_deposit').eq('type', '房間').order('display_order');
    setRooms((data || []) as RoomOption[]);
    setRoomTypeOptions((data || []).map((r: any) => r.name));
  };

  const fetchMoneyDefaults = async () => {
    const { data } = await supabase.from('settings').select('whole_house_security_deposit, deposit_percent').single();
    if (!data) return;
    setMoneyDefaults({
      wholeHouseSecurity: Number(data.whole_house_security_deposit ?? 3000),
      percent: Number(data.deposit_percent ?? 30),
    });
  };

  // 押金預設值：包棟用「報價設定」的固定金額；個別租房用目前勾選房間的押金加總。
  const defaultSecurityDeposit = form.whole_house
    ? moneyDefaults.wholeHouseSecurity
    : selectedRoomIds.reduce((sum, id) => sum + Number(rooms.find((r) => r.id === id)?.security_deposit ?? 0), 0);

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

  // 布巾資料表可能還沒建立（schema 尚未執行），查不到就當作沒啟用這個功能，不擋訂單頁
  const fetchLinenSetup = async () => {
    const [itemRes, defRes] = await Promise.all([
      supabase.from('linen_items').select('*').eq('is_active', true).order('display_order'),
      supabase.from('room_type_linen_defaults').select('*'),
    ]);
    if (itemRes.error || defRes.error) return;
    setLinenItems(itemRes.data || []);
    setLinenDefaults(defRes.data || []);
  };

  const loadBookingLinen = async (bookingId: string) => {
    const [roomRes, usageRes] = await Promise.all([
      supabase.from('booking_rooms').select('room_type_id').eq('booking_id', bookingId),
      supabase.from('booking_linen_usage').select('linen_item_id, quantity, unit_price, is_manual').eq('booking_id', bookingId),
    ]);
    skipRecompute.current = true;
    setSelectedRoomIds((roomRes.data || []).map((r: any) => r.room_type_id));
    setUsageRows((usageRes.data || []) as LinenUsageRow[]);
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

  // overrides：呼叫端剛 setState 但還沒生效的最新值，優先用這個而不是 state，
  // 道理跟 selectStatusFilter 上面的說明一樣——不要靠 setTimeout 賭 state 更新的時機。
  const runQuery = async (
    pageIndex: number,
    overrides?: Partial<{ keyword: string; startDate: string; endDate: string; status: string; roomType: string }>
  ) => {
    const eff = {
      keyword: overrides?.keyword ?? keyword,
      startDate: overrides?.startDate ?? startDate,
      endDate: overrides?.endDate ?? endDate,
      status: overrides?.status ?? status,
      roomType: overrides?.roomType ?? roomType,
    };
    setLoading(true);
    let query = supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (eff.startDate) query = query.gte('checkin_date', eff.startDate);
    if (eff.endDate) query = query.lte('checkin_date', eff.endDate);
    if (eff.status) query = query.eq('status', eff.status);
    if (eff.roomType === '包棟') query = query.eq('whole_house', true);
    else if (eff.roomType) query = query.ilike('room_type_label', `%${eff.roomType}%`);
    if (eff.keyword.trim()) {
      const kw = eff.keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
    }

    const { data, error } = await query;
    if (!error) {
      setRows(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setSelectedIds([]);
    setLoading(false);
  };

  const toggleBatchMode = () => {
    setBatchMode((v) => !v);
    setSelectedIds([]);
  };

  const toggleSelectRow = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => (prev.length === rows.length ? [] : rows.map((r) => r.id)));
  };

  const confirmBatchDelete = async () => {
    if (!selectedIds.length) return;
    setBatchDeleting(true);
    try {
      const { error } = await supabase.from('bookings').delete().in('id', selectedIds);
      if (error) throw error;
      setShowBatchConfirm(false);
      setSelectedIds([]);
      runQuery(page);
      fetchStatusCounts();
    } catch (err: any) {
      alert(`批次刪除失敗：${err.message}`);
    } finally {
      setBatchDeleting(false);
    }
  };

  const clearFilters = () => {
    setKeyword('');
    setStartDate('');
    setEndDate('');
    setStatus('');
    setRoomType('');
    runQuery(0, { keyword: '', startDate: '', endDate: '', status: '', roomType: '' });
  };

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    // 新訂單預設「是否包棟」為勾選狀態，房間也跟著預設全選（跟打勾 checkbox 的行為一致）——
    // 這是全新訂單，沒有既有資料要保護，skipRecompute 設 false 讓下面的 effect 直接算出
    // 預設布巾組合，不用像編輯既有訂單那樣跳過第一次重算。
    skipRecompute.current = false;
    setSelectedRoomIds(rooms.map((r) => r.id));
    setUsageRows([]);
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (row: any) => {
    setEditingId(row.id);
    loadBookingLinen(row.id);
    setForm({
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
      notes: row.notes || '',
      linen_change_count: String(row.linen_change_count ?? 1),
    });
    setFormError('');
    setShowForm(true);
  };

  const closeForm = () => setShowForm(false);

  const saveForm = async () => {
    if (form.status === REQUIRES_REMIT_LAST5_STATUS && !form.remit_last5.trim()) {
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
        security_deposit: form.security_deposit === '' ? 0 : Number(form.security_deposit),
        total_amount: form.total_amount === '' ? null : Number(form.total_amount),
        deposit: form.deposit === '' ? null : Number(form.deposit),
        remit_last5: form.remit_last5 || null,
        // 只有狀態為「待入住」才允許有值——不是這個狀態時，即使欄位裡還留著文字（例如狀態被改回
        // 更早的步驟），存檔時一律清空，不要讓舊密碼在不該生效的狀態下還留著造成誤導。
        check_in_password: form.status === REQUIRES_CHECKIN_PASSWORD_STATUS ? (form.check_in_password || null) : null,
        status: form.status,
        notes: form.notes || null,
        updated_at: new Date().toISOString(),
      };

      let bookingId = editingId;
      if (editingId) {
        const { error } = await supabase.from('bookings').update(payload).eq('id', editingId);
        if (error) throw error;
      } else {
        let lastError: any = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const { data, error } = await supabase
            .from('bookings')
            .insert({ ...payload, order_number: generateOrderNumber() })
            .select('id')
            .single();
          if (!error) { lastError = null; bookingId = data.id; break; }
          lastError = error;
          if (!String(error.message || '').includes('order_number')) break;
        }
        if (lastError) throw lastError;
      }

      if (bookingId) await saveLinen(bookingId);

      setShowForm(false);
      runQuery(page);
      fetchStatusCounts();
    } catch (err: any) {
      setFormError(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // 房間與布巾用量整批重寫（先刪後插）。布巾資料表還沒建立時靜靜跳過，不擋訂單儲存。
  const saveLinen = async (bookingId: string) => {
    if (!linenItems.length) return;
    try {
      await supabase.from('booking_rooms').delete().eq('booking_id', bookingId);
      if (selectedRoomIds.length) {
        await supabase.from('booking_rooms').insert(selectedRoomIds.map((room_type_id) => ({ booking_id: bookingId, room_type_id })));
      }
      await supabase.from('booking_linen_usage').delete().eq('booking_id', bookingId);
      const rows = usageRows.filter((r) => r.quantity > 0);
      if (rows.length) {
        await supabase.from('booking_linen_usage').insert(rows.map((r) => ({ booking_id: bookingId, ...r })));
      }
    } catch (e: any) {
      console.error('[Linen] save failed:', e.message);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('bookings').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      runQuery(page);
      fetchStatusCounts();
    } catch (err: any) {
      alert(`刪除失敗：${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const balanceDue = (row: any) => (row.total_amount != null ? row.total_amount - (row.deposit ?? 0) : null);

  // 系統專用狀態不開放手動選，但如果這張訂單「現在剛好就是」系統專用狀態（例如系統偵測到檔期
  // 衝突、或是外部平台同步進來的），下拉選單還是要能顯示目前這個值，不然編輯畫面會顯示成空白選項。
  const currentSystemOnlyStatus = SYSTEM_ONLY_STATUSES.find((s) => s.value === form.status);
  const formStatusOptions = currentSystemOnlyStatus ? [currentSystemOnlyStatus, ...BOOKING_STATUS_OPTIONS] : BOOKING_STATUS_OPTIONS;

  return (
    <div className="w-full space-y-6">
      {/* 標題區塊與關鍵字搜尋合併成同一張卡片，中間用分隔線區分，不用再各自佔一張卡片。 */}
      <div className="bg-white p-5 rounded-xl shadow-sm border space-y-4">
        <div className="flex flex-wrap justify-between items-start gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              <ClipboardList className="w-6 h-6 text-green-600" />
              訂單管理
            </h2>
            <p className="text-gray-500 mt-1">新增、查詢、檢視與編輯所有訂房紀錄。</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={batchMode ? 'primary' : 'secondary'}
              onClick={toggleBatchMode}
              icon={<Trash2 className="w-4 h-4" />}
            >
              {batchMode ? '取消批次刪除' : '批次刪除'}
            </Button>
            {batchMode && selectedIds.length > 0 && (
              <Button variant="danger" onClick={() => setShowBatchConfirm(true)} icon={<Trash2 className="w-4 h-4" />}>
                刪除選取（{selectedIds.length}）
              </Button>
            )}
            <Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增訂單</Button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 border-t pt-4">
          <div className="lg:col-span-2">
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><Search className="w-3.5 h-3.5" />關鍵字搜尋</label>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runQuery(0)} placeholder="搜尋姓名、電話或訂單編號" className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><CalendarDays className="w-3.5 h-3.5" />入住日期（起）</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><CalendarDays className="w-3.5 h-3.5" />入住日期（迄）</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><ListFilter className="w-3.5 h-3.5" />訂單狀態</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white">
              {FILTER_STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><DoorOpen className="w-3.5 h-3.5" />房型</label>
            <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">全部房型</option>
              <option value="包棟">包棟</option>
              {roomTypeOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={clearFilters} icon={<RotateCcw className="w-4 h-4" />}>清除條件</Button>
          <Button onClick={() => runQuery(0)} loading={loading} icon={<Search className="w-4 h-4" />}>查詢</Button>
        </div>
      </div>

      <FlowStatusBar counts={statusCounts} activeStatus={status} onSelectStatus={selectStatusFilter} />

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                {batchMode && (
                  <th className="py-3 px-4 w-10">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selectedIds.length === rows.length}
                      onChange={toggleSelectAll}
                      className="w-4 h-4"
                    />
                  </th>
                )}
                <th className="py-3 px-4">訂單編號</th>
                <th className="py-3 px-4">姓名</th>
                <th className="py-3 px-4">入住日期</th>
                <th className="py-3 px-4">退房日期</th>
                <th className="py-3 px-4">人數</th>
                <th className="py-3 px-4">房型</th>
                <th className="py-3 px-4">總報價</th>
                <th className="py-3 px-4">尾款</th>
                <th className="py-3 px-4">狀態</th>
                <th className="py-3 px-4">流程位置</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={batchMode ? 12 : 11} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={batchMode ? 12 : 11}><EmptyState icon={<ClipboardList className="w-12 h-12 text-gray-200" />} message="查無符合條件的訂單" /></td></tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} onClick={() => (batchMode ? toggleSelectRow(row.id) : openEdit(row))} className="hover:bg-green-50 transition-colors cursor-pointer">
                    {batchMode && (
                      <td className="py-3 px-4" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(row.id)}
                          onChange={() => toggleSelectRow(row.id)}
                          className="w-4 h-4"
                        />
                      </td>
                    )}
                    <td className="py-3 px-4 font-mono text-xs text-gray-500">{row.order_number || '-'}</td>
                    <td className="py-3 px-4 font-medium text-gray-800">
                      {row.name || row.nickname || '未取得'}
                      {/* 第三方同步進來、日期跟其他訂單重疊的訂單。依規格兩筆都保留不自動合併，
                          只在這裡標記出來讓人工核實是不是真的超賣（推播只會在偵測到的當下發一次，
                          漏看就沒了，所以清單上也要看得到）。 */}
                      {row.ota_conflict_detected_at && (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5 align-middle" title="這筆第三方訂單跟其他訂單日期重疊，請人工核實是否超賣">
                          <AlertTriangle className="w-3 h-3" />疑似撞期
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.checkin_date ? String(row.checkin_date).replace(/-/g, '/') : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.checkout_date ? String(row.checkout_date).replace(/-/g, '/') : '-'}</td>
                    <td className="py-3 px-4">{row.headcount ?? '-'}</td>
                    <td className="py-3 px-4">{row.room_type_label || (row.whole_house ? '包棟' : '-')}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.total_amount != null ? `NT$ ${Number(row.total_amount).toLocaleString()}` : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{balanceDue(row) != null ? `NT$ ${Number(balanceDue(row)).toLocaleString()}` : '-'}</td>
                    <td className="py-3 px-4"><StatusBadge status={row.status} /></td>
                    <td className="py-3 px-4"><FlowPositionCell status={row.status} /></td>
                    <td className="py-3 px-4 text-right">
                      <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }} className="p-1.5 text-red-500 hover:bg-red-50 rounded" title="刪除">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center px-6 py-4 border-t text-sm text-gray-500">
          <button disabled={page === 0 || loading} onClick={() => runQuery(page - 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">上一頁</button>
          <span>第 {page + 1} 頁</span>
          <button disabled={!hasMore || loading} onClick={() => runQuery(page + 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">下一頁</button>
        </div>
      </div>

      <Modal
        open={showForm}
        title={editingId ? `編輯訂單${form.order_number ? `（${form.order_number}）` : ''}` : '新增訂單'}
        onClose={closeForm}
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button variant="secondary" onClick={closeForm}>取消</Button>
            <Button onClick={saveForm} loading={saving} icon={<Save className="w-4 h-4" />}>{saving ? '儲存中...' : '儲存變更'}</Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">訂單編號</label>
            <input value={editingId ? form.order_number : '（儲存後自動產生）'} disabled className="w-full px-3 py-2 border rounded-lg bg-gray-100 text-gray-400" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">LINE User ID</label>
            {/* 只有新增訂單時能填；訂單一旦建立就鎖住不可改——LINE user ID 決定這張訂單屬於
                哪位聯絡人，改掉的話對話記錄/推播對象都會對不上，是身分而不是可編輯的資料欄位。 */}
            <input
              value={form.line_user_id}
              onChange={(e) => setForm({ ...form, line_user_id: e.target.value })}
              disabled={!!editingId}
              className={`w-full px-3 py-2 border rounded-lg ${editingId ? 'bg-gray-100 text-gray-400' : ''}`}
              placeholder="非 LINE 客戶可留空"
            />
          </div>
          {editingId && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">訂單建立時間</label>
              <input value={formatDateTime(form.created_at)} disabled className="w-full px-3 py-2 border rounded-lg bg-gray-100 text-gray-400" />
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">客戶姓名</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">LINE 暱稱</label>
            <input value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">電話</label>
            <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">
              房型（可複選，選的是「房型與空間維護」裡的房間）
            </label>
            {rooms.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">還沒有「房間」類型的資料，請先到「房型與空間維護」新增。</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {rooms.map((r) => {
                  const on = selectedRoomIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleRoom(r.id)}
                      className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                        on ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {roomLabel(r)}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedRoomIds.length === 0 && form.room_type_label && (
              <p className="text-xs text-amber-700 mt-1.5">
                這張訂單目前只有文字房型「{form.room_type_label}」。勾選實際房間之後，布巾成本與房間篩選才算得到它。
              </p>
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住日期</label>
            <input type="date" value={form.checkin_date} onChange={(e) => setForm({ ...form, checkin_date: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">退房日期</label>
            <input type="date" value={form.checkout_date} onChange={(e) => setForm({ ...form, checkout_date: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住人數</label>
            <input type="number" value={form.headcount} onChange={(e) => setForm({ ...form, headcount: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={form.whole_house}
                onChange={(e) => {
                  setForm({ ...form, whole_house: e.target.checked });
                  // 包棟＝所有房間都開，勾選當下直接把全部房間帶進去，不用管理員自己一間一間點——
                  // 房間一變動，下面的布巾用量會透過既有的 useEffect 自動照每間房的預設組合重算。
                  if (e.target.checked) setSelectedRoomIds(rooms.map((r) => r.id));
                }}
                className="w-4 h-4"
              />
              是否包棟
            </label>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">大人</label>
            <input type="number" value={form.adults} onChange={(e) => setForm({ ...form, adults: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">小孩</label>
            <input type="number" value={form.kids} onChange={(e) => setForm({ ...form, kids: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">嬰兒</label>
            <input type="number" value={form.infants} onChange={(e) => setForm({ ...form, infants: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">房價（不含押金）</label>
            <input type="number" value={form.room_amount} onChange={(e) => setForm({ ...form, room_amount: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">押金</label>
            <input type="number" value={form.security_deposit} onChange={(e) => setForm({ ...form, security_deposit: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder={String(defaultSecurityDeposit)} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">訂單總額（房價＋押金）</label>
            <input type="number" value={form.total_amount} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">訂金（房價 {moneyDefaults.percent}%）</label>
            <input type="number" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div className="col-span-2 -mt-1">
            <button
              type="button"
              onClick={recalcAmounts}
              className="text-xs flex items-center gap-1 text-green-600 hover:text-green-700"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 依房價重算：訂單總額 ＝ 房價＋押金 {defaultSecurityDeposit}，訂金 ＝ 房價 {moneyDefaults.percent}%
            </button>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              匯款末5碼{form.status === REQUIRES_REMIT_LAST5_STATUS && <span className="text-red-500"> *</span>}
            </label>
            <input value={form.remit_last5} onChange={(e) => setForm({ ...form, remit_last5: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="狀態設為「已預定」時必填" />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1">訂單狀態 <StatusHelpIcon /></label>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full px-3 py-2 border rounded-lg bg-white">
              {formStatusOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              入住密碼{form.status !== REQUIRES_CHECKIN_PASSWORD_STATUS && <span className="text-gray-400">（僅「待入住」狀態可填）</span>}
            </label>
            {/* 客人到現場要能報這組密碼給客服核對，所以是明碼輸入，不是密碼型輸入框。 */}
            <input
              value={form.check_in_password}
              onChange={(e) => setForm({ ...form, check_in_password: e.target.value })}
              disabled={form.status !== REQUIRES_CHECKIN_PASSWORD_STATUS}
              className={`w-full px-3 py-2 border rounded-lg ${form.status !== REQUIRES_CHECKIN_PASSWORD_STATUS ? 'bg-gray-100 text-gray-400' : ''}`}
              placeholder="入住時用來核對身分的密碼／門禁碼"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-gray-500 mb-1">備註</label>
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={3} className="w-full px-3 py-2 border rounded-lg" placeholder="內部備註，客戶不會看到" />
          </div>
        </div>

        {linenItems.length > 0 && (
          <div className="border-t pt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                <Shirt className="w-4 h-4 text-green-600" />
                布巾備品洗滌成本
              </h4>
              <span className="text-xs text-gray-400">
                依上方勾選的 {selectedRoomIds.length} 間房計算
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">整趟住宿換洗幾次</label>
                <input
                  type="number" min={1}
                  value={form.linen_change_count}
                  onChange={(e) => setForm({ ...form, linen_change_count: e.target.value })}
                  className="w-24 px-3 py-2 border rounded-lg"
                />
              </div>
              <p className="text-xs text-gray-400 pb-2.5 flex-1 min-w-[240px]">
                住 {nightsBetween(form.checkin_date, form.checkout_date) || '—'} 晚。
                1＝整趟只在退房後洗一次；客人中途要求換洗就往上加。
              </p>
            </div>

            {selectedRoomIds.length === 0 && usageRows.length === 0 ? (
              <p className="text-xs text-gray-400">在上方勾選房型後，會依「布巾備品」設定的預設組合自動帶出用量。</p>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b text-xs text-gray-500">
                    <tr>
                      <th className="py-2 px-3 text-left">品項</th>
                      <th className="py-2 px-2 text-right w-20">單價</th>
                      <th className="py-2 px-2 text-left w-24">件數</th>
                      <th className="py-2 px-3 text-right w-24">小計</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {usageRows.filter((r) => r.quantity > 0).map((r) => {
                      const item = linenItems.find((i) => i.id === r.linen_item_id);
                      return (
                        <tr key={r.linen_item_id}>
                          <td className="py-1.5 px-3 text-gray-700">
                            {item ? linenItemLabel(item) : '（已刪除的品項）'}
                            {r.is_manual && <span className="ml-2 text-xs text-amber-600">已手動調整</span>}
                          </td>
                          <td className="py-1.5 px-2 text-right text-gray-500">{r.unit_price}</td>
                          <td className="py-1.5 px-2">
                            <input
                              type="number" min={0}
                              value={r.quantity}
                              onChange={(e) => setUsageQuantity(r.linen_item_id, Math.max(0, Number(e.target.value) || 0))}
                              className="w-20 px-2 py-1 border rounded text-sm"
                            />
                          </td>
                          <td className="py-1.5 px-3 text-right text-gray-800">{currency(r.quantity * r.unit_price)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50 border-t">
                    <tr>
                      <td colSpan={3} className="py-2 px-3 text-right text-xs text-gray-500">布巾成本合計</td>
                      <td className="py-2 px-3 text-right font-bold text-gray-800">{currency(usageTotal(usageRows))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}

            <button
              type="button"
              onClick={resetUsageToDefaults}
              className="text-xs flex items-center gap-1 text-gray-500 hover:text-gray-700"
            >
              <RefreshCw className="w-3.5 h-3.5" /> 重新帶入預設組合（會清掉手動調整）
            </button>
          </div>
        )}

        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除訂單"
        message={`確定要刪除訂單「${deleteTarget?.order_number || deleteTarget?.name || ''}」嗎？此操作無法復原。`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={showBatchConfirm}
        title="批次刪除訂單"
        message={`確定要刪除選取的 ${selectedIds.length} 筆訂單嗎？此操作無法復原。`}
        confirmLabel="刪除"
        danger
        loading={batchDeleting}
        onConfirm={confirmBatchDelete}
        onCancel={() => setShowBatchConfirm(false)}
      />
    </div>
  );
}

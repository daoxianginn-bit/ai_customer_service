import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ClipboardList, Search, RotateCcw, Save, Plus, Trash2, AlertCircle, AlertTriangle, Shirt, RefreshCw, CalendarDays, ListFilter, DoorOpen, UserCheck, CheckCircle2, LogIn, ChevronRight, X } from 'lucide-react';
import { Button, Modal, StatusBadge, EmptyState, ConfirmDialog, FilterBar } from '../components/ui';
import { useAuth } from '../lib/AuthContext';
import { canDeleteBookings } from '../lib/permissions';
import {
  BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUSES, REQUIRES_REMIT_LAST5_STATUS, REQUIRES_CHECKIN_PASSWORD_STATUS,
  FLOW_STEP_STATUSES, flowStepIndex, bookingStatusLabel, bookingStatusDescription, nextFlowStatus,
  MANUAL_ACTION_STATUSES, MANUAL_ACTION_FLOW_STATUSES, OCCUPYING_STATUSES, bookingStatusRowClass,
} from '../lib/bookingStatus';
import { computeOrderAmounts } from '../lib/messageVariables';
import { generateOrderNumber } from '../lib/orderNumber';
import { logOperation, logUiError } from '../lib/logOperation';
import { LOG_FEATURES, diffRecords, labelRecord } from '../lib/operationLog';
import {
  LinenItem, RoomLinenDefault, LinenUsageRow,
  linenItemLabel, currency, nightsBetween, computeUsage, mergeUsage, usageTotal, normalizeChangeCount,
} from '../lib/linenCost';
import { RoomOption, roomLabel } from '../lib/rooms';

const PAGE_SIZE = 15;

// 訂單清單自動刷新的間隔。LINE 自動成立的訂單會在客服沒有操作的情況下出現，
// 固定重新查詢才不會讓畫面停在半分鐘前的狀態。
const AUTO_REFRESH_MS = 30000;

const FILTER_STATUS_OPTIONS = [{ value: '', label: '全部狀態（不含已取消）' }, ...BOOKING_STATUS_OPTIONS, ...SYSTEM_ONLY_STATUSES];

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

// 訂單流程進度列：1~9 關橫向排開，每一關顯示目前卡了幾張單，點了就篩選成那一關。
// 關卡數量固定是 9，在小螢幕一定放不下，所以整條做成可橫向捲動，而不是換行擠在一起——
// 換行會讓「流程是一條線」這件事在視覺上斷掉。
function FlowPipeline({
  counts,
  activeStatus,
  onSelectStatus,
}: {
  counts: Record<string, number>;
  activeStatus: string;
  onSelectStatus: (status: string) => void;
}) {
  // 「目前最多」只標在有訂單的關卡上，全部都是 0 的時候不要硬選一關出來標。
  const maxCount = Math.max(0, ...FLOW_STEP_STATUSES.map((s) => counts[s] || 0));

  return (
    <div className="overflow-x-auto pb-1">
      <div className="flex items-stretch gap-0 min-w-max">
        {FLOW_STEP_STATUSES.map((s, i) => {
          const active = activeStatus === s;
          const count = counts[s] || 0;
          const isBusiest = maxCount > 0 && count === maxCount;
          const needsPerson = MANUAL_ACTION_FLOW_STATUSES.includes(s);
          return (
            <div key={s} className="flex items-center">
              <button
                onClick={() => onSelectStatus(s)}
                className={`text-left rounded-xl border-2 px-4 py-3 min-w-[150px] transition-colors ${
                  active ? 'border-green-500 bg-green-50/60' : 'border-gray-200 bg-white hover:border-gray-300'
                }`}
              >
                <span
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    active ? 'bg-green-600 text-white' : count > 0 ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {i + 1}
                </span>
                <p className="mt-2 text-sm font-semibold text-gray-800 whitespace-nowrap">
                  {bookingStatusLabel(s)}
                  {needsPerson && <span className="ml-1.5 text-[10px] font-normal text-amber-600">人工</span>}
                </p>
                <p className="mt-1 text-xs text-gray-500 whitespace-nowrap">
                  {count} 張訂單
                  {isBusiest && <span className="text-gray-400"> · 目前最多</span>}
                </p>
              </button>
              {i < FLOW_STEP_STATUSES.length - 1 && <ChevronRight className="w-4 h-4 text-gray-300 mx-1.5 shrink-0" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 例外／其他流程（取消、退款、待人工確認…）。這些不在 1~9 的線性進度上，所以跟上面的
// 流程列分開呈現，不要混進去讓人以為取消是流程的第 10 關。
function ExceptionStatusRow({
  counts,
  activeStatus,
  onSelectStatus,
}: {
  counts: Record<string, number>;
  activeStatus: string;
  onSelectStatus: (status: string) => void;
}) {
  const pill = (statusValue: string, label: string) => (
    <button
      key={statusValue}
      onClick={() => onSelectStatus(statusValue)}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
        activeStatus === statusValue ? 'ring-2 ring-offset-1 ring-gray-300' : ''
      } ${EXCEPTION_STATUS_STYLE[statusValue] || 'border-gray-200 bg-gray-50 text-gray-600'}`}
    >
      {label}
      <span className="font-bold">{counts[statusValue] || 0}</span>
    </button>
  );

  return (
    <div className="flex flex-wrap gap-2 items-center pt-3 border-t">
      <span className="text-xs text-gray-400 mr-1">例外／其他流程</span>
      {pill('awaiting_refund', bookingStatusLabel('awaiting_refund'))}
      {pill('refunded', bookingStatusLabel('refunded'))}
      {pill('cancelled', bookingStatusLabel('cancelled'))}
      {SYSTEM_ONLY_STATUSES.map((s) => pill(s.value, s.label))}
    </div>
  );
}

// 右側詳情：這張訂單目前卡在第幾關、關鍵金額與日期。純顯示，要改資料按「編輯訂單」。
function OrderDetailPanel({
  order,
  onEdit,
  onDelete,
  onAdvance,
}: {
  order: any | null;
  onEdit: () => void;
  /** 沒有權限刪除時不傳，按鈕就不會出現——而不是給一顆按了必定失敗的鈕。 */
  onDelete?: () => void;
  onAdvance: (nextStatus: string) => void;
}) {
  if (!order) {
    return (
      <div className="bg-white rounded-xl shadow-sm border p-10">
        <EmptyState icon={<ClipboardList className="w-12 h-12 text-gray-200" />} message="從左邊挑一張訂單，這裡會顯示它目前的流程位置" />
      </div>
    );
  }

  const stepIndex = flowStepIndex(order.status);
  const needsPerson = MANUAL_ACTION_STATUSES.includes(order.status);
  // 例外流程（取消／退款／待人工確認／外部平台）沒有「下一關」，nextFlowStatus 回 null，
  // 按鈕就不出現——那些狀態要往哪走是人的判斷，不該給一顆看起來理所當然的按鈕。
  const nextStatus = nextFlowStatus(order.status);
  const balance = order.total_amount != null ? Number(order.total_amount) - Number(order.deposit || 0) : null;
  const money = (v: any) => (v != null ? `NT$ ${Number(v).toLocaleString()}` : '—');
  const slash = (d: any) => (d ? String(d).replace(/-/g, '/') : '—');

  const cell = (label: string, value: string) => (
    <div className="border rounded-lg px-3 py-2.5">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-semibold text-gray-800 mt-0.5">{value}</p>
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow-sm border p-5 space-y-4">
      <div className="flex justify-between items-start gap-3">
        <div className="min-w-0">
          <p className="text-xs text-gray-500 font-mono">訂單 {order.order_number || '—'}</p>
          <h3 className="text-2xl font-bold text-gray-900 mt-0.5 truncate">{order.name || order.nickname || '未取得'}</h3>
          <p className="text-sm text-gray-500 mt-1">
            {stepIndex ? `目前位於第 ${stepIndex} 關：${bookingStatusLabel(order.status)}` : `例外流程：${bookingStatusLabel(order.status)}`}
          </p>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2">
          {needsPerson && (
            <span className="text-xs bg-amber-100 text-amber-800 border border-amber-200 rounded-full px-3 py-1">
              等待處理
            </span>
          )}
          {nextStatus && (
            <Button onClick={() => onAdvance(nextStatus)} icon={<ChevronRight className="w-4 h-4" />}>
              下一步：{bookingStatusLabel(nextStatus)}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {cell('入住日期', slash(order.checkin_date))}
        {cell('退房日期', slash(order.checkout_date))}
        {cell('人數', order.headcount != null ? `${order.headcount} 人` : '—')}
        {cell('房價', money(order.room_amount ?? order.total_amount))}
        {cell('訂金', money(order.deposit))}
        {cell('尾款', balance != null ? money(balance) : '—')}
      </div>

      <div>
        <p className="text-xs text-gray-500 mb-1.5">流程位置</p>
        <div className="flex flex-wrap items-center gap-1">
          {FLOW_STEP_STATUSES.map((s, i) => {
            const n = i + 1;
            const isCurrent = stepIndex === n;
            const isDone = stepIndex != null && n < stepIndex;
            return (
              <span
                key={s}
                title={bookingStatusLabel(s)}
                className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                  isCurrent ? 'bg-green-600 text-white' : isDone ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                }`}
              >
                {n}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button onClick={onEdit} icon={<Save className="w-4 h-4" />}>編輯訂單</Button>
        {onDelete && (
          <Button variant="secondary" onClick={onDelete} icon={<Trash2 className="w-4 h-4" />}>刪除</Button>
        )}
      </div>
    </div>
  );
}

export default function OrderManagement() {
  // 客服看不到刪除相關的入口。真正的防線是資料庫的 RLS（bookings 的 DELETE 政策），
  // 這裡只是不要給一顆按了必定失敗的按鈕。取消訂單走狀態機，不受影響。
  const { role } = useAuth();
  const canDelete = canDeleteBookings(role);

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

  // 清單左右分欄：左邊挑一張單，右邊顯示它目前卡在哪一關。存整個 row 而不是只存 id，
  // 這樣切換選取不用再打一次資料庫（runQuery 本來就 select('*') 全撈回來了）。
  const [selectedOrder, setSelectedOrder] = useState<any | null>(null);
  const [todayCheckins, setTodayCheckins] = useState<any[]>([]);
  const [monthCompleted, setMonthCompleted] = useState(0);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 打開編輯表單當下那一列的原始資料，存檔時用來比對出「這次到底改了什麼」寫進操作紀錄。
  // 不能存檔後再回查一次資料庫——那時候查到的已經是改完的新值，比對出來永遠是沒有差異。
  const [editingOriginal, setEditingOriginal] = useState<any | null>(null);
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

  // 「待我處理」檢視：跨多個狀態，所以不能用單一值的 status 篩選表示，另外開一個開關。
  const [manualOnly, setManualOnly] = useState(false);

  // 押金與訂金比例的預設值來自「房型與報價」的設定，人工建單時按「重算」就會套用同一套算法，
  // 跟 LINE 自動報價算出來的金額一致。
  const [moneyDefaults, setMoneyDefaults] = useState({ wholeHouseSecurity: 3000, percent: 30 });

  // 詳情面板「下一步」的確認視窗。推進狀態是不可逆的動作（會寫進訂單、留下操作紀錄，
  // 待入住那一關還會影響排程），所以一律先問一次，不做「按了就直接改」。
  const [advanceTarget, setAdvanceTarget] = useState<{ order: any; nextStatus: string } | null>(null);
  const [advanceRemit, setAdvanceRemit] = useState('');
  const [advanceError, setAdvanceError] = useState('');
  const [advancing, setAdvancing] = useState(false);

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
    fetchSummaries();
    runQuery(0);
    // 查詢函式每次 render 都是新的參考，放進依賴會無限重查。這裡只要掛載時查一次，之後由「查詢」按鈕觸發。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 每 30 秒自動刷新一次，讓客服不用自己按「查詢」也看得到 LINE 剛進來的新訂單與狀態變化。
  //
  // 用 ref 存「當下這一版的刷新動作」，setInterval 只負責固定時間呼叫它。若改成把 keyword、
  // status、page 這些值列進 useEffect 的依賴，使用者每打一個字都會清掉計時器重新計時，
  // 一直在打字就永遠等不到 30 秒；而只依賴 [] 又會讓 interval 內永遠讀到第一次 render 的
  // 舊值，刷新出來的是初始條件而不是目前畫面上的篩選。
  const autoRefreshRef = useRef<() => void>(() => {});
  autoRefreshRef.current = () => {
    // 編輯視窗開著時不動：使用者正在改這張單，背景把底下的資料換掉只會造成混淆。
    if (showForm) return;
    // 分頁在背景時不查：沒有人在看，卻每 30 秒打一次資料庫。
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    runQuery(page, undefined, { silent: true });
    fetchStatusCounts();
    fetchSummaries();
  };

  useEffect(() => {
    const timer = setInterval(() => autoRefreshRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  // 「訂單流程狀態」進度列的即時筆數：輕量查詢（只抓 status 欄位），前端算每個狀態幾筆。
  const fetchStatusCounts = async () => {
    const { data } = await supabase.from('bookings').select('status');
    const counts: Record<string, number> = {};
    for (const row of data || []) counts[row.status] = (counts[row.status] || 0) + 1;
    setStatusCounts(counts);
  };

  // 頂部三張摘要卡需要的資料。「待我處理」的筆數直接從 statusCounts 算得出來，不用另外查。
  const fetchSummaries = async () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthStart = `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}-01`;

    const [checkinRes, completedRes] = await Promise.all([
      // 今天要入住的訂單。只看還佔著房的狀態——已取消的訂單即使入住日是今天也不該出現在
      // 「今天有誰要來」這張卡片上。
      // 這裡一定要整列撈回來：卡片上的訂單點下去會直接開編輯表單（openEdit），
      // 只撈卡片要顯示的那幾欄的話，表單裡沒撈到的欄位會被當成空值載入，一按儲存
      // 就把電話、押金、備註這些沒顯示在卡片上的資料整批清掉。
      supabase
        .from('bookings')
        .select('*')
        .eq('checkin_date', todayIso)
        .in('status', OCCUPYING_STATUSES)
        .order('created_at'),
      // 本月已完成：用退房日落在本月、且流程已經走到「已處理」的訂單。
      supabase
        .from('bookings')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'completed')
        .gte('checkout_date', monthStart)
        .lt('checkout_date', nextMonthStart),
    ]);

    setTodayCheckins(checkinRes.data || []);
    setMonthCompleted(completedRes.count ?? 0);
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
    // 挑了某一關就是要專看那一關，跟「待我處理」的跨狀態檢視互斥，不然畫面會同時高亮兩種篩選、
    // 但實際只有一種生效。
    setManualOnly(false);
    runQuery(0, { status: next, manualOnly: false });
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
    const { data } = await supabase.from('operational_settings').select('whole_house_security_deposit, deposit_percent').single();
    if (!data) return;
    setMoneyDefaults({
      wholeHouseSecurity: Number(data.whole_house_security_deposit ?? 3000),
      percent: Number(data.deposit_percent ?? 30),
    });
  };

  // 押金預設值：包棟用「計價公式設定 → 房型押金」裡的包棟押金；個別租房用目前勾選房間的押金加總。
  // 抽成函式是因為勾選「是否包棟」的當下也要用它把金額直接填進押金欄位，那時候 form/selectedRoomIds
  // 都還是舊值（setState 還沒生效），不能沿用下面用 state 算出來的 defaultSecurityDeposit。
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
  // opts.silent：每 30 秒自動刷新用。背景刷新不能表現得像使用者自己按了「查詢」——
  // 不顯示「載入中」（列表每半分鐘閃一次很干擾）、不清掉批次勾選（正在勾要刪的訂單會被清空）、
  // 也不把右側詳情跳回第一筆（游標底下的內容突然換掉）。
  const runQuery = async (
    pageIndex: number,
    overrides?: Partial<{ keyword: string; startDate: string; endDate: string; status: string; roomType: string; manualOnly: boolean }>,
    opts?: { silent?: boolean }
  ) => {
    const silent = !!opts?.silent;
    const eff = {
      keyword: overrides?.keyword ?? keyword,
      startDate: overrides?.startDate ?? startDate,
      endDate: overrides?.endDate ?? endDate,
      status: overrides?.status ?? status,
      roomType: overrides?.roomType ?? roomType,
      manualOnly: overrides?.manualOnly ?? manualOnly,
    };
    if (!silent) setLoading(true);
    let query = supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (eff.startDate) query = query.gte('checkin_date', eff.startDate);
    if (eff.endDate) query = query.lte('checkin_date', eff.endDate);
    // 「待我處理」是跨多個狀態的檢視，優先於單一狀態篩選（點它就是想一次看完所有等人動手的單）。
    if (eff.manualOnly) query = query.in('status', MANUAL_ACTION_STATUSES);
    else if (eff.status) query = query.eq('status', eff.status);
    // 「全部狀態」預設不含已取消——第三方平台同步偵測到客戶在 Airbnb/Booking 等平台取消訂單時，
    // 對應的本地訂單只會被標記成 cancelled（保留紀錄供查核），不會整筆刪除；如果預設清單還是
    // 照樣顯示，訂單管理看起來就會跟平台實際的訂房狀況對不起來。要看已取消的訂單，
    // 從「訂單狀態」下拉選單或下面的「取消訂單」例外分支明確篩選即可。
    else query = query.neq('status', 'cancelled');
    if (eff.roomType === '包棟') query = query.eq('whole_house', true);
    else if (eff.roomType) query = query.ilike('room_type_label', `%${eff.roomType}%`);
    if (eff.keyword.trim()) {
      const kw = eff.keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
    }

    const { data, error } = await query;
    if (!error) {
      const nextRows = data || [];
      setRows(nextRows);
      setHasMore(nextRows.length === PAGE_SIZE);
      // 右側詳情永遠對應一筆真的還在清單裡的訂單：換頁或改篩選後，原本選的那筆
      // 可能已經不在這一頁了，留著會變成看著一筆清單上找不到的單在操作。
      // 背景刷新時只更新原本那筆的內容（帶回最新狀態/金額），找不到就維持原狀，
      // 不要在使用者沒動作的情況下自己跳到第一筆。
      setSelectedOrder((prev: any) => {
        const same = nextRows.find((r: any) => r.id === prev?.id);
        if (same) return same;
        return silent ? prev : nextRows[0] || null;
      });
    }
    setPage(pageIndex);
    if (!silent) setSelectedIds([]);
    if (!silent) setLoading(false);
  };

  // 「查看待我處理」：一次看完所有卡在人工關卡的訂單（流程 3/5/8 ＋ 例外流程）。
  const showManualQueue = () => {
    setManualOnly(true);
    setStatus('');
    runQuery(0, { manualOnly: true, status: '' });
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
      const deletedRows = rows.filter((r) => selectedIds.includes(r.id));
      const { error } = await supabase.from('bookings').delete().in('id', selectedIds);
      if (error) throw error;
      // 批次刪除一次寫一筆紀錄、列出被刪掉的訂單編號。拆成每張單一筆的話，一次刪 20 張
      // 就會在紀錄裡刷掉整頁，反而看不出「這是同一次批次操作」。
      await logOperation({
        feature: LOG_FEATURES.order,
        action: '批次刪除',
        target: `共 ${deletedRows.length} 筆`,
        before: { 訂單編號: deletedRows.map((r) => r.order_number || r.id).join('、') },
        after: null,
      });
      setShowBatchConfirm(false);
      setSelectedIds([]);
      runQuery(page);
      fetchStatusCounts();
    } catch (err: any) {
      alert(`批次刪除失敗：${err.message}`);
      await logUiError({ feature: LOG_FEATURES.order, action: '批次刪除失敗', target: `共 ${selectedIds.length} 筆`, error: err });
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
    setManualOnly(false);
    runQuery(0, { keyword: '', startDate: '', endDate: '', status: '', roomType: '', manualOnly: false });
  };

  const openNew = () => {
    setEditingId(null);
    setEditingOriginal(null);
    // 新訂單一開始就是包棟（emptyForm 的 whole_house 是 true），押金欄位直接帶入包棟押金，
    // 不要只放在 placeholder 裡當提示——欄位留空存檔會被存成 0，畫面上看到 3000、實際存 0。
    setForm({ ...emptyForm(), security_deposit: String(moneyDefaults.wholeHouseSecurity) });
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
    setEditingOriginal(row);
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

  const openAdvance = (order: any, nextStatus: string) => {
    // 「待確認 → 已預定」代表客服核對到訂金入帳，末5碼是核對的憑據，所以帶出訂單上已有的值
    // 讓客服確認，不是每次都要重打。
    setAdvanceRemit(order.remit_last5 || '');
    setAdvanceError('');
    setAdvanceTarget({ order, nextStatus });
  };

  const confirmAdvance = async () => {
    if (!advanceTarget) return;
    const { order, nextStatus } = advanceTarget;
    const needsRemit = nextStatus === REQUIRES_REMIT_LAST5_STATUS;
    const remit = advanceRemit.trim();
    if (needsRemit && !remit) {
      setAdvanceError('請先填寫匯款末5碼再推進到「已預定」。');
      return;
    }
    setAdvancing(true);
    setAdvanceError('');
    try {
      const payload: Record<string, any> = { status: nextStatus, updated_at: new Date().toISOString() };
      if (needsRemit) payload.remit_last5 = remit;
      const { error } = await supabase.from('bookings').update(payload).eq('id', order.id);
      if (error) throw error;

      const diff = diffRecords(order, payload, Object.keys(payload));
      await logOperation({
        feature: LOG_FEATURES.order,
        action: '狀態變更',
        target: order.order_number || order.id,
        before: diff.before,
        after: diff.after,
      });

      setAdvanceTarget(null);
      runQuery(page);
      fetchStatusCounts();
      fetchSummaries();
    } catch (err: any) {
      setAdvanceError(`推進失敗：${err.message}`);
      await logUiError({ feature: LOG_FEATURES.order, action: '狀態變更失敗', target: order.order_number || null, error: err });
    } finally {
      setAdvancing(false);
    }
  };

  // overrideStatus：「儲存並前往下一階段」「取消訂單」用的，帶入這次要寫進去的狀態。
  // 不先 setForm 再存的原因跟 selectStatusFilter 一樣——setState 是非同步的，
  // 這一輪讀到的還會是舊狀態，存進去的就不是使用者按下按鈕想要的那一關。
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
        // 留空時存的是畫面上 placeholder 顯示的那個預設金額，不是 0——欄位提示寫著 3000
        // 卻默默存成 0，訂單總額與押金退款都會跟著錯，而且畫面上完全看不出來。
        security_deposit: form.security_deposit === '' ? defaultSecurityDeposit : Number(form.security_deposit),
        total_amount: form.total_amount === '' ? null : Number(form.total_amount),
        deposit: form.deposit === '' ? null : Number(form.deposit),
        remit_last5: form.remit_last5 || null,
        // 只有狀態為「待入住」才允許有值——不是這個狀態時，即使欄位裡還留著文字（例如狀態被改回
        // 更早的步驟），存檔時一律清空，不要讓舊密碼在不該生效的狀態下還留著造成誤導。
        check_in_password: targetStatus === REQUIRES_CHECKIN_PASSWORD_STATUS ? (form.check_in_password || null) : null,
        status: targetStatus,
        notes: form.notes || null,
        updated_at: new Date().toISOString(),
      };

      let bookingId = editingId;
      let createdOrderNumber = '';
      if (editingId) {
        const { error } = await supabase.from('bookings').update(payload).eq('id', editingId);
        if (error) throw error;
      } else {
        let lastError: any = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const orderNumber = generateOrderNumber();
          const { data, error } = await supabase
            .from('bookings')
            .insert({ ...payload, order_number: orderNumber })
            .select('id')
            .single();
          if (!error) { lastError = null; bookingId = data.id; createdOrderNumber = orderNumber; break; }
          lastError = error;
          if (!String(error.message || '').includes('order_number')) break;
        }
        if (lastError) throw lastError;
      }

      if (bookingId) await saveLinen(bookingId);

      // 操作紀錄：只在訂單本身真的存成功之後才寫，寫失敗也不影響這次存檔（見 writeOperationLog）。
      if (editingId) {
        const diff = diffRecords(editingOriginal, payload, Object.keys(payload));
        if (diff.changed) {
          await logOperation({
            feature: LOG_FEATURES.order,
            // 狀態有變就標成「狀態變更」，查紀錄時最常找的就是「這張單什麼時候被推到下一關」。
            action: diff.after['訂單狀態'] !== undefined ? '狀態變更' : '修改',
            target: form.order_number || editingId,
            before: diff.before,
            after: diff.after,
          });
        }
      } else {
        await logOperation({
          feature: LOG_FEATURES.order,
          action: '新增',
          target: createdOrderNumber,
          before: null,
          after: labelRecord(payload, ['name', 'phone', 'checkin_date', 'checkout_date', 'headcount', 'whole_house', 'room_amount', 'security_deposit', 'total_amount', 'deposit', 'status']),
        });
      }

      setShowForm(false);
      runQuery(page);
      fetchStatusCounts();
      fetchSummaries();
    } catch (err: any) {
      setFormError(`儲存失敗：${err.message}`);
      await logUiError({ feature: LOG_FEATURES.order, action: editingId ? '修改失敗' : '新增失敗', target: form.order_number || null, error: err });
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
      // 刪除是唯一救不回來的操作，異動前的內容一定要留下來，之後才查得到「被刪掉的是什麼」。
      await logOperation({
        feature: LOG_FEATURES.order,
        action: '刪除',
        target: deleteTarget.order_number || deleteTarget.id,
        before: labelRecord(deleteTarget, ['order_number', 'name', 'phone', 'checkin_date', 'checkout_date', 'headcount', 'room_type_label', 'total_amount', 'deposit', 'status']),
        after: null,
      });
      setDeleteTarget(null);
      runQuery(page);
      fetchStatusCounts();
    } catch (err: any) {
      alert(`刪除失敗：${err.message}`);
      await logUiError({ feature: LOG_FEATURES.order, action: '刪除失敗', target: deleteTarget?.order_number || null, error: err });
    } finally {
      setDeleting(false);
    }
  };

  // 系統專用狀態不開放手動選，但如果這張訂單「現在剛好就是」系統專用狀態（例如系統偵測到檔期
  // 衝突、或是外部平台同步進來的），下拉選單還是要能顯示目前這個值，不然編輯畫面會顯示成空白選項。
  const currentSystemOnlyStatus = SYSTEM_ONLY_STATUSES.find((s) => s.value === form.status);
  const formStatusOptions = currentSystemOnlyStatus ? [currentSystemOnlyStatus, ...BOOKING_STATUS_OPTIONS] : BOOKING_STATUS_OPTIONS;

  // 「待我處理」卡片的總數與明細。全部從已經抓好的 statusCounts 算，不用另外查資料庫。
  const manualTotal = MANUAL_ACTION_STATUSES.reduce((sum, s) => sum + (statusCounts[s] || 0), 0);
  const manualBreakdown = MANUAL_ACTION_STATUSES
    .map((s) => ({ status: s, label: bookingStatusLabel(s), count: statusCounts[s] || 0 }))
    .filter((x) => x.count > 0);

  return (
    <div className="w-full space-y-5">
      <div className="bg-white p-5 rounded-xl shadow-sm border flex flex-wrap justify-between items-center gap-3">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <ClipboardList className="w-6 h-6 text-green-600" />
          訂單流程中心
        </h2>
        <div className="flex items-center gap-2">
          {/* 「批次操作」目前唯一的用途就是批次刪除，沒有刪除權限的人不需要看到它 */}
          {canDelete && (
            <Button variant={batchMode ? 'primary' : 'secondary'} onClick={toggleBatchMode} icon={<Trash2 className="w-4 h-4" />}>
              {batchMode ? '結束批次操作' : '批次操作'}
            </Button>
          )}
          {canDelete && batchMode && selectedIds.length > 0 && (
            <Button variant="danger" onClick={() => setShowBatchConfirm(true)} icon={<Trash2 className="w-4 h-4" />}>
              刪除選取（{selectedIds.length}）
            </Button>
          )}
          <Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增訂單</Button>
        </div>
      </div>

      <div className="bg-white p-5 rounded-xl shadow-sm border space-y-4">
        <div className="flex flex-wrap justify-between items-start gap-3">
          <div>
            <h3 className="text-lg font-bold text-gray-800 flex items-center gap-1.5">目前訂單流程 <StatusHelpIcon /></h3>
            <p className="text-sm text-gray-500 mt-0.5">先看每一關有多少訂單，再進入需要處理的單據。</p>
          </div>
          <Button variant={manualOnly ? 'primary' : 'secondary'} onClick={showManualQueue} icon={<UserCheck className="w-4 h-4" />}>
            查看待我處理
          </Button>
        </div>
        <FlowPipeline counts={statusCounts} activeStatus={manualOnly ? '' : status} onSelectStatus={selectStatusFilter} />
        <ExceptionStatusRow counts={statusCounts} activeStatus={manualOnly ? '' : status} onSelectStatus={selectStatusFilter} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* 待我處理：流程 3/5/8 這三個人工關卡＋例外流程，全部加總。 */}
        <button
          onClick={showManualQueue}
          className={`text-left bg-white p-5 rounded-xl shadow-sm border transition-colors hover:border-amber-300 ${manualOnly ? 'border-amber-400 ring-2 ring-amber-100' : ''}`}
        >
          <p className="text-sm font-semibold text-gray-700">待我處理</p>
          <p className="mt-1 text-4xl font-bold text-gray-900">{manualTotal}</p>
          <span className="inline-block mt-2 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2 py-0.5">
            全部人工工作
          </span>
          <p className="mt-2 text-xs text-gray-500 leading-relaxed">
            {manualBreakdown.length
              ? manualBreakdown.map((b) => `${b.label} ${b.count}`).join(' · ')
              : '目前沒有等待人工處理的訂單'}
          </p>
        </button>

        {/* 今日入住 */}
        <div className="bg-white p-5 rounded-xl shadow-sm border">
          <div className="flex justify-between items-start gap-2">
            <div>
              <p className="text-sm font-semibold text-gray-700 flex items-center gap-1.5"><LogIn className="w-4 h-4 text-sky-600" />入住訂單</p>
              <p className="text-xs text-gray-400 mt-0.5">點擊即可開啟該筆訂單詳細</p>
            </div>
            <span className="text-xs bg-sky-50 text-sky-700 border border-sky-200 rounded-full px-2 py-0.5 whitespace-nowrap">
              今日 {todayCheckins.length} 筆
            </span>
          </div>
          {todayCheckins.length === 0 ? (
            <p className="mt-4 text-xs text-gray-400">今天沒有訂單入住。</p>
          ) : (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {todayCheckins.map((b) => (
                <button
                  key={b.id}
                  onClick={() => openEdit(b)}
                  className="text-left shrink-0 w-44 border rounded-lg p-3 hover:bg-sky-50 hover:border-sky-300 transition-colors"
                >
                  <p className="font-semibold text-sm text-gray-800 truncate">{b.name || b.nickname || '未取得'}</p>
                  <p className="text-xs text-gray-500 mt-1 font-mono">{b.order_number || '-'}　{b.headcount ?? '-'} 人</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    今日入住 · NT$ {b.total_amount != null ? Number(b.total_amount).toLocaleString() : '-'}
                  </p>
                  <span className="text-xs text-sky-600 mt-1.5 inline-block">查看訂單 →</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 本月已完成 */}
        <div className="bg-white p-5 rounded-xl shadow-sm border">
          <p className="text-sm font-semibold text-gray-700">本月已完成</p>
          <p className="mt-1 text-4xl font-bold text-green-700">{monthCompleted}</p>
          <span className="inline-block mt-2 text-xs bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5">
            <CheckCircle2 className="w-3 h-3 inline mr-1 -mt-0.5" />流程完成
          </span>
          <p className="mt-2 text-xs text-gray-500">退房日落在本月、且流程已走到「已處理」的訂單。</p>
        </div>
      </div>

      <FilterBar activeCount={[keyword, startDate, endDate, status, roomType].filter(Boolean).length}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
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
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><DoorOpen className="w-3.5 h-3.5" />房型</label>
            <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">全部房型</option>
              <option value="包棟">包棟</option>
              {roomTypeOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><ListFilter className="w-3.5 h-3.5" />流程</label>
            <select
              value={manualOnly ? '__manual__' : status}
              onChange={(e) => {
                if (e.target.value === '__manual__') { showManualQueue(); return; }
                setManualOnly(false);
                setStatus(e.target.value);
              }}
              className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
            >
              {FILTER_STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              <option value="__manual__">待我處理（人工關卡）</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={clearFilters} icon={<RotateCcw className="w-4 h-4" />}>清除條件</Button>
          <Button onClick={() => runQuery(0)} loading={loading} icon={<Search className="w-4 h-4" />}>查詢</Button>
        </div>
      </FilterBar>

      {/* 左邊挑單、右邊看它卡在哪一關。挑單不會直接跳進編輯畫面——大多數時候只是想確認
          「這張現在到哪了」，要真的改資料再按「編輯訂單」進表單。 */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_1fr] gap-4 items-start">
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          {batchMode && rows.length > 0 && (
            <label className="flex items-center gap-2 px-4 py-2.5 border-b bg-gray-50 text-xs text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.length === rows.length}
                onChange={toggleSelectAll}
                className="w-4 h-4"
              />
              全選這一頁（{selectedIds.length}/{rows.length}）
            </label>
          )}
          {/* 分隔線改由每一列自己畫（border-b），不用 divide-y：divide-{color} 會在每個子元素上
              設 border-color 這個「簡寫」屬性，把各列依狀態上色的 border-l-* 整個蓋掉。 */}
          <div className="max-h-[560px] overflow-y-auto">
            {loading ? (
              <p className="py-10 text-center text-gray-400 text-sm">載入中...</p>
            ) : rows.length === 0 ? (
              <EmptyState icon={<ClipboardList className="w-12 h-12 text-gray-200" />} message="查無符合條件的訂單" />
            ) : (
              rows.map((row) => {
                const isSelected = selectedOrder?.id === row.id;
                return (
                  <div
                    key={row.id}
                    onClick={() => (batchMode ? toggleSelectRow(row.id) : setSelectedOrder(row))}
                    // 底色與左側色條一律照狀態上色（見 bookingStatus.ts 的 rowClassName），
                    // 選取中的那列不換掉底色、改用綠色外框＋色條標示——不然「目前選哪張」跟
                    // 「這張是什麼狀態」會互相蓋掉，只剩一個看得到。
                    // hover 用 brightness 而不是換成灰底，才不會一滑過去就把狀態色洗掉。
                    className={`px-4 py-3 cursor-pointer transition-colors border-l-4 border-b border-b-gray-100 ${bookingStatusRowClass(row.status)} ${
                      isSelected && !batchMode
                        ? '!border-l-green-500 ring-2 ring-inset ring-green-500/40'
                        : 'hover:brightness-95'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {batchMode && (
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(row.id)}
                          onChange={() => toggleSelectRow(row.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-4 h-4 mt-1"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-gray-800 truncate">
                            <span className="font-mono text-xs text-gray-500">{row.order_number || '-'}</span>
                            <span className="mx-1.5 text-gray-300">·</span>
                            {row.name || row.nickname || '未取得'}
                          </p>
                          <StatusBadge status={row.status} />
                        </div>
                        <p className="text-xs text-gray-500 mt-1">
                          {row.checkin_date ? String(row.checkin_date).replace(/-/g, '/') : '-'}
                          {' → '}
                          {row.checkout_date ? String(row.checkout_date).replace(/-/g, '/') : '-'}
                          {' · '}
                          {row.headcount ?? '-'} 人
                        </p>
                        <p className="text-xs text-gray-600 mt-0.5">
                          {row.total_amount != null ? `NT$ ${Number(row.total_amount).toLocaleString()}` : '-'}
                        </p>
                        {/* 第三方同步進來、日期跟其他訂單重疊的訂單。依規格兩筆都保留不自動合併，
                            只在這裡標記出來讓人工核實是不是真的超賣（推播只會在偵測到的當下發一次，
                            漏看就沒了，所以清單上也要看得到）。 */}
                        {row.ota_conflict_detected_at && (
                          <span className="mt-1 inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 rounded-full px-2 py-0.5" title="這筆第三方訂單跟其他訂單日期重疊，請人工核實是否超賣">
                            <AlertTriangle className="w-3 h-3" />疑似撞期
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="flex justify-between items-center px-4 py-3 border-t text-xs text-gray-500">
            <button disabled={page === 0 || loading} onClick={() => runQuery(page - 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">上一頁</button>
            <span>第 {page + 1} 頁</span>
            <button disabled={!hasMore || loading} onClick={() => runQuery(page + 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">下一頁</button>
          </div>
        </div>

        <OrderDetailPanel
          order={selectedOrder}
          onEdit={() => selectedOrder && openEdit(selectedOrder)}
          onDelete={canDelete ? () => selectedOrder && setDeleteTarget(selectedOrder) : undefined}
          onAdvance={(nextStatus) => selectedOrder && openAdvance(selectedOrder, nextStatus)}
        />
      </div>

      <Modal
        open={showForm}
        title={editingId ? `編輯訂單 · ${form.order_number || ''}` : '新增訂單'}
        onClose={closeForm}
        maxWidth="max-w-5xl"
        footer={
          <>
            <Button variant="secondary" onClick={closeForm}>關閉</Button>
            <Button onClick={() => saveForm()} loading={saving} icon={<Save className="w-4 h-4" />}>{saving ? '儲存中...' : '儲存變更'}</Button>
          </>
        }
      >
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(0,300px)] gap-4 items-start">
      <div className="space-y-4">
        <div className="border rounded-xl p-4">
          <h4 className="text-sm font-bold text-gray-800 mb-3">住宿與客人資料</h4>
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
                  const wholeHouse = e.target.checked;
                  // 這個勾選框只決定一件事：押金要用「包棟押金」還是「已選房間的押金加總」。
                  // 刻意不動房型選取——要整理哪幾間房是另一回事，由上面的房型按鈕自己決定，
                  // 勾一下包棟就把房間全選會蓋掉客服已經挑好的房間，那是資料被改掉、不是預設值。
                  setForm({
                    ...form,
                    whole_house: wholeHouse,
                    security_deposit: String(computeDefaultSecurityDeposit(wholeHouse, selectedRoomIds)),
                  });
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
        </div>
        </div>

        <div className="border rounded-xl p-4">
          <h4 className="text-sm font-bold text-gray-800 mb-3">費用資訊</h4>
        <div className="grid grid-cols-2 gap-3">
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
        </div>
          <p className="text-xs text-green-700 bg-green-50 border border-green-100 rounded-lg px-3 py-2 mt-3">
            ✓ 系統自動計算：訂單總額 ＝ 房價 ＋ 押金；訂金 ＝ 房價 × {moneyDefaults.percent}%
          </p>
        </div>

        <div className="border rounded-xl p-4">
          <h4 className="text-sm font-bold text-gray-800 mb-3">款項核對與備註</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              匯款末5碼{form.status === REQUIRES_REMIT_LAST5_STATUS && <span className="text-red-500"> *</span>}
            </label>
            <input value={form.remit_last5} onChange={(e) => setForm({ ...form, remit_last5: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="狀態設為「已預定」時必填" />
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
      </div>

      {/* 右側：這張訂單目前在流程的哪一關，以及可以把它往前推的動作。 */}
      <div className="border rounded-xl p-4 space-y-4 lg:sticky lg:top-2">
        <div>
          <p className="text-xs text-gray-500 mb-1.5">訂單狀態</p>
          <div className="flex items-center justify-between gap-2">
            <StatusBadge status={form.status} />
            <span className="text-xs text-gray-400">
              {flowStepIndex(form.status) ? `流程 ${flowStepIndex(form.status)}/${FLOW_STEP_STATUSES.length}` : '例外流程'}
            </span>
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-500">本次訂單總額</p>
          <p className="text-3xl font-bold text-gray-900 mt-0.5">
            NT$ {form.total_amount === '' ? '—' : Number(form.total_amount).toLocaleString()}
          </p>
        </div>

        {/* 只顯示前一關／目前這關／下一關，不把 9 關全列出來——編輯畫面要回答的是
            「現在在哪、下一步是什麼」，不是整條流程長什麼樣（那在主畫面看）。 */}
        {flowStepIndex(form.status) && (
          <div>
            <p className="text-xs text-gray-500 mb-1.5">目前流程</p>
            <div className="flex items-center gap-1.5">
              {FLOW_STEP_STATUSES.map((s, i) => {
                const n = i + 1;
                const current = flowStepIndex(form.status)!;
                if (n < current - 1 || n > current + 1) return null;
                return (
                  <div
                    key={s}
                    className={`flex-1 rounded-lg border-2 px-2 py-1.5 text-center ${
                      n === current ? 'border-green-500 bg-green-50' : 'border-gray-200'
                    }`}
                  >
                    <p className={`text-xs font-bold ${n === current ? 'text-green-700' : 'text-gray-400'}`}>{n}</p>
                    <p className="text-[11px] text-gray-600 whitespace-nowrap">{bookingStatusLabel(s)}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="space-y-2">
          {nextFlowStatus(form.status) && (
            <Button
              fullWidth
              onClick={() => saveForm(nextFlowStatus(form.status)!)}
              loading={saving}
              icon={<CheckCircle2 className="w-4 h-4" />}
            >
              儲存並前往「{bookingStatusLabel(nextFlowStatus(form.status)!)}」
            </Button>
          )}
          <Button fullWidth variant="secondary" onClick={() => saveForm()} loading={saving}>僅儲存資料</Button>
          {form.status !== 'cancelled' && (
            <Button fullWidth variant="danger" onClick={() => saveForm('cancelled')} loading={saving} icon={<X className="w-4 h-4" />}>
              取消訂單
            </Button>
          )}
        </div>

        <div>
          <label className="flex items-center gap-1 text-xs text-gray-500 mb-1">直接指定狀態 <StatusHelpIcon /></label>
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="w-full px-3 py-2 border rounded-lg bg-white text-sm">
            {formStatusOptions.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
          </select>
        </div>

        {/* 操作紀錄：系統沒有訂單異動歷程表，所以這裡只列真的存得到的兩個時間點
            （建立、最後一次異動），不去推測中間經過哪些關卡、也不假裝知道是誰改的。 */}
        {editingId && (
          <div className="border-t pt-3">
            <p className="text-xs text-gray-500 mb-2">操作紀錄</p>
            <div className="space-y-2.5">
              <div className="flex gap-2">
                <span className="w-5 h-5 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-[10px] shrink-0">✓</span>
                <div>
                  <p className="text-xs font-medium text-gray-700">建立訂單</p>
                  <p className="text-[11px] text-gray-400">{formatDateTime(form.created_at) || '—'}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <span className="w-5 h-5 rounded-full bg-gray-800 text-white flex items-center justify-center text-[10px] shrink-0">
                  {flowStepIndex(form.status) ?? '!'}
                </span>
                <div>
                  <p className="text-xs font-medium text-gray-700">目前：{bookingStatusLabel(form.status)}</p>
                  <p className="text-[11px] text-gray-400">
                    {MANUAL_ACTION_STATUSES.includes(form.status) ? '等待人工處理' : '流程進行中'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
      </Modal>

      {/* 「下一步」的確認視窗。用 Modal 而不是 ConfirmDialog，是因為推到「已預定」那一關
          要在同一個視窗裡填匯款末5碼——ConfirmDialog 只有一句話跟兩顆按鈕，塞不進輸入欄位。 */}
      <Modal
        open={!!advanceTarget}
        title="推進訂單狀態"
        maxWidth="max-w-md"
        onClose={() => setAdvanceTarget(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdvanceTarget(null)} disabled={advancing}>取消</Button>
            <Button onClick={confirmAdvance} loading={advancing} icon={<ChevronRight className="w-4 h-4" />}>
              {advanceTarget ? bookingStatusLabel(advanceTarget.nextStatus) : ''}
            </Button>
          </>
        }
      >
        {advanceTarget && (
          <>
            <p className="text-sm text-gray-700">
              訂單 <span className="font-mono">{advanceTarget.order.order_number || ''}</span>
              （{advanceTarget.order.name || advanceTarget.order.nickname || '未取得'}）
            </p>
            <p className="text-sm text-gray-700">
              目前是「{bookingStatusLabel(advanceTarget.order.status)}」，要推進到
              「<strong>{bookingStatusLabel(advanceTarget.nextStatus)}</strong>」嗎？
            </p>
            <p className="text-xs text-gray-500">{bookingStatusDescription(advanceTarget.nextStatus)}</p>

            {advanceTarget.nextStatus === REQUIRES_REMIT_LAST5_STATUS && (
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  匯款末5碼<span className="text-red-500"> *</span>
                </label>
                <input
                  value={advanceRemit}
                  onChange={(e) => setAdvanceRemit(e.target.value)}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="核對到帳的匯款末5碼"
                  autoFocus
                />
                <p className="text-xs text-gray-400 mt-1">「已預定」代表訂金已經核對入帳，所以這一欄必填。</p>
              </div>
            )}

            {advanceError && (
              <p className="flex items-start gap-1.5 text-sm text-red-600">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{advanceError}</span>
              </p>
            )}
          </>
        )}
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

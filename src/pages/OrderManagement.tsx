import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ClipboardList, Search, RotateCcw, Save, Plus, Trash2, AlertCircle, Shirt, RefreshCw } from 'lucide-react';
import { PageHeader, Button, Modal, StatusBadge, EmptyState, ConfirmDialog } from '../components/ui';
import { BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUS, REQUIRES_REMIT_LAST5_STATUS } from '../lib/bookingStatus';
import {
  LinenItem, RoomLinenDefault, LinenUsageRow,
  linenItemLabel, currency, nightsBetween, computeUsage, mergeUsage, usageTotal,
} from '../lib/linenCost';

const PAGE_SIZE = 15;

const FILTER_STATUS_OPTIONS = [{ value: '', label: '全部狀態' }, ...BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUS];

interface OrderForm {
  id?: string;
  order_number?: string;
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
  total_amount: string;
  deposit: string;
  remit_last5: string;
  status: string;
  notes: string;
}

const emptyForm = (): OrderForm => ({
  name: '', nickname: '', line_user_id: '', phone: '',
  checkin_date: '', checkout_date: '', headcount: '', adults: '', kids: '', infants: '',
  whole_house: false, room_type_label: '', total_amount: '', deposit: '', remit_last5: '',
  status: 'inquiring', notes: '',
});

function generateOrderNumber(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `${y}${m}${day}-${rand}`;
}

function StatusHelpIcon() {
  return (
    <div className="group relative inline-flex">
      <AlertCircle className="w-3.5 h-3.5 text-gray-400 cursor-help" />
      <div className="hidden group-hover:block absolute z-20 left-0 top-5 w-80 bg-gray-800 text-white text-xs rounded-lg p-3 space-y-1.5 shadow-lg">
        {[...BOOKING_STATUS_OPTIONS, SYSTEM_ONLY_STATUS].map((s) => (
          <div key={s.value}><strong className="text-white">{s.label}</strong>：<span className="text-gray-300">{s.description}</span></div>
        ))}
      </div>
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

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<OrderForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 布巾備品：實際開了哪幾間房決定送洗成本（「包棟」只是使用權名稱，不影響算法）
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [linenItems, setLinenItems] = useState<LinenItem[]>([]);
  const [linenDefaults, setLinenDefaults] = useState<RoomLinenDefault[]>([]);
  const [selectedRoomIds, setSelectedRoomIds] = useState<string[]>([]);
  const [usageRows, setUsageRows] = useState<LinenUsageRow[]>([]);
  // 打開表單載入既有資料時不要馬上重算，否則會把之前的人工調整蓋掉
  const skipRecompute = useRef(true);

  useEffect(() => {
    fetchRoomTypeOptions();
    fetchLinenSetup();
    runQuery(0);
  }, []);

  // 換房間或改日期才重算；已手動調整過的品項由 mergeUsage 保留
  useEffect(() => {
    if (skipRecompute.current) { skipRecompute.current = false; return; }
    const nights = nightsBetween(form.checkin_date, form.checkout_date);
    setUsageRows((prev) => mergeUsage(prev, computeUsage(selectedRoomIds, linenDefaults, nights, linenItems)));
  }, [selectedRoomIds, form.checkin_date, form.checkout_date, linenDefaults, linenItems]);

  const fetchRoomTypeOptions = async () => {
    const { data } = await supabase.from('room_types').select('id, name').eq('type', '房間').order('display_order');
    setRooms((data || []).map((r: any) => ({ id: r.id, name: r.name })));
    setRoomTypeOptions((data || []).map((r: any) => r.name));
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
    const nights = nightsBetween(form.checkin_date, form.checkout_date);
    setUsageRows(computeUsage(selectedRoomIds, linenDefaults, nights, linenItems));
  };

  const runQuery = async (pageIndex: number) => {
    setLoading(true);
    let query = supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (startDate) query = query.gte('checkin_date', startDate);
    if (endDate) query = query.lte('checkin_date', endDate);
    if (status) query = query.eq('status', status);
    if (roomType === '包棟') query = query.eq('whole_house', true);
    else if (roomType) query = query.ilike('room_type_label', `%${roomType}%`);
    if (keyword.trim()) {
      const kw = keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
    }

    const { data, error } = await query;
    if (!error) {
      setRows(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setLoading(false);
  };

  const clearFilters = () => {
    setKeyword('');
    setStartDate('');
    setEndDate('');
    setStatus('');
    setRoomType('');
    setTimeout(() => runQuery(0), 0);
  };

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    skipRecompute.current = true;
    setSelectedRoomIds([]);
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
      total_amount: row.total_amount != null ? String(row.total_amount) : '',
      deposit: row.deposit != null ? String(row.deposit) : '',
      remit_last5: row.remit_last5 || '',
      status: row.status,
      notes: row.notes || '',
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
        room_type_label: form.room_type_label || null,
        total_amount: form.total_amount === '' ? null : Number(form.total_amount),
        deposit: form.deposit === '' ? null : Number(form.deposit),
        remit_last5: form.remit_last5 || null,
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
    } catch (err: any) {
      alert(`刪除失敗：${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const balanceDue = (row: any) => (row.total_amount != null ? row.total_amount - (row.deposit ?? 0) : null);

  const formStatusOptions = form.status === SYSTEM_ONLY_STATUS.value ? [SYSTEM_ONLY_STATUS, ...BOOKING_STATUS_OPTIONS] : BOOKING_STATUS_OPTIONS;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        icon={<ClipboardList className="w-6 h-6 text-green-600" />}
        title="訂單管理"
        description="新增、查詢、檢視與編輯所有訂房紀錄。"
        action={<Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增訂單</Button>}
      />

      <div className="bg-white p-4 rounded-xl shadow-sm border space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 mb-1">關鍵字搜尋</label>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runQuery(0)} placeholder="搜尋姓名、電話或訂單編號" className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住日期（起）</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住日期（迄）</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">訂單狀態</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 border rounded-lg text-sm bg-white">
              {FILTER_STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">房型</label>
            <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">全部房型</option>
              <option value="包棟">包棟</option>
              {roomTypeOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </div>
          <Button onClick={() => runQuery(0)} loading={loading} icon={<Search className="w-4 h-4" />}>查詢</Button>
          <Button variant="secondary" onClick={clearFilters} icon={<RotateCcw className="w-4 h-4" />}>清除條件</Button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">訂單編號</th>
                <th className="py-3 px-4">姓名</th>
                <th className="py-3 px-4">入住日期</th>
                <th className="py-3 px-4">退房日期</th>
                <th className="py-3 px-4">人數</th>
                <th className="py-3 px-4">房型</th>
                <th className="py-3 px-4">總報價</th>
                <th className="py-3 px-4">尾款</th>
                <th className="py-3 px-4">狀態</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={10} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={10}><EmptyState icon={<ClipboardList className="w-12 h-12 text-gray-200" />} message="查無符合條件的訂單" /></td></tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} onClick={() => openEdit(row)} className="hover:bg-green-50 transition-colors cursor-pointer">
                    <td className="py-3 px-4 font-mono text-xs text-gray-500">{row.order_number || '-'}</td>
                    <td className="py-3 px-4 font-medium text-gray-800">{row.name || row.nickname || '未取得'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.checkin_date ? String(row.checkin_date).replace(/-/g, '/') : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.checkout_date ? String(row.checkout_date).replace(/-/g, '/') : '-'}</td>
                    <td className="py-3 px-4">{row.headcount ?? '-'}</td>
                    <td className="py-3 px-4">{row.room_type_label || (row.whole_house ? '包棟' : '-')}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.total_amount != null ? `NT$ ${Number(row.total_amount).toLocaleString()}` : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{balanceDue(row) != null ? `NT$ ${Number(balanceDue(row)).toLocaleString()}` : '-'}</td>
                    <td className="py-3 px-4"><StatusBadge status={row.status} /></td>
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
            <input value={form.line_user_id} onChange={(e) => setForm({ ...form, line_user_id: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="非 LINE 客戶可留空" />
          </div>
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
          <div>
            <label className="block text-xs text-gray-500 mb-1">房型</label>
            <input value={form.room_type_label} onChange={(e) => setForm({ ...form, room_type_label: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：2F-暖木(2人)" />
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
              <input type="checkbox" checked={form.whole_house} onChange={(e) => setForm({ ...form, whole_house: e.target.checked })} className="w-4 h-4" />
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
            <label className="block text-xs text-gray-500 mb-1">總金額</label>
            <input type="number" value={form.total_amount} onChange={(e) => setForm({ ...form, total_amount: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">訂金</label>
            <input type="number" value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
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
                住 {nightsBetween(form.checkin_date, form.checkout_date) || '—'} 晚
              </span>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1.5">
                實際開出去的房間（包棟也請照實勾選，成本是看開了幾間房算的）
              </label>
              {rooms.length === 0 ? (
                <p className="text-xs text-gray-400">還沒有「房間」類型的資料，請先到「房型與空間維護」新增。</p>
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
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {selectedRoomIds.length === 0 && usageRows.length === 0 ? (
              <p className="text-xs text-gray-400">勾選房間後，會依「布巾備品」設定的預設組合自動帶出用量。</p>
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
    </div>
  );
}

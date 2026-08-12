import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Shirt, Plus, Pencil, Trash2, AlertTriangle, BedDouble, BarChart3, RefreshCw, Package } from 'lucide-react';
import { PageHeader, Button, Modal, ConfirmDialog, EmptyState } from '../components/ui';
import {
  LinenItem, RoomLinenDefault, linenItemLabel, currency, nightsBetween, computeUsage, usageTotal,
} from '../lib/linenCost';
import { roomLabel } from '../lib/rooms';

// 原本是「耗材維護」跟「布巾備品」兩個獨立頁面，都是「某個補給品項目 ↔ 對應到哪些房型/空間」
// 的同一套關聯結構（consumable_spaces 對 room_type_linen_defaults），合成一頁四個分頁。
type Tab = 'consumables' | 'items' | 'defaults' | 'report';

const TABS: { key: Tab; label: string; icon: JSX.Element }[] = [
  { key: 'consumables', label: '耗材維護', icon: <Package className="w-4 h-4" /> },
  { key: 'items', label: '布巾品項與單價', icon: <Shirt className="w-4 h-4" /> },
  { key: 'defaults', label: '房間預設組合', icon: <BedDouble className="w-4 h-4" /> },
  { key: 'report', label: '布巾成本統計', icon: <BarChart3 className="w-4 h-4" /> },
];

// 耗材可以套用在任何房型/空間類型（例如公共空間也要放衛生紙），布巾只套用在「房間」類型
// （空間不能訂房，不需要布巾）。兩邊共用同一次 room_types 查詢，各自在前端依 type 篩選。
interface RoomTypeOption { id: string; name: string; type: string; floor: string | null; capacity: number | null }

interface Consumable {
  id: string;
  name: string;
  unit: string;
  stock_quantity: number;
  restock_threshold: number;
  notes: string;
}

interface UsageRow {
  booking_id: string;
  linen_item_id: string;
  quantity: number;
  unit_price: number;
}

interface BookingRow {
  id: string;
  order_number: string | null;
  name: string | null;
  nickname: string | null;
  checkin_date: string | null;
  checkout_date: string | null;
  status: string;
}

const emptyItemForm = () => ({ category: '', spec: '', unit_price: '', notes: '', is_active: true });
const emptyConsumableForm = () => ({ name: '', unit: '', stock_quantity: 0, restock_threshold: 0, notes: '', spaceIds: [] as string[] });

function monthKey(iso: string | null): string {
  return iso ? iso.slice(0, 7) : '未設定日期';
}

export default function LinenManagement() {
  const [tab, setTab] = useState<Tab>('consumables');
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [allRoomTypes, setAllRoomTypes] = useState<RoomTypeOption[]>([]);
  const rooms = useMemo(() => allRoomTypes.filter((r) => r.type === '房間'), [allRoomTypes]);

  // ---------- 耗材維護 ----------
  const [consumables, setConsumables] = useState<Consumable[]>([]);
  const [spacesByConsumable, setSpacesByConsumable] = useState<Record<string, string[]>>({});
  const [showConsumableForm, setShowConsumableForm] = useState(false);
  const [editingConsumableId, setEditingConsumableId] = useState<string | null>(null);
  const [consumableForm, setConsumableForm] = useState(emptyConsumableForm());
  const [savingConsumable, setSavingConsumable] = useState(false);
  const [deleteConsumableTarget, setDeleteConsumableTarget] = useState<Consumable | null>(null);
  const [deletingConsumable, setDeletingConsumable] = useState(false);

  // ---------- 布巾品項與單價 ----------
  const [items, setItems] = useState<LinenItem[]>([]);
  const [defaults, setDefaults] = useState<RoomLinenDefault[]>([]);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [bookingRooms, setBookingRooms] = useState<{ booking_id: string; room_type_id: string }[]>([]);

  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItem, setEditingItem] = useState<LinenItem | null>(null);
  const [itemForm, setItemForm] = useState(emptyItemForm());
  const [savingItem, setSavingItem] = useState(false);
  const [deleteItem, setDeleteItem] = useState<LinenItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 房間預設組合
  const [selectedRoomId, setSelectedRoomId] = useState<string>('');
  const [savingDefaults, setSavingDefaults] = useState(false);

  // 統計篩選
  const [fromMonth, setFromMonth] = useState('');
  const [toMonth, setToMonth] = useState('');

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setLoading(true);
    setErrorMsg('');
    const [roomRes, consumableRes, consumableSpaceRes, itemRes, defRes, usageRes, bookingRes, brRes] = await Promise.all([
      supabase.from('room_types').select('id, name, type, floor, capacity').order('display_order'),
      supabase.from('consumables').select('*').order('name'),
      supabase.from('consumable_spaces').select('consumable_id, room_type_id'),
      supabase.from('linen_items').select('*').order('display_order'),
      supabase.from('room_type_linen_defaults').select('*'),
      supabase.from('booking_linen_usage').select('booking_id, linen_item_id, quantity, unit_price'),
      supabase.from('bookings').select('id, order_number, name, nickname, checkin_date, checkout_date, status').order('checkin_date', { ascending: false }),
      supabase.from('booking_rooms').select('booking_id, room_type_id'),
    ]);

    const err = roomRes.error || consumableRes.error || consumableSpaceRes.error || itemRes.error || defRes.error || usageRes.error || bookingRes.error || brRes.error;
    if (err) {
      setErrorMsg(`查詢失敗：${err.message}（新資料表可能還沒建立，請先在 Supabase 執行 supabase_schema.sql）`);
      setLoading(false);
      return;
    }

    setAllRoomTypes(roomRes.data || []);
    setConsumables(consumableRes.data || []);
    const spaceMap: Record<string, string[]> = {};
    for (const link of consumableSpaceRes.data || []) {
      if (!spaceMap[link.consumable_id]) spaceMap[link.consumable_id] = [];
      spaceMap[link.consumable_id].push(link.room_type_id);
    }
    setSpacesByConsumable(spaceMap);

    setItems(itemRes.data || []);
    setDefaults(defRes.data || []);
    setUsage(usageRes.data || []);
    setBookings(bookingRes.data || []);
    setBookingRooms(brRes.data || []);
    setSelectedRoomId((prev) => prev || (roomRes.data || []).find((r: any) => r.type === '房間')?.id || '');
    setLoading(false);
  };

  // ---------- 耗材維護 ----------
  const consumableSpaceNames = (consumableId: string): string => {
    const ids = spacesByConsumable[consumableId] || [];
    return allRoomTypes.filter((s) => ids.includes(s.id)).map((s) => s.name).join('、') || '（未指定）';
  };

  const openNewConsumable = () => {
    setEditingConsumableId(null);
    setConsumableForm(emptyConsumableForm());
    setShowConsumableForm(true);
  };

  const openEditConsumable = (row: Consumable) => {
    setEditingConsumableId(row.id);
    setConsumableForm({
      name: row.name,
      unit: row.unit || '',
      stock_quantity: row.stock_quantity ?? 0,
      restock_threshold: row.restock_threshold ?? 0,
      notes: row.notes || '',
      spaceIds: spacesByConsumable[row.id] || [],
    });
    setShowConsumableForm(true);
  };

  const toggleConsumableSpace = (id: string) => {
    setConsumableForm((prev) => ({
      ...prev,
      spaceIds: prev.spaceIds.includes(id) ? prev.spaceIds.filter((s) => s !== id) : [...prev.spaceIds, id],
    }));
  };

  const saveConsumable = async () => {
    if (!consumableForm.name.trim()) { setErrorMsg('請輸入耗材名稱'); return; }
    setSavingConsumable(true);
    setErrorMsg('');
    try {
      const payload = {
        name: consumableForm.name.trim(),
        unit: consumableForm.unit,
        stock_quantity: Number(consumableForm.stock_quantity) || 0,
        restock_threshold: Number(consumableForm.restock_threshold) || 0,
        notes: consumableForm.notes,
        updated_at: new Date().toISOString(),
      };

      let consumableId = editingConsumableId;
      if (consumableId) {
        const { error } = await supabase.from('consumables').update(payload).eq('id', consumableId);
        if (error) throw error;
        await supabase.from('consumable_spaces').delete().eq('consumable_id', consumableId);
      } else {
        const { data, error } = await supabase.from('consumables').insert(payload).select('id').single();
        if (error) throw error;
        consumableId = data.id;
      }

      if (consumableForm.spaceIds.length) {
        const { error: linkError } = await supabase
          .from('consumable_spaces')
          .insert(consumableForm.spaceIds.map((roomTypeId) => ({ consumable_id: consumableId, room_type_id: roomTypeId })));
        if (linkError) throw linkError;
      }

      setShowConsumableForm(false);
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(`儲存失敗：${e.message}`);
    } finally {
      setSavingConsumable(false);
    }
  };

  const confirmDeleteConsumable = async () => {
    if (!deleteConsumableTarget) return;
    setDeletingConsumable(true);
    try {
      const { error } = await supabase.from('consumables').delete().eq('id', deleteConsumableTarget.id);
      if (error) throw error;
      setDeleteConsumableTarget(null);
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(`刪除失敗：${e.message}`);
    } finally {
      setDeletingConsumable(false);
    }
  };

  const isLowStock = (row: Consumable) => row.stock_quantity <= row.restock_threshold;

  // ---------- 布巾品項與單價 ----------
  const openNewItem = () => { setEditingItem(null); setItemForm(emptyItemForm()); setShowItemForm(true); };
  const openEditItem = (item: LinenItem) => {
    setEditingItem(item);
    setItemForm({
      category: item.category,
      spec: item.spec,
      unit_price: item.unit_price == null ? '' : String(item.unit_price),
      notes: item.notes,
      is_active: item.is_active,
    });
    setShowItemForm(true);
  };

  const saveItem = async () => {
    if (!itemForm.category.trim()) { setErrorMsg('請輸入品項'); return; }
    setSavingItem(true);
    setErrorMsg('');
    try {
      const payload = {
        category: itemForm.category.trim(),
        spec: itemForm.spec.trim(),
        // 空白＝另行報價，存 NULL 而不是 0，統計時才分得出「免費」跟「還沒報價」
        unit_price: itemForm.unit_price.trim() === '' ? null : Number(itemForm.unit_price),
        notes: itemForm.notes,
        is_active: itemForm.is_active,
        updated_at: new Date().toISOString(),
      };
      if (editingItem) {
        const { error } = await supabase.from('linen_items').update(payload).eq('id', editingItem.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('linen_items').insert({ ...payload, display_order: items.length + 1 });
        if (error) throw error;
      }
      setShowItemForm(false);
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(e.code === '23505' ? '這個品項＋規格已經存在了' : `儲存失敗：${e.message}`);
    } finally {
      setSavingItem(false);
    }
  };

  const confirmDeleteItem = async () => {
    if (!deleteItem) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('linen_items').delete().eq('id', deleteItem.id);
      if (error) throw error;
      setDeleteItem(null);
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(`刪除失敗：${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  // ---------- 房間預設組合 ----------
  const roomDefaults = useMemo(
    () => defaults.filter((d) => d.room_type_id === selectedRoomId),
    [defaults, selectedRoomId]
  );

  const setRoomDefault = (linenItemId: string, patch: Partial<RoomLinenDefault>) => {
    setDefaults((prev) => {
      const idx = prev.findIndex((d) => d.room_type_id === selectedRoomId && d.linen_item_id === linenItemId);
      if (idx === -1) {
        return [...prev, { room_type_id: selectedRoomId, linen_item_id: linenItemId, quantity: 0, ...patch }];
      }
      return prev.map((d, i) => (i === idx ? { ...d, ...patch } : d));
    });
  };

  const saveDefaults = async () => {
    if (!selectedRoomId) return;
    setSavingDefaults(true);
    setErrorMsg('');
    try {
      const rows = roomDefaults.filter((d) => d.quantity > 0).map((d) => ({
        room_type_id: d.room_type_id,
        linen_item_id: d.linen_item_id,
        quantity: d.quantity,
      }));
      // 整間房重寫：數量被改成 0 的品項要真的消失，不是留一列 0
      const { error: delErr } = await supabase.from('room_type_linen_defaults').delete().eq('room_type_id', selectedRoomId);
      if (delErr) throw delErr;
      if (rows.length) {
        const { error } = await supabase.from('room_type_linen_defaults').insert(rows);
        if (error) throw error;
      }
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(`儲存失敗：${e.message}`);
    } finally {
      setSavingDefaults(false);
    }
  };

  const copyDefaultsFrom = async (sourceRoomId: string) => {
    const source = defaults.filter((d) => d.room_type_id === sourceRoomId);
    setDefaults((prev) => [
      ...prev.filter((d) => d.room_type_id !== selectedRoomId),
      ...source.map((d) => ({ ...d, room_type_id: selectedRoomId })),
    ]);
  };

  // ---------- 布巾成本統計 ----------
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const bookingById = useMemo(() => new Map(bookings.map((b) => [b.id, b])), [bookings]);

  const filteredUsage = useMemo(() => {
    return usage.filter((u) => {
      const b = bookingById.get(u.booking_id);
      const m = monthKey(b?.checkin_date ?? null);
      if (fromMonth && m < fromMonth) return false;
      if (toMonth && m > toMonth) return false;
      return true;
    });
  }, [usage, bookingById, fromMonth, toMonth]);

  const byMonth = useMemo(() => {
    const map = new Map<string, number>();
    for (const u of filteredUsage) {
      const m = monthKey(bookingById.get(u.booking_id)?.checkin_date ?? null);
      map.set(m, (map.get(m) || 0) + u.quantity * u.unit_price);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [filteredUsage, bookingById]);

  const byItem = useMemo(() => {
    const map = new Map<string, { qty: number; amount: number }>();
    for (const u of filteredUsage) {
      const cur = map.get(u.linen_item_id) || { qty: 0, amount: 0 };
      map.set(u.linen_item_id, { qty: cur.qty + u.quantity, amount: cur.amount + u.quantity * u.unit_price });
    }
    return [...map.entries()]
      .map(([id, v]) => ({ item: itemById.get(id), ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredUsage, itemById]);

  const byRoom = useMemo(() => {
    // 一張訂單開了 N 間房時，成本平均分攤到每間房——布巾用量沒有逐間房記錄，
    // 硬要拆到「哪一件毛巾屬於哪一間房」會是假精確，這裡誠實用均分。
    const roomsOfBooking = new Map<string, string[]>();
    for (const br of bookingRooms) {
      if (!roomsOfBooking.has(br.booking_id)) roomsOfBooking.set(br.booking_id, []);
      roomsOfBooking.get(br.booking_id)!.push(br.room_type_id);
    }
    const map = new Map<string, number>();
    let unassigned = 0;
    for (const u of filteredUsage) {
      const rs = roomsOfBooking.get(u.booking_id) || [];
      const amount = u.quantity * u.unit_price;
      if (rs.length === 0) { unassigned += amount; continue; }
      for (const r of rs) map.set(r, (map.get(r) || 0) + amount / rs.length);
    }
    const list = [...map.entries()]
      .map(([id, amount]) => {
        const room = rooms.find((r) => r.id === id);
        return { name: room ? roomLabel(room) : '（已刪除的房間）', amount };
      })
      .sort((a, b) => b.amount - a.amount);
    return { list, unassigned };
  }, [filteredUsage, bookingRooms, rooms]);

  const byBooking = useMemo(() => {
    const map = new Map<string, number>();
    for (const u of filteredUsage) map.set(u.booking_id, (map.get(u.booking_id) || 0) + u.quantity * u.unit_price);
    return [...map.entries()]
      .map(([id, amount]) => ({ booking: bookingById.get(id), amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [filteredUsage, bookingById]);

  const grandTotal = useMemo(() => filteredUsage.reduce((s, u) => s + u.quantity * u.unit_price, 0), [filteredUsage]);

  // 預設組合的預覽：這間房「洗一次」要多少錢。整趟住宿洗幾次由訂單決定，這裡不預設。
  const previewCost = useMemo(() => {
    if (!selectedRoomId) return 0;
    return usageTotal(computeUsage([selectedRoomId], roomDefaults, 1, items));
  }, [selectedRoomId, roomDefaults, items]);

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        icon={<Shirt className="w-6 h-6 text-green-600" />}
        title="備品管理"
        description="會被用掉、需要補貨的耗材（沐浴乳、衛生紙），以及重複使用、每次送洗依件計價的布巾（床包、毛巾）。"
        action={<Button variant="secondary" onClick={fetchAll} icon={<RefreshCw className="w-4 h-4" />}>重新整理</Button>}
      />

      {errorMsg && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-600 text-xs">關閉</button>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex border-b overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm whitespace-nowrap border-b-2 transition-colors ${
                tab === t.key ? 'border-green-600 text-green-700 font-medium bg-green-50' : 'border-transparent text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* ---------- 耗材維護 ---------- */}
        {tab === 'consumables' && (
          <div>
            <div className="flex justify-between items-center gap-4 px-6 py-4 border-b">
              <p className="text-sm text-gray-500">會被用掉、需要補貨的消耗品庫存（例如沐浴乳、衛生紙）。</p>
              <Button onClick={openNewConsumable} icon={<Plus className="w-4 h-4" />} className="whitespace-nowrap">新增耗材</Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 border-b text-gray-600">
                  <tr>
                    <th className="py-3 px-4">名稱</th>
                    <th className="py-3 px-4">庫存數量</th>
                    <th className="py-3 px-4">補貨門檻</th>
                    <th className="py-3 px-4">適用房型/空間</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {consumables.length === 0 ? (
                    <tr><td colSpan={5}><EmptyState icon={<Package className="w-12 h-12 text-gray-200" />} message="尚未設定任何耗材，點右上角「新增耗材」開始" /></td></tr>
                  ) : (
                    consumables.map((row) => (
                      <tr key={row.id} onClick={() => openEditConsumable(row)} className="hover:bg-green-50 transition-colors cursor-pointer">
                        <td className="py-3 px-4 font-medium text-gray-800">{row.name}</td>
                        <td className="py-3 px-4">
                          <span className={`inline-flex items-center gap-1 ${isLowStock(row) ? 'text-red-600 font-medium' : 'text-gray-700'}`}>
                            {isLowStock(row) && <AlertTriangle className="w-3.5 h-3.5" />}
                            {row.stock_quantity} {row.unit}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-gray-500">{row.restock_threshold} {row.unit}</td>
                        <td className="py-3 px-4 text-gray-500">{consumableSpaceNames(row.id)}</td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={(e) => { e.stopPropagation(); openEditConsumable(row); }} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteConsumableTarget(row); }} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---------- 布巾品項與單價 ---------- */}
        {tab === 'items' && (
          <div>
            <div className="flex justify-between items-center gap-4 px-6 py-4 border-b">
              <p className="text-sm text-gray-500">洗滌廠報價單上的每件單價。改單價<strong className="text-gray-700">不會</strong>影響已經記錄過的訂單成本（單價在記錄當下就存起來了）。</p>
              <Button onClick={openNewItem} icon={<Plus className="w-4 h-4" />} className="whitespace-nowrap">新增品項</Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 border-b text-gray-600">
                  <tr>
                    <th className="py-3 px-4">品項</th>
                    <th className="py-3 px-4">品名－規格</th>
                    <th className="py-3 px-4 text-right">單價 NT$</th>
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.length === 0 ? (
                    <tr><td colSpan={4}><EmptyState icon={<Shirt className="w-12 h-12 text-gray-200" />} message="還沒有任何品項" /></td></tr>
                  ) : items.map((item) => (
                    <tr key={item.id} className={`hover:bg-green-50 transition-colors ${item.is_active ? '' : 'opacity-50'}`}>
                      <td className="py-3 px-4 font-medium text-gray-800 whitespace-nowrap">
                        {item.category}
                        {!item.is_active && <span className="ml-2 text-xs text-gray-400">已停用</span>}
                      </td>
                      <td className="py-3 px-4 text-gray-600">{item.spec || <span className="text-gray-300">—</span>}</td>
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        {item.unit_price == null
                          ? <span className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-0.5">另行報價</span>
                          : <span className="text-gray-800">{item.unit_price}</span>}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => openEditItem(item)} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                          <button onClick={() => setDeleteItem(item)} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ---------- 房間預設組合 ---------- */}
        {tab === 'defaults' && (
          <div className="p-6">
            {rooms.length === 0 ? (
              <EmptyState icon={<BedDouble className="w-12 h-12 text-gray-200" />} message="還沒有「房間」類型的資料，請先到「房型與空間維護」新增" />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">房間</label>
                    <select value={selectedRoomId} onChange={(e) => setSelectedRoomId(e.target.value)} className="px-3 py-2 border rounded-lg bg-white text-sm min-w-52">
                      {rooms.map((r) => <option key={r.id} value={r.id}>{roomLabel(r)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">從其他房間複製</label>
                    <select
                      value=""
                      onChange={(e) => e.target.value && copyDefaultsFrom(e.target.value)}
                      className="px-3 py-2 border rounded-lg bg-white text-sm min-w-40"
                    >
                      <option value="">選擇來源房間…</option>
                      {rooms.filter((r) => r.id !== selectedRoomId).map((r) => <option key={r.id} value={r.id}>{roomLabel(r)}</option>)}
                    </select>
                  </div>
                  <div className="ml-auto text-right">
                    <p className="text-xs text-gray-400">這間房洗一次的成本</p>
                    <p className="text-lg font-bold text-gray-800">{currency(previewCost)}</p>
                  </div>
                  <Button onClick={saveDefaults} loading={savingDefaults}>{savingDefaults ? '儲存中...' : '儲存這間房的組合'}</Button>
                </div>

                <p className="text-xs text-gray-400">
                  這裡設定的是「這間房整理一次要用的布巾」，數量填 0 代表不用這個品項。
                  整趟住宿要洗幾次在訂單裡填——住 3 晚可能只在退房後洗一次，也可能中途再洗一次，
                  那是每趟住宿的實際狀況，這裡決定不了。
                </p>

                <div className="border rounded-lg overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b text-gray-600">
                      <tr>
                        <th className="py-2 px-4">品項</th>
                        <th className="py-2 px-3 text-right w-24">單價</th>
                        <th className="py-2 px-3 w-28">數量</th>
                        <th className="py-2 px-4 text-right w-32">洗一次小計</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {items.filter((i) => i.is_active).map((item) => {
                        const d = roomDefaults.find((x) => x.linen_item_id === item.id);
                        const qty = d?.quantity ?? 0;
                        const subtotal = qty * (item.unit_price ?? 0);
                        return (
                          <tr key={item.id} className={qty > 0 ? 'bg-green-50/40' : ''}>
                            <td className="py-2 px-4 text-gray-700">{linenItemLabel(item)}</td>
                            <td className="py-2 px-3 text-right text-gray-500">{item.unit_price ?? '—'}</td>
                            <td className="py-2 px-3">
                              <input
                                type="number" min={0}
                                value={qty}
                                onChange={(e) => setRoomDefault(item.id, { quantity: Math.max(0, Number(e.target.value) || 0) })}
                                className="w-20 px-2 py-1 border rounded text-sm"
                              />
                            </td>
                            <td className="py-2 px-4 text-right text-gray-700">{subtotal > 0 ? currency(subtotal) : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------- 布巾成本統計 ---------- */}
        {tab === 'report' && (
          <div className="p-6 space-y-6">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">起始月份</label>
                <input type="month" value={fromMonth} onChange={(e) => setFromMonth(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">結束月份</label>
                <input type="month" value={toMonth} onChange={(e) => setToMonth(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
              </div>
              {(fromMonth || toMonth) && (
                <Button variant="secondary" onClick={() => { setFromMonth(''); setToMonth(''); }}>清除</Button>
              )}
              <div className="ml-auto text-right">
                <p className="text-xs text-gray-400">區間總洗滌成本</p>
                <p className="text-2xl font-bold text-green-700">{currency(grandTotal)}</p>
              </div>
            </div>

            {filteredUsage.length === 0 ? (
              <EmptyState icon={<BarChart3 className="w-12 h-12 text-gray-200" />} message="這個區間還沒有布巾用量紀錄。到「訂單管理」打開訂單，選好房間就會自動帶出用量。" />
            ) : (
              <>
                <ReportBlock title="每月總成本" note="依訂單的入住日期歸月">
                  {byMonth.map(([m, amount]) => (
                    <Bar key={m} label={m} amount={amount} max={Math.max(...byMonth.map((x) => x[1]))} />
                  ))}
                </ReportBlock>

                <ReportBlock title="各品項用量與金額" note="跟洗滌廠對帳單時用這張">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-gray-500 text-xs">
                      <tr><th className="py-2">品項</th><th className="py-2 text-right w-24">件數</th><th className="py-2 text-right w-32">金額</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {byItem.map((r, i) => (
                        <tr key={i}>
                          <td className="py-2 text-gray-700">{r.item ? linenItemLabel(r.item) : '（已刪除的品項）'}</td>
                          <td className="py-2 text-right text-gray-600">{r.qty.toLocaleString()}</td>
                          <td className="py-2 text-right text-gray-800">{currency(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ReportBlock>

                <ReportBlock title="各房間成本" note="一張訂單開多間房時，成本平均分攤到每間房">
                  {byRoom.list.map((r) => (
                    <Bar key={r.name} label={r.name} amount={r.amount} max={Math.max(...byRoom.list.map((x) => x.amount))} />
                  ))}
                  {byRoom.unassigned > 0 && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-700 mt-3 pt-3 border-t">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      有 {currency(byRoom.unassigned)} 的成本來自沒有選房間的訂單，沒有分攤到任何房間。到「訂單管理」把房間補選起來就會納入。
                    </p>
                  )}
                </ReportBlock>

                <ReportBlock title="單張訂單成本" note="金額由高到低，前 30 筆">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b text-gray-500 text-xs">
                      <tr><th className="py-2">訂單</th><th className="py-2">住客</th><th className="py-2">入住</th><th className="py-2 text-right w-28">晚數</th><th className="py-2 text-right w-32">布巾成本</th></tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {byBooking.slice(0, 30).map((r, i) => (
                        <tr key={i}>
                          <td className="py-2 font-mono text-xs text-gray-600">{r.booking?.order_number || '—'}</td>
                          <td className="py-2 text-gray-700">{r.booking?.name || r.booking?.nickname || '—'}</td>
                          <td className="py-2 text-gray-600">{r.booking?.checkin_date || '—'}</td>
                          <td className="py-2 text-right text-gray-600">{nightsBetween(r.booking?.checkin_date, r.booking?.checkout_date) || '—'}</td>
                          <td className="py-2 text-right text-gray-800">{currency(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ReportBlock>
              </>
            )}
          </div>
        )}
      </div>

      {/* ---------- 耗材表單／刪除確認 ---------- */}
      <Modal
        open={showConsumableForm}
        title={editingConsumableId ? '編輯耗材' : '新增耗材'}
        onClose={() => setShowConsumableForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowConsumableForm(false)}>取消</Button>
            <Button onClick={saveConsumable} loading={savingConsumable}>{savingConsumable ? '儲存中...' : '儲存'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">名稱</label>
          <input value={consumableForm.name} onChange={(e) => setConsumableForm({ ...consumableForm, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：沐浴乳" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">單位</label>
            <input value={consumableForm.unit} onChange={(e) => setConsumableForm({ ...consumableForm, unit: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="瓶" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">庫存數量</label>
            <input type="number" value={consumableForm.stock_quantity} onChange={(e) => setConsumableForm({ ...consumableForm, stock_quantity: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">補貨門檻</label>
            <input type="number" value={consumableForm.restock_threshold} onChange={(e) => setConsumableForm({ ...consumableForm, restock_threshold: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg" title="庫存低於等於這個數字時，畫面會標示提醒" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-2">適用房型/空間</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border rounded-lg p-3">
            {allRoomTypes.length === 0 ? (
              <p className="text-xs text-gray-400 col-span-full">尚未設定任何房型/空間，請先到「房型與空間維護」新增</p>
            ) : (
              allRoomTypes.map((s) => {
                const checked = consumableForm.spaceIds.includes(s.id);
                return (
                  <label key={s.id} className={`flex items-center gap-2 px-2 py-1.5 border rounded-lg text-sm cursor-pointer ${checked ? 'bg-green-50 border-green-300' : 'border-gray-200'}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleConsumableSpace(s.id)} />
                    {s.name}
                  </label>
                );
              })
            )}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">備註</label>
          <textarea value={consumableForm.notes} onChange={(e) => setConsumableForm({ ...consumableForm, notes: e.target.value })} rows={2} className="w-full px-3 py-2 border rounded-lg" />
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteConsumableTarget}
        title="刪除耗材"
        message={`確定要刪除「${deleteConsumableTarget?.name}」嗎？`}
        confirmLabel="刪除"
        danger
        loading={deletingConsumable}
        onConfirm={confirmDeleteConsumable}
        onCancel={() => setDeleteConsumableTarget(null)}
      />

      {/* ---------- 布巾品項表單／刪除確認 ---------- */}
      <Modal
        open={showItemForm}
        title={editingItem ? '編輯品項' : '新增品項'}
        onClose={() => setShowItemForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowItemForm(false)}>取消</Button>
            <Button onClick={saveItem} loading={savingItem}>{savingItem ? '儲存中...' : '儲存'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">品項</label>
          <input value={itemForm.category} onChange={(e) => setItemForm({ ...itemForm, category: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：床包" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">品名－規格</label>
          <input value={itemForm.spec} onChange={(e) => setItemForm({ ...itemForm, spec: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：平紋貢緞床包-5x6.2 尺-高 28cm 紅線" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">洗滌單價 NT$</label>
          <input type="number" min={0} value={itemForm.unit_price} onChange={(e) => setItemForm({ ...itemForm, unit_price: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="留空＝另行報價" />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">備註</label>
          <input value={itemForm.notes} onChange={(e) => setItemForm({ ...itemForm, notes: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={itemForm.is_active} onChange={(e) => setItemForm({ ...itemForm, is_active: e.target.checked })} />
          啟用（停用的品項不會出現在房間預設組合裡）
        </label>
      </Modal>

      <ConfirmDialog
        open={!!deleteItem}
        title="刪除品項"
        message={`確定要刪除「${deleteItem ? linenItemLabel(deleteItem) : ''}」嗎？所有房間的預設組合、以及已記錄訂單裡的這個品項用量都會一起刪除，過去的統計金額會跟著變動。如果只是不再使用，建議改成「停用」。`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDeleteItem}
        onCancel={() => setDeleteItem(null)}
      />
    </div>
  );
}

function ReportBlock({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="border rounded-xl p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h4 className="text-sm font-semibold text-gray-800">{title}</h4>
        <span className="text-xs text-gray-400">{note}</span>
      </div>
      {children}
    </div>
  );
}

function Bar({ label, amount, max }: { label: string; amount: number; max: number }) {
  const pct = max > 0 ? Math.max(2, (amount / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-28 shrink-0 text-sm text-gray-600 truncate">{label}</span>
      <span className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
        <span className="block h-full bg-green-500 rounded-full" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-28 shrink-0 text-right text-sm text-gray-800">{currency(amount)}</span>
    </div>
  );
}

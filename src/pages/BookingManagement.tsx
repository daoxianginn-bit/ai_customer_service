import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, CalendarRange, Home, Users, Calculator, Save, Wand2 } from 'lucide-react';
import {
  computeQuote,
  suggestRoomCombo,
  getAvailableIndividualRooms,
  computeIndividualOptions,
  selectWholeHousePackage,
  compareOptions,
  QuoteResult,
} from '../lib/bookingEngine';

// 房型/包棟方案定價目前支援的 tier，對應 bookingEngine.resolvePricingTier() 實際會判斷出來的級距。
const PRICING_TIERS = ['平日', '小假日', '連假', '旺季', '定價'];
// 自動報價總表只顯示會被實際判斷出來的營運 tier（不含「定價」這種純參考價）。
const MATRIX_TIERS = ['平日', '小假日', '連假', '旺季'];
const RULE_TYPE_OPTIONS = [
  { value: 'no_extra_room', label: '不多開房' },
  { value: 'extra_room', label: '多開房' },
];

function newId(): string {
  return crypto.randomUUID();
}

function getTierPrice(list: any[], idField: string, idValue: string, tier: string): string {
  const found = list.find((p) => p[idField] === idValue && p.tier === tier);
  return found && found.price != null ? String(found.price) : '';
}

function setTierPrice(
  list: any[],
  setList: (v: any[]) => void,
  idField: string,
  idValue: string,
  tier: string,
  priceInput: string
) {
  const price = priceInput === '' ? null : Number(priceInput);
  const existing = list.find((p) => p[idField] === idValue && p.tier === tier);
  if (existing) {
    setList(list.map((p) => (p === existing ? { ...p, price } : p)));
  } else {
    setList([...list, { id: newId(), [idField]: idValue, tier, price }]);
  }
}

export default function BookingManagement() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [wholeHouseEnabled, setWholeHouseEnabled] = useState(true);

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [roomPricing, setRoomPricing] = useState<any[]>([]);
  const [roomExtraPersonPricing, setRoomExtraPersonPricing] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [packagePricing, setPackagePricing] = useState<any[]>([]);
  const [packageRooms, setPackageRooms] = useState<any[]>([]);
  const [extraRules, setExtraRules] = useState<any[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);

  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);

  const [newRange, setNewRange] = useState({ range_type: '旺季', start_date: '', end_date: '', label: '' });
  const [newPackage, setNewPackage] = useState<{ occupancy: number; roomIds: string[] }>({ occupancy: 10, roomIds: [] });

  const [quoteDate, setQuoteDate] = useState('');
  const [quoteHeadcount, setQuoteHeadcount] = useState(4);
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [st, rt, rp, rep, wp, wpp, wpr, epr, dr] = await Promise.all([
      supabase.from('settings').select('id, booking_whole_house_enabled').single(),
      supabase.from('room_types').select('*').order('display_order'),
      supabase.from('room_pricing').select('*'),
      supabase.from('room_extra_person_pricing').select('*'),
      supabase.from('whole_house_packages').select('*').order('display_order'),
      supabase.from('whole_house_package_pricing').select('*'),
      supabase.from('whole_house_package_rooms').select('*'),
      supabase.from('whole_house_extra_person_rules').select('*'),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
    ]);
    setSettingsId(st.data?.id || null);
    setWholeHouseEnabled(st.data?.booking_whole_house_enabled ?? true);
    setRoomTypes(rt.data || []);
    setRoomPricing(rp.data || []);
    setRoomExtraPersonPricing(rep.data || []);
    setPackages(wp.data || []);
    setPackagePricing(wpp.data || []);
    setPackageRooms(wpr.data || []);
    setExtraRules(epr.data || []);
    setDateRanges(dr.data || []);
    setPendingDeletes([]);
    setNewPackage({ occupancy: 10, roomIds: [] });
    setLoading(false);
  };

  const queueDelete = (table: string, id: string) => setPendingDeletes((prev) => [...prev, { table, id }]);

  // ---------------- 儲存 ----------------
  const handleSaveAll = async () => {
    setSaving(true);
    try {
      if (settingsId) {
        await supabase.from('settings').update({ booking_whole_house_enabled: wholeHouseEnabled }).eq('id', settingsId);
      }
      if (roomTypes.length) await supabase.from('room_types').upsert(roomTypes);
      if (roomPricing.length) await supabase.from('room_pricing').upsert(roomPricing);
      if (roomExtraPersonPricing.length) await supabase.from('room_extra_person_pricing').upsert(roomExtraPersonPricing);
      if (packages.length) await supabase.from('whole_house_packages').upsert(packages);
      if (packagePricing.length) await supabase.from('whole_house_package_pricing').upsert(packagePricing);
      if (packageRooms.length) await supabase.from('whole_house_package_rooms').upsert(packageRooms);
      if (extraRules.length) await supabase.from('whole_house_extra_person_rules').upsert(extraRules);
      if (dateRanges.length) await supabase.from('booking_date_ranges').upsert(dateRanges);

      for (const del of pendingDeletes) {
        await supabase.from(del.table).delete().eq('id', del.id);
      }

      await fetchAll();
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // ---------------- 房型 ----------------
  const addRoomType = () => {
    setRoomTypes([...roomTypes, { id: newId(), name: '新房型', floor: '', capacity: 2, max_extra_persons: 0, display_order: roomTypes.length, is_active: true }]);
  };

  const updateRoomType = (id: string, field: string, value: any) => {
    setRoomTypes(roomTypes.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const deleteRoomType = (id: string) => {
    if (!confirm('確定要刪除這個房型嗎？相關定價與包棟房型組合也會一併刪除。')) return;
    setRoomTypes(roomTypes.filter((r) => r.id !== id));
    setRoomPricing(roomPricing.filter((p) => p.room_type_id !== id));
    setRoomExtraPersonPricing(roomExtraPersonPricing.filter((p) => p.room_type_id !== id));
    setPackageRooms(packageRooms.filter((pr) => pr.room_type_id !== id));
    queueDelete('room_types', id);
  };

  // ---------------- 包棟方案 ----------------
  const applySuggestedCombo = (occupancy: number) => {
    const suggested = suggestRoomCombo(occupancy, roomTypes);
    setNewPackage({ occupancy, roomIds: suggested.map((r) => r.id) });
  };

  const toggleNewPackageRoom = (roomId: string) => {
    setNewPackage((prev) => ({
      ...prev,
      roomIds: prev.roomIds.includes(roomId) ? prev.roomIds.filter((id) => id !== roomId) : [...prev.roomIds, roomId],
    }));
  };

  const newPackageCapacity = newPackage.roomIds.reduce((s, id) => s + (roomTypes.find((r) => r.id === id)?.capacity || 0), 0);

  const addPackage = () => {
    const pkgId = newId();
    setPackages([...packages, { id: pkgId, occupancy: newPackage.occupancy, display_order: packages.length }]);
    setPackageRooms([...packageRooms, ...newPackage.roomIds.map((roomId) => ({ id: newId(), package_id: pkgId, room_type_id: roomId }))]);
    setNewPackage({ occupancy: 10, roomIds: [] });
  };

  const deletePackage = (id: string) => {
    if (!confirm('確定要刪除這個包棟方案嗎？相關定價與房型組合也會一併刪除。')) return;
    setPackages(packages.filter((p) => p.id !== id));
    setPackagePricing(packagePricing.filter((p) => p.package_id !== id));
    setPackageRooms(packageRooms.filter((pr) => pr.package_id !== id));
    queueDelete('whole_house_packages', id);
  };

  const packageRoomNames = (packageId: string): string => {
    const roomIds = packageRooms.filter((pr) => pr.package_id === packageId).map((pr) => pr.room_type_id);
    return roomTypes.filter((r) => roomIds.includes(r.id)).map((r) => r.name).join('、') || '（未設定房型）';
  };

  // ---------------- 加人規則 ----------------
  const addExtraRule = () => {
    setExtraRules([...extraRules, { id: newId(), rule_type: 'no_extra_room', rule_label: '不多開房', tier: '平日', price: null }]);
  };

  const updateExtraRule = (id: string, field: string, value: any) => {
    setExtraRules(extraRules.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const deleteExtraRule = (id: string) => {
    if (!confirm('確定要刪除這筆加人規則嗎？')) return;
    setExtraRules(extraRules.filter((r) => r.id !== id));
    queueDelete('whole_house_extra_person_rules', id);
  };

  // ---------------- 日期區間 ----------------
  const addDateRange = () => {
    if (!newRange.start_date || !newRange.end_date) {
      alert('請填入起訖日期');
      return;
    }
    setDateRanges([...dateRanges, { id: newId(), ...newRange }].sort((a, b) => a.start_date.localeCompare(b.start_date)));
    setNewRange({ range_type: '旺季', start_date: '', end_date: '', label: '' });
  };

  const updateDateRange = (id: string, field: string, value: any) => {
    setDateRanges(dateRanges.map((d) => (d.id === id ? { ...d, [field]: value } : d)));
  };

  const deleteDateRange = (id: string) => {
    setDateRanges(dateRanges.filter((d) => d.id !== id));
    queueDelete('booking_date_ranges', id);
  };

  // ---------------- 測試報價 ----------------
  const runTestQuote = () => {
    if (!quoteDate) {
      alert('請選擇入住日期');
      return;
    }
    const maxOccupancy = packages.length ? Math.max(...packages.map((p) => p.occupancy)) : 0;
    const result = computeQuote({
      date: new Date(`${quoteDate}T00:00:00`),
      headcount: quoteHeadcount,
      dateRanges: dateRanges.map((d) => ({ range_type: d.range_type, start_date: d.start_date, end_date: d.end_date })),
      roomTypes,
      roomPricing,
      roomExtraPersonPricing,
      packages: wholeHouseEnabled ? packages : [],
      packagePricing: wholeHouseEnabled ? packagePricing : [],
      extraPersonRules: wholeHouseEnabled ? extraRules : [],
      maxOccupancy,
    });
    setQuoteResult(result);
  };

  // ---------------- 自動報價總表 ----------------
  const packageOccupancies = packages.map((p) => p.occupancy);
  const matrixMin = packageOccupancies.length ? Math.min(...packageOccupancies) : 0;
  const matrixMax = packageOccupancies.length ? Math.max(...packageOccupancies) : 0;
  const matrixRows: number[] = [];
  for (let h = matrixMin; h <= matrixMax; h++) matrixRows.push(h);

  const computeMatrixCell = (headcount: number, tier: string) => {
    const availableRooms = getAvailableIndividualRooms(tier, roomTypes, roomPricing, roomExtraPersonPricing);
    const individualOption = availableRooms.length ? computeIndividualOptions(headcount, availableRooms) : null;
    const wholeHouseOption = selectWholeHousePackage(headcount, packages, packagePricing, extraRules, tier, matrixMax);
    const recommendation = compareOptions(individualOption, wholeHouseOption);
    const total = wholeHouseOption
      ? wholeHouseOption.extraPersonOptions.length
        ? Math.min(...wholeHouseOption.extraPersonOptions.map((o) => o.grandTotal))
        : wholeHouseOption.basePrice
      : null;
    return { total, recommendation };
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-xl shadow-sm border flex justify-between items-start gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <CalendarRange className="w-6 h-6 text-blue-600" />
            訂房管理（Phase 1：資料設定）
          </h2>
          <p className="text-gray-500 mt-1">
            所有變更會先暫存在畫面上，按「儲存變更」才會真正寫入資料庫，避免不小心異動。
          </p>
        </div>
        <button
          onClick={handleSaveAll}
          disabled={saving}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          <Save className="w-4 h-4" />
          {saving ? '儲存中...' : '儲存變更'}
        </button>
      </div>

      {/* 房型與定價 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Home className="w-5 h-5 text-blue-600" />
            房型與定價
          </h3>
          <button onClick={addRoomType} className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700">
            <Plus className="w-4 h-4" /> 新增房型
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">房型名稱</th>
                <th className="py-3 px-4">樓層</th>
                <th className="py-3 px-4">容納人數</th>
                <th className="py-3 px-4">最多加人</th>
                <th className="py-3 px-4">排序</th>
                <th className="py-3 px-4">啟用</th>
                {PRICING_TIERS.map((t) => (
                  <th key={t} className="py-3 px-4">{t}</th>
                ))}
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {roomTypes.map((r) => (
                <tr key={r.id}>
                  <td className="p-2">
                    <input value={r.name} onChange={(e) => updateRoomType(r.id, 'name', e.target.value)} className="w-28 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input value={r.floor} onChange={(e) => updateRoomType(r.id, 'floor', e.target.value)} className="w-16 px-2 py-1 border rounded" placeholder="2F" />
                  </td>
                  <td className="p-2">
                    <input type="number" value={r.capacity} onChange={(e) => updateRoomType(r.id, 'capacity', Number(e.target.value))} className="w-16 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input type="number" min={0} value={r.max_extra_persons ?? 0} onChange={(e) => updateRoomType(r.id, 'max_extra_persons', Number(e.target.value))} className="w-16 px-2 py-1 border rounded" title="0＝不支援加人" />
                  </td>
                  <td className="p-2">
                    <input type="number" value={r.display_order} onChange={(e) => updateRoomType(r.id, 'display_order', Number(e.target.value))} className="w-14 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2 text-center">
                    <input type="checkbox" checked={r.is_active} onChange={(e) => updateRoomType(r.id, 'is_active', e.target.checked)} />
                  </td>
                  {PRICING_TIERS.map((tier) => (
                    <td key={tier} className="p-2">
                      <input
                        type="number"
                        value={getTierPrice(roomPricing, 'room_type_id', r.id, tier)}
                        onChange={(e) => setTierPrice(roomPricing, setRoomPricing, 'room_type_id', r.id, tier, e.target.value)}
                        className="w-20 px-2 py-1 border rounded"
                        placeholder="留空=不開放"
                      />
                    </td>
                  ))}
                  <td className="p-2">
                    <button onClick={() => deleteRoomType(r.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {roomTypes.length === 0 && (
                <tr>
                  <td colSpan={7 + PRICING_TIERS.length} className="py-10 text-center text-gray-400">
                    尚未設定房型，點右上角「新增房型」開始
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 px-6 py-3 border-t">
          某個 tier 留空＝該 tier 不開放個別租房（顧客只能選包棟）。之後要開放，把價格填上即可，不用額外設定日期區間。「最多加人」設 0 代表該房型不支援加人不加房，人數超過容納人數時只能開另一間房。
        </p>

        <div className="p-6 border-t">
          <p className="text-sm font-medium text-gray-700 mb-1">加人不加房：每人加價</p>
          <p className="text-xs text-gray-400 mb-3">只有「最多加人」大於 0 的房型才會出現在這裡。例如某人數剛好多 1、2 位時，系統會優先試算「塞進已選房間加價」跟「多開一間房」兩種選項，讓顧客選。</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="py-2 px-3">房型</th>
                  {MATRIX_TIERS.map((t) => (
                    <th key={t} className="py-2 px-3">{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {roomTypes.filter((r) => (r.max_extra_persons ?? 0) > 0).map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 px-3 font-medium">{r.name}（最多加 {r.max_extra_persons} 人）</td>
                    {MATRIX_TIERS.map((tier) => (
                      <td key={tier} className="p-2">
                        <input
                          type="number"
                          value={getTierPrice(roomExtraPersonPricing, 'room_type_id', r.id, tier)}
                          onChange={(e) => setTierPrice(roomExtraPersonPricing, setRoomExtraPersonPricing, 'room_type_id', r.id, tier, e.target.value)}
                          className="w-20 px-2 py-1 border rounded"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
                {roomTypes.filter((r) => (r.max_extra_persons ?? 0) > 0).length === 0 && (
                  <tr>
                    <td colSpan={1 + MATRIX_TIERS.length} className="py-6 text-center text-gray-400">
                      目前沒有房型設定「最多加人」大於 0
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 包棟方案與定價 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-600" />
            包棟方案與定價
          </h3>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            啟用包棟方案
            <input type="checkbox" checked={wholeHouseEnabled} onChange={(e) => setWholeHouseEnabled(e.target.checked)} className="w-4 h-4" />
          </label>
        </div>

        {!wholeHouseEnabled ? (
          <p className="p-6 text-sm text-gray-400">已關閉包棟方案，顧客只會看到個別房型租房選項。開啟後可設定包棟人數級距與定價。</p>
        ) : (
          <>
            <div className="p-6 border-b bg-gray-50 space-y-3">
              <p className="text-sm font-medium text-gray-700">新增方案</p>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-gray-500">動人數</span>
                <input
                  type="number"
                  value={newPackage.occupancy}
                  onChange={(e) => applySuggestedCombo(Number(e.target.value))}
                  className="w-20 px-2 py-1 border rounded"
                />
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <Wand2 className="w-3.5 h-3.5" />
                  已自動建議下方房型組合，可手動調整（已勾選容納：{newPackageCapacity} 人）
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {roomTypes.filter((r) => r.is_active).map((r) => {
                  const checked = newPackage.roomIds.includes(r.id);
                  return (
                    <label
                      key={r.id}
                      className={`flex items-center gap-2 px-3 py-2 border rounded-lg text-sm cursor-pointer ${checked ? 'bg-purple-50 border-purple-300' : 'border-gray-200'}`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleNewPackageRoom(r.id)} />
                      {r.name}（{r.capacity}人）
                    </label>
                  );
                })}
              </div>
              <button onClick={addPackage} className="flex items-center gap-1 bg-purple-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-purple-700">
                <Plus className="w-4 h-4" /> 新增這個方案
              </button>
            </div>

            <div className="overflow-x-auto border-b">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 border-b">
                  <tr className="text-gray-600">
                    <th className="py-3 px-4">動人數</th>
                    <th className="py-3 px-4">房型組合</th>
                    {PRICING_TIERS.map((t) => (
                      <th key={t} className="py-3 px-4">{t}</th>
                    ))}
                    <th className="py-3 px-4"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {packages.map((p) => (
                    <tr key={p.id}>
                      <td className="p-2">
                        <input type="number" value={p.occupancy} onChange={(e) => setPackages(packages.map((x) => (x.id === p.id ? { ...x, occupancy: Number(e.target.value) } : x)))} className="w-16 px-2 py-1 border rounded" />
                      </td>
                      <td className="p-2 text-gray-600">{packageRoomNames(p.id)}</td>
                      {PRICING_TIERS.map((tier) => (
                        <td key={tier} className="p-2">
                          <input
                            type="number"
                            value={getTierPrice(packagePricing, 'package_id', p.id, tier)}
                            onChange={(e) => setTierPrice(packagePricing, setPackagePricing, 'package_id', p.id, tier, e.target.value)}
                            className="w-20 px-2 py-1 border rounded"
                          />
                        </td>
                      ))}
                      <td className="p-2">
                        <button onClick={() => deletePackage(p.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {packages.length === 0 && (
                    <tr>
                      <td colSpan={3 + PRICING_TIERS.length} className="py-10 text-center text-gray-400">
                        尚未設定包棟方案
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-6 border-b">
              <div className="flex justify-between items-center mb-3">
                <p className="text-sm font-medium text-gray-700">超額加人規則</p>
                <button onClick={addExtraRule} className="flex items-center gap-1 bg-gray-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-800">
                  <Plus className="w-4 h-4" /> 新增規則
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr className="text-gray-600">
                      <th className="py-2 px-3">類型</th>
                      <th className="py-2 px-3">顯示名稱</th>
                      <th className="py-2 px-3">tier</th>
                      <th className="py-2 px-3">每人加價</th>
                      <th className="py-2 px-3"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {extraRules.map((r) => (
                      <tr key={r.id}>
                        <td className="p-2">
                          <select value={r.rule_type} onChange={(e) => updateExtraRule(r.id, 'rule_type', e.target.value)} className="px-2 py-1 border rounded bg-white">
                            {RULE_TYPE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <input value={r.rule_label} onChange={(e) => updateExtraRule(r.id, 'rule_label', e.target.value)} className="w-32 px-2 py-1 border rounded" placeholder="不加床、不多開房" />
                        </td>
                        <td className="p-2">
                          <select value={r.tier} onChange={(e) => updateExtraRule(r.id, 'tier', e.target.value)} className="px-2 py-1 border rounded bg-white">
                            {MATRIX_TIERS.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            value={r.price ?? ''}
                            onChange={(e) => updateExtraRule(r.id, 'price', e.target.value === '' ? null : Number(e.target.value))}
                            className="w-24 px-2 py-1 border rounded"
                          />
                        </td>
                        <td className="p-2">
                          <button onClick={() => deleteExtraRule(r.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {extraRules.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-gray-400">
                          尚未設定加人規則
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {matrixRows.length > 0 && (
              <div className="p-6">
                <p className="text-sm font-medium text-gray-700 flex items-center gap-2">
                  <Calculator className="w-4 h-4 text-orange-600" />
                  自動報價總表（唯讀，即時算好）
                </p>
                <p className="text-xs text-gray-400 mb-3">資料改了會自動重算，不用理解演算法，直接看數字對不對；「與個別租房比較」是自動算出來的省多少錢。</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr className="text-gray-600">
                        <th className="py-2 px-3">人數</th>
                        {MATRIX_TIERS.map((t) => (
                          <th key={t} className="py-2 px-3">{t}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {matrixRows.map((h) => (
                        <tr key={h}>
                          <td className="py-2 px-3 font-semibold">{h} 人</td>
                          {MATRIX_TIERS.map((tier) => {
                            const { total, recommendation } = computeMatrixCell(h, tier);
                            return (
                              <td key={tier} className="py-2 px-3">
                                {total == null ? (
                                  <span className="text-gray-300">—</span>
                                ) : (
                                  <div>
                                    <div>NT$ {total.toLocaleString()}</div>
                                    {recommendation.recommended === 'wholeHouse' && recommendation.savings ? (
                                      <span className="inline-block mt-0.5 text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded">
                                        包棟省 NT$ {recommendation.savings.toLocaleString()}
                                      </span>
                                    ) : null}
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 日期區間 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800">旺季／連假日期區間</h3>
          <p className="text-sm text-gray-500 mt-1">
            完全由這裡新增/編輯/刪除（優先順序：旺季 &gt; 連假 &gt; 一般日期依星期幾判斷）。
          </p>
        </div>

        <div className="p-6 border-b flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">類型</label>
            <select value={newRange.range_type} onChange={(e) => setNewRange({ ...newRange, range_type: e.target.value })} className="px-3 py-2 border rounded-lg bg-white">
              <option value="旺季">旺季</option>
              <option value="連假">連假</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">起始日期</label>
            <input type="date" value={newRange.start_date} onChange={(e) => setNewRange({ ...newRange, start_date: e.target.value })} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">結束日期</label>
            <input type="date" value={newRange.end_date} onChange={(e) => setNewRange({ ...newRange, end_date: e.target.value })} className="px-3 py-2 border rounded-lg" />
          </div>
          <div className="flex-1 min-w-[150px]">
            <label className="block text-xs text-gray-500 mb-1">備註</label>
            <input value={newRange.label} onChange={(e) => setNewRange({ ...newRange, label: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：端午連假" />
          </div>
          <button onClick={addDateRange} className="flex items-center gap-1 bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-700">
            <Plus className="w-4 h-4" /> 新增區間
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">類型</th>
                <th className="py-3 px-4">起始日期</th>
                <th className="py-3 px-4">結束日期</th>
                <th className="py-3 px-4">備註</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {dateRanges.map((d) => (
                <tr key={d.id}>
                  <td className="p-2">
                    <select value={d.range_type} onChange={(e) => updateDateRange(d.id, 'range_type', e.target.value)} className="px-2 py-1 border rounded bg-white">
                      <option value="旺季">旺季</option>
                      <option value="連假">連假</option>
                    </select>
                  </td>
                  <td className="p-2">
                    <input type="date" value={d.start_date} onChange={(e) => updateDateRange(d.id, 'start_date', e.target.value)} className="px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input type="date" value={d.end_date} onChange={(e) => updateDateRange(d.id, 'end_date', e.target.value)} className="px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input value={d.label} onChange={(e) => updateDateRange(d.id, 'label', e.target.value)} className="w-40 px-2 py-1 border rounded" placeholder="例如：端午連假" />
                  </td>
                  <td className="p-2">
                    <button onClick={() => deleteDateRange(d.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {dateRanges.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-gray-400">
                    尚未設定任何日期區間
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 測試報價 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Calculator className="w-5 h-5 text-orange-600" />
            測試報價
          </h3>
          <p className="text-sm text-gray-500 mt-1">用畫面上目前（含未儲存）的資料試算，方便您調整完馬上驗證，不用先儲存。</p>
        </div>
        <div className="p-6 flex flex-wrap gap-3 items-end border-b">
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住日期</label>
            <input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">人數</label>
            <input type="number" min={1} value={quoteHeadcount} onChange={(e) => setQuoteHeadcount(Number(e.target.value))} className="w-24 px-3 py-2 border rounded-lg" />
          </div>
          <button onClick={runTestQuote} className="flex items-center gap-1 bg-orange-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-700">
            <Calculator className="w-4 h-4" /> 試算
          </button>
        </div>

        {quoteResult && (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-600">
              判定 tier：<span className="font-bold text-gray-800">{quoteResult.tier}</span>
              {quoteResult.recommendation.recommended && quoteResult.recommendation.savings ? (
                <span className="ml-3 text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded">
                  推薦{quoteResult.recommendation.recommended === 'wholeHouse' ? '包棟' : '個別租房'}，可省 NT$ {quoteResult.recommendation.savings.toLocaleString()}
                </span>
              ) : null}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-2">個別租房</h4>
                {!quoteResult.individualOption ? (
                  <p className="text-sm text-gray-400">此 tier 不開放個別租房，只能包棟</p>
                ) : (
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs font-medium text-gray-500 mb-1">方案一：加開房</p>
                      {!quoteResult.individualOption.openRoomOption.success ? (
                        <p className="text-sm text-red-500">目前房型總容量不足以容納 {quoteResult.headcount} 人</p>
                      ) : (
                        <div className="text-sm space-y-1">
                          {quoteResult.individualOption.openRoomOption.rooms.map((r, i) => (
                            <div key={i} className="flex justify-between">
                              <span>{r.name}（{r.floor} / {r.capacity}人）</span>
                              <span>NT$ {r.price}</span>
                            </div>
                          ))}
                          <div className="flex justify-between font-bold border-t pt-1 mt-1">
                            <span>總計</span>
                            <span>NT$ {quoteResult.individualOption.openRoomOption.totalPrice}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {quoteResult.individualOption.extraPersonOption && (
                      <div className="border-t pt-3">
                        <p className="text-xs font-medium text-gray-500 mb-1">方案二：加人不加房</p>
                        <div className="text-sm space-y-1">
                          {quoteResult.individualOption.extraPersonOption.baseRooms.map((r, i) => (
                            <div key={i} className="flex justify-between">
                              <span>{r.name}（{r.floor} / {r.capacity}人）</span>
                              <span>NT$ {r.price}</span>
                            </div>
                          ))}
                          {quoteResult.individualOption.extraPersonOption.extraAssignments.map((a, i) => (
                            <div key={i} className="flex justify-between text-gray-600">
                              <span>　{a.room.name} 加 {a.extraCount} 人</span>
                              <span>NT$ {a.extraPrice}</span>
                            </div>
                          ))}
                          <div className="flex justify-between font-bold border-t pt-1 mt-1">
                            <span>總計</span>
                            <span>NT$ {quoteResult.individualOption.extraPersonOption.totalPrice}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-2">包棟</h4>
                {!wholeHouseEnabled ? (
                  <p className="text-sm text-gray-400">目前已關閉包棟方案</p>
                ) : !quoteResult.wholeHouseOption ? (
                  <p className="text-sm text-gray-400">沒有對應的包棟報價資料，或超過最大接待人數</p>
                ) : (
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span>方案基礎（{quoteResult.wholeHouseOption.package.occupancy}人：{packageRoomNames(quoteResult.wholeHouseOption.package.id)}）</span>
                      <span>NT$ {quoteResult.wholeHouseOption.basePrice}</span>
                    </div>
                    {quoteResult.wholeHouseOption.extraPersons > 0 && (
                      <>
                        <p className="text-xs text-gray-500 pt-1">超額 {quoteResult.wholeHouseOption.extraPersons} 人，加人方案：</p>
                        {quoteResult.wholeHouseOption.extraPersonOptions.map((o, i) => (
                          <div key={i} className="flex justify-between">
                            <span>　{o.rule_label || o.rule_type}</span>
                            <span>NT$ {o.grandTotal}</span>
                          </div>
                        ))}
                      </>
                    )}
                    {quoteResult.wholeHouseOption.extraPersons === 0 && (
                      <div className="flex justify-between font-bold border-t pt-1 mt-1">
                        <span>總計</span>
                        <span>NT$ {quoteResult.wholeHouseOption.basePrice}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

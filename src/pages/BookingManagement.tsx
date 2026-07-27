import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, CalendarRange, Home, Users, Calculator } from 'lucide-react';
import {
  computeQuote,
  QuoteResult,
} from '../lib/bookingEngine';

// 房型/包棟方案定價目前支援的 tier，對應 bookingEngine.resolvePricingTier() 實際會判斷出來的級距。
// 加人規則不含「定價」（原始表格也沒有這欄）。
const PRICING_TIERS = ['平日', '小假日', '連假', '旺季', '定價'];
const EXTRA_PERSON_TIERS = ['平日', '小假日', '連假', '旺季'];
const RULE_TYPE_OPTIONS = [
  { value: 'no_extra_room', label: '不多開房' },
  { value: 'extra_room', label: '多開房' },
];

async function upsertTierPrice(
  table: string,
  idField: string,
  idValue: string,
  tier: string,
  priceInput: string,
  list: any[],
  setList: (v: any[]) => void
) {
  const price = priceInput === '' ? null : Number(priceInput);
  const existing = list.find((p) => p[idField] === idValue && p.tier === tier);
  if (existing) {
    setList(list.map((p) => (p === existing ? { ...p, price } : p)));
    await supabase.from(table).update({ price }).eq(idField, idValue).eq('tier', tier);
  } else {
    const { data, error } = await supabase.from(table).insert({ [idField]: idValue, tier, price }).select().single();
    if (!error && data) setList([...list, data]);
  }
}

function getTierPrice(list: any[], idField: string, idValue: string, tier: string): string {
  const found = list.find((p) => p[idField] === idValue && p.tier === tier);
  return found && found.price != null ? String(found.price) : '';
}

export default function BookingManagement() {
  const [loading, setLoading] = useState(true);
  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [roomPricing, setRoomPricing] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [packagePricing, setPackagePricing] = useState<any[]>([]);
  const [extraRules, setExtraRules] = useState<any[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);

  const [newRange, setNewRange] = useState({ range_type: '旺季', start_date: '', end_date: '', label: '' });

  const [quoteDate, setQuoteDate] = useState('');
  const [quoteHeadcount, setQuoteHeadcount] = useState(4);
  const [quoteResult, setQuoteResult] = useState<QuoteResult | null>(null);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [rt, rp, wp, wpp, epr, dr] = await Promise.all([
      supabase.from('room_types').select('*').order('display_order'),
      supabase.from('room_pricing').select('*'),
      supabase.from('whole_house_packages').select('*').order('display_order'),
      supabase.from('whole_house_package_pricing').select('*'),
      supabase.from('whole_house_extra_person_rules').select('*'),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
    ]);
    setRoomTypes(rt.data || []);
    setRoomPricing(rp.data || []);
    setPackages(wp.data || []);
    setPackagePricing(wpp.data || []);
    setExtraRules(epr.data || []);
    setDateRanges(dr.data || []);
    setLoading(false);
  };

  // ---------------- 房型 ----------------
  const addRoomType = async () => {
    const { data, error } = await supabase
      .from('room_types')
      .insert({ name: '新房型', floor: '', capacity: 2, display_order: roomTypes.length })
      .select()
      .single();
    if (!error && data) setRoomTypes([...roomTypes, data]);
  };

  const updateRoomType = async (id: string, field: string, value: any) => {
    setRoomTypes(roomTypes.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    await supabase.from('room_types').update({ [field]: value }).eq('id', id);
  };

  const deleteRoomType = async (id: string) => {
    if (!confirm('確定要刪除這個房型嗎？相關定價也會一併刪除。')) return;
    await supabase.from('room_types').delete().eq('id', id);
    setRoomTypes(roomTypes.filter((r) => r.id !== id));
    setRoomPricing(roomPricing.filter((p) => p.room_type_id !== id));
  };

  // ---------------- 包棟方案 ----------------
  const addPackage = async () => {
    const { data, error } = await supabase
      .from('whole_house_packages')
      .insert({ occupancy: 10, room_combo: '', display_order: packages.length })
      .select()
      .single();
    if (!error && data) setPackages([...packages, data]);
  };

  const updatePackage = async (id: string, field: string, value: any) => {
    setPackages(packages.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
    await supabase.from('whole_house_packages').update({ [field]: value }).eq('id', id);
  };

  const deletePackage = async (id: string) => {
    if (!confirm('確定要刪除這個包棟方案嗎？相關定價也會一併刪除。')) return;
    await supabase.from('whole_house_packages').delete().eq('id', id);
    setPackages(packages.filter((p) => p.id !== id));
    setPackagePricing(packagePricing.filter((p) => p.package_id !== id));
  };

  // ---------------- 加人規則 ----------------
  const addExtraRule = async () => {
    const { data, error } = await supabase
      .from('whole_house_extra_person_rules')
      .insert({ rule_type: 'no_extra_room', rule_label: '不多開房', tier: '平日', price: null })
      .select()
      .single();
    if (!error && data) setExtraRules([...extraRules, data]);
  };

  const updateExtraRule = async (id: string, field: string, value: any) => {
    setExtraRules(extraRules.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    await supabase.from('whole_house_extra_person_rules').update({ [field]: value }).eq('id', id);
  };

  const deleteExtraRule = async (id: string) => {
    if (!confirm('確定要刪除這筆加人規則嗎？')) return;
    await supabase.from('whole_house_extra_person_rules').delete().eq('id', id);
    setExtraRules(extraRules.filter((r) => r.id !== id));
  };

  // ---------------- 日期區間 ----------------
  const addDateRange = async () => {
    if (!newRange.start_date || !newRange.end_date) {
      alert('請填入起訖日期');
      return;
    }
    const { data, error } = await supabase.from('booking_date_ranges').insert(newRange).select().single();
    if (!error && data) {
      setDateRanges([...dateRanges, data].sort((a, b) => a.start_date.localeCompare(b.start_date)));
      setNewRange({ range_type: '旺季', start_date: '', end_date: '', label: '' });
    }
  };

  const updateDateRange = async (id: string, field: string, value: any) => {
    setDateRanges(dateRanges.map((d) => (d.id === id ? { ...d, [field]: value } : d)));
    await supabase.from('booking_date_ranges').update({ [field]: value }).eq('id', id);
  };

  const deleteDateRange = async (id: string) => {
    await supabase.from('booking_date_ranges').delete().eq('id', id);
    setDateRanges(dateRanges.filter((d) => d.id !== id));
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
      packages,
      packagePricing,
      extraPersonRules: extraRules,
      maxOccupancy,
    });
    setQuoteResult(result);
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-xl shadow-sm border">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <CalendarRange className="w-6 h-6 text-blue-600" />
          訂房管理（Phase 1：資料設定）
        </h2>
        <p className="text-gray-500 mt-1">
          維護房型、定價、包棟方案與日期區間。這些資料會用於報價引擎計算，尚未串接 LINE 對話（Phase 2 才會串接）。
        </p>
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
                    <input defaultValue={r.name} onBlur={(e) => updateRoomType(r.id, 'name', e.target.value)} className="w-28 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input defaultValue={r.floor} onBlur={(e) => updateRoomType(r.id, 'floor', e.target.value)} className="w-16 px-2 py-1 border rounded" placeholder="2F" />
                  </td>
                  <td className="p-2">
                    <input type="number" defaultValue={r.capacity} onBlur={(e) => updateRoomType(r.id, 'capacity', Number(e.target.value))} className="w-16 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input type="number" defaultValue={r.display_order} onBlur={(e) => updateRoomType(r.id, 'display_order', Number(e.target.value))} className="w-14 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2 text-center">
                    <input type="checkbox" checked={r.is_active} onChange={(e) => updateRoomType(r.id, 'is_active', e.target.checked)} />
                  </td>
                  {PRICING_TIERS.map((tier) => (
                    <td key={tier} className="p-2">
                      <input
                        type="number"
                        defaultValue={getTierPrice(roomPricing, 'room_type_id', r.id, tier)}
                        onBlur={(e) => upsertTierPrice('room_pricing', 'room_type_id', r.id, tier, e.target.value, roomPricing, setRoomPricing)}
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
                  <td colSpan={6 + PRICING_TIERS.length} className="py-10 text-center text-gray-400">
                    尚未設定房型，點右上角「新增房型」開始
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400 px-6 py-3 border-t">
          某個 tier 留空＝該 tier 不開放個別租房（顧客只能選包棟）。之後要開放，把價格填上即可，不用額外設定日期區間。
        </p>
      </div>

      {/* 包棟方案與定價 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-600" />
            包棟方案與定價
          </h3>
          <button onClick={addPackage} className="flex items-center gap-1 bg-purple-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-purple-700">
            <Plus className="w-4 h-4" /> 新增方案
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">動人數</th>
                <th className="py-3 px-4">房型人數搭配（說明用）</th>
                <th className="py-3 px-4">排序</th>
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
                    <input type="number" defaultValue={p.occupancy} onBlur={(e) => updatePackage(p.id, 'occupancy', Number(e.target.value))} className="w-16 px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input defaultValue={p.room_combo} onBlur={(e) => updatePackage(p.id, 'room_combo', e.target.value)} className="w-32 px-2 py-1 border rounded" placeholder="4+4+2" />
                  </td>
                  <td className="p-2">
                    <input type="number" defaultValue={p.display_order} onBlur={(e) => updatePackage(p.id, 'display_order', Number(e.target.value))} className="w-14 px-2 py-1 border rounded" />
                  </td>
                  {PRICING_TIERS.map((tier) => (
                    <td key={tier} className="p-2">
                      <input
                        type="number"
                        defaultValue={getTierPrice(packagePricing, 'package_id', p.id, tier)}
                        onBlur={(e) => upsertTierPrice('whole_house_package_pricing', 'package_id', p.id, tier, e.target.value, packagePricing, setPackagePricing)}
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
                  <td colSpan={4 + PRICING_TIERS.length} className="py-10 text-center text-gray-400">
                    尚未設定包棟方案，點右上角「新增方案」開始
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 加人規則 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex justify-between items-center p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800">包棟超額加人規則</h3>
          <button onClick={addExtraRule} className="flex items-center gap-1 bg-gray-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-800">
            <Plus className="w-4 h-4" /> 新增規則
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">類型</th>
                <th className="py-3 px-4">顯示名稱</th>
                <th className="py-3 px-4">定價 tier</th>
                <th className="py-3 px-4">每人加價</th>
                <th className="py-3 px-4"></th>
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
                    <input defaultValue={r.rule_label} onBlur={(e) => updateExtraRule(r.id, 'rule_label', e.target.value)} className="w-32 px-2 py-1 border rounded" placeholder="不加床、不多開房" />
                  </td>
                  <td className="p-2">
                    <select value={r.tier} onChange={(e) => updateExtraRule(r.id, 'tier', e.target.value)} className="px-2 py-1 border rounded bg-white">
                      {EXTRA_PERSON_TIERS.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2">
                    <input
                      type="number"
                      defaultValue={r.price ?? ''}
                      onBlur={(e) => updateExtraRule(r.id, 'price', e.target.value === '' ? null : Number(e.target.value))}
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
                  <td colSpan={5} className="py-10 text-center text-gray-400">
                    尚未設定加人規則
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
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
                    <input type="date" defaultValue={d.start_date} onBlur={(e) => updateDateRange(d.id, 'start_date', e.target.value)} className="px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input type="date" defaultValue={d.end_date} onBlur={(e) => updateDateRange(d.id, 'end_date', e.target.value)} className="px-2 py-1 border rounded" />
                  </td>
                  <td className="p-2">
                    <input defaultValue={d.label} onBlur={(e) => updateDateRange(d.id, 'label', e.target.value)} className="w-40 px-2 py-1 border rounded" placeholder="例如：端午連假" />
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
          <p className="text-sm text-gray-500 mt-1">用來驗證上面填的資料算出來的價格是否正確，尚未接上 LINE 對話。</p>
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
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-2">個別租房</h4>
                {!quoteResult.individualOption ? (
                  <p className="text-sm text-gray-400">此 tier 不開放個別租房，只能包棟</p>
                ) : !quoteResult.individualOption.success ? (
                  <p className="text-sm text-red-500">目前房型總容量不足以容納 {quoteResult.headcount} 人</p>
                ) : (
                  <div className="text-sm space-y-1">
                    {quoteResult.individualOption.rooms.map((r, i) => (
                      <div key={i} className="flex justify-between">
                        <span>{r.name}（{r.floor} / {r.capacity}人）</span>
                        <span>NT$ {r.price}</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold border-t pt-1 mt-1">
                      <span>總計</span>
                      <span>NT$ {quoteResult.individualOption.totalPrice}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-2">包棟</h4>
                {!quoteResult.wholeHouseOption ? (
                  <p className="text-sm text-gray-400">沒有對應的包棟報價資料，或超過最大接待人數</p>
                ) : (
                  <div className="text-sm space-y-1">
                    <div className="flex justify-between">
                      <span>方案基礎（{quoteResult.wholeHouseOption.package.occupancy}人：{quoteResult.wholeHouseOption.package.room_combo}）</span>
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

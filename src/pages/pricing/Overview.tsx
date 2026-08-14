import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { OCCUPYING_STATUSES } from '../../lib/bookingStatus';
import { LayoutDashboard, DoorOpen, Sparkles, Percent, DollarSign, Save, ArrowRight, Lightbulb } from 'lucide-react';
import { PageHeader, Button, StatCard } from '../../components/ui';

function promotionLabel(p: any): string {
  return p.discount_type === 'amount' ? `${p.name}（折抵 NT$${(p.discount_amount || 0).toLocaleString()}）` : `${p.name}（${p.discount_percent}%）`;
}

const TIPS = [
  '所有設定改完記得按右上角「儲存所有設定」，畫面上的修改才會真正寫入資料庫。',
  '特殊日期價格優先於一般日期加價設定，命中時會直接覆蓋整段計算。',
  '低於「最少接待人數」的詢問，LINE 對話流程會自動轉真人客服，不會自動報價。',
  '促銷方案同時間只會有一筆生效中（單選），不是多筆同時疊加。',
];

export default function PricingOverview() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [bedBaseRate, setBedBaseRate] = useState(1000);
  const [fullOccupancyBonus, setFullOccupancyBonus] = useState(500);
  const [minGroupHeadcount, setMinGroupHeadcount] = useState(1);
  const [dateSurchargeSmall, setDateSurchargeSmall] = useState(5000);
  const [dateSurchargePeak, setDateSurchargePeak] = useState(8000);
  const [dateSurchargeHoliday, setDateSurchargeHoliday] = useState(12000);
  const [activePromotionId, setActivePromotionId] = useState('');

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [capacityFees, setCapacityFees] = useState<{ capacity: number; extra_room_fee: number }[]>([]);
  const [promotions, setPromotions] = useState<any[]>([]);
  const [specialPriceCount, setSpecialPriceCount] = useState(0);
  const [monthRevenue, setMonthRevenue] = useState(0);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthStart = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

    const [st, rt, cap, promo, sp, bk] = await Promise.all([
      supabase
        .from('settings')
        .select('id, bed_base_rate, full_occupancy_bonus, min_group_headcount, date_surcharge_small_holiday, date_surcharge_peak, date_surcharge_long_holiday, active_promotion_id')
        .single(),
      supabase.from('room_types').select('*').eq('type', '房間').order('display_order'),
      supabase.from('room_capacity_pricing').select('*'),
      supabase.from('promotions').select('*').order('created_at'),
      supabase.from('special_prices').select('*', { count: 'exact', head: true }),
      supabase
        .from('bookings')
        .select('room_amount, checkin_date, status')
        .gte('checkin_date', monthStart)
        .lt('checkin_date', nextMonthStart)
        .in('status', OCCUPYING_STATUSES),
    ]);

    setSettingsId(st.data?.id || null);
    setBedBaseRate(st.data?.bed_base_rate ?? 1000);
    setFullOccupancyBonus(st.data?.full_occupancy_bonus ?? 500);
    setMinGroupHeadcount(st.data?.min_group_headcount ?? 1);
    setDateSurchargeSmall(st.data?.date_surcharge_small_holiday ?? 5000);
    setDateSurchargePeak(st.data?.date_surcharge_peak ?? 8000);
    setDateSurchargeHoliday(st.data?.date_surcharge_long_holiday ?? 12000);
    setActivePromotionId(st.data?.active_promotion_id ?? '');
    setRoomTypes(rt.data || []);
    setCapacityFees((cap.data || []).map((c: any) => ({ capacity: c.capacity, extra_room_fee: c.extra_room_fee })));
    setPromotions(promo.data || []);
    setSpecialPriceCount(sp.count ?? 0);
    setMonthRevenue((bk.data || []).reduce((sum: number, b: any) => sum + Number(b.room_amount || 0), 0));
    setLoading(false);
  };

  const handleSave = async () => {
    if (!settingsId) return;
    setSaving(true);
    try {
      await supabase
        .from('settings')
        .update({
          bed_base_rate: bedBaseRate,
          full_occupancy_bonus: fullOccupancyBonus,
          min_group_headcount: minGroupHeadcount,
          date_surcharge_small_holiday: dateSurchargeSmall,
          date_surcharge_peak: dateSurchargePeak,
          date_surcharge_long_holiday: dateSurchargeHoliday,
          active_promotion_id: activePromotionId || null,
        })
        .eq('id', settingsId);
      await fetchAll();
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const activeRoomCount = roomTypes.filter((r) => r.is_active !== false).length;

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        icon={<LayoutDashboard className="w-6 h-6 text-green-600" />}
        title="價格設定總覽"
        description="快速管理房型、促銷與特殊日期設定。以下是常用設定的捷徑，完整內容請到左側「價格設定」子選單各頁面管理。"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存所有設定'}
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={<DoorOpen className="w-4 h-4" />} label="房型總數" value={activeRoomCount} />
        <StatCard icon={<Sparkles className="w-4 h-4" />} label="特殊日期" value={specialPriceCount} />
        <StatCard icon={<Percent className="w-4 h-4" />} label="促銷方案" value={promotions.length} />
        <StatCard
          icon={<DollarSign className="w-4 h-4" />}
          label="預估本月營收"
          value={`NT$ ${monthRevenue.toLocaleString()}`}
          valueClassName="text-green-600"
          sublabel="依本月入住日、佔用中訂單的房價加總"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-3">
          <p className="text-sm font-medium text-gray-700">快速設定</p>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">每床基礎價</label>
              <input type="number" value={bedBaseRate} onChange={(e) => setBedBaseRate(Number(e.target.value))} className="w-full px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">滿載獎勵</label>
              <input type="number" value={fullOccupancyBonus} onChange={(e) => setFullOccupancyBonus(Number(e.target.value))} className="w-full px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">最少接待人數</label>
              <input type="number" min={1} value={minGroupHeadcount} onChange={(e) => setMinGroupHeadcount(Number(e.target.value))} className="w-full px-3 py-2 border rounded-lg" />
            </div>
          </div>
          <p className="text-xs text-gray-400">此設定將套用於所有房型，加開房費/房型押金請到「計價公式設定」調整。</p>
          <Link to="/room-pricing/formula" className="text-xs text-green-700 hover:underline inline-flex items-center gap-1">
            查看完整計價公式設定 <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-3">
          <p className="text-sm font-medium text-gray-700">日期加價設定</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm text-gray-600">小假日</label>
              <input type="number" value={dateSurchargeSmall} onChange={(e) => setDateSurchargeSmall(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg text-right" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm text-gray-600">連假</label>
              <input type="number" value={dateSurchargeHoliday} onChange={(e) => setDateSurchargeHoliday(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg text-right" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm text-gray-600">旺季</label>
              <input type="number" value={dateSurchargePeak} onChange={(e) => setDateSurchargePeak(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg text-right" />
            </div>
          </div>
          <Link to="/room-pricing/date-ranges" className="text-xs text-green-700 hover:underline inline-flex items-center gap-1">
            查看詳細日期設定 <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-3">
          <p className="text-sm font-medium text-gray-700">促銷方案</p>
          {promotions.length === 0 ? (
            <p className="text-sm text-gray-400">尚未設定促銷方案</p>
          ) : (
            <div className="space-y-2">
              {promotions.map((p) => {
                const active = activePromotionId === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setActivePromotionId(active ? '' : p.id)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                      active ? 'border-green-400 bg-green-50 text-green-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <span className="truncate">{promotionLabel(p)}</span>
                    {active && <span className="text-xs shrink-0">目前套用</span>}
                  </button>
                );
              })}
            </div>
          )}
          <Link to="/room-pricing/discounts" className="text-xs text-green-700 hover:underline inline-flex items-center gap-1">
            管理所有促銷方案 <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-6 border-b flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-700">房型概覽</p>
            <Link to="/room-spaces" className="text-xs text-green-700 hover:underline inline-flex items-center gap-1">
              管理房型 <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="py-2 px-4">房型</th>
                  <th className="py-2 px-4">容納人數</th>
                  <th className="py-2 px-4">押金</th>
                  <th className="py-2 px-4">該容量加開房費</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {roomTypes.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2 px-4 font-medium">{r.floor ? `${r.floor}-` : ''}{r.name}</td>
                    <td className="py-2 px-4">{r.capacity} 人</td>
                    <td className="py-2 px-4">NT$ {Number(r.security_deposit || 0).toLocaleString()}</td>
                    <td className="py-2 px-4">NT$ {(capacityFees.find((c) => c.capacity === r.capacity)?.extra_room_fee ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
                {roomTypes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-gray-400">尚未設定任何房型</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-3 border-t">
            <Link to="/room-pricing/formula" className="text-xs text-green-700 hover:underline inline-flex items-center gap-1">
              調整加開房費 <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-3">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1.5"><Lightbulb className="w-4 h-4 text-amber-500" />價格設定小提醒</p>
          <ul className="space-y-2 text-xs text-gray-500 list-disc pl-4">
            {TIPS.map((tip, i) => (
              <li key={i}>{tip}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

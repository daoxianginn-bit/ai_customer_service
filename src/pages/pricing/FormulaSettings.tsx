import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { SlidersHorizontal, Save, Info } from 'lucide-react';
import { PageHeader, Button } from '../../components/ui';

function InfoTooltip({ children }: { children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      <Info className="w-3.5 h-3.5 text-gray-400 cursor-help" />
      <span className="hidden group-hover:block absolute z-20 left-0 top-5 w-72 bg-gray-800 text-white text-xs rounded-lg p-3 shadow-lg leading-relaxed">
        {children}
      </span>
    </span>
  );
}

export default function FormulaSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [bedBaseRate, setBedBaseRate] = useState(1000);
  const [fullOccupancyBonus, setFullOccupancyBonus] = useState(500);
  const [minGroupHeadcount, setMinGroupHeadcount] = useState(1);
  const [dateSurchargeSmall, setDateSurchargeSmall] = useState(5000);
  const [dateSurchargePeak, setDateSurchargePeak] = useState(8000);
  const [dateSurchargeHoliday, setDateSurchargeHoliday] = useState(12000);
  const [capacityFees, setCapacityFees] = useState<{ capacity: number; extra_room_fee: number }[]>([]);
  const [roomTypes, setRoomTypes] = useState<any[]>([]);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [st, rt, cap] = await Promise.all([
      supabase
        .from('settings')
        .select('id, bed_base_rate, full_occupancy_bonus, min_group_headcount, date_surcharge_small_holiday, date_surcharge_peak, date_surcharge_long_holiday')
        .single(),
      supabase.from('room_types').select('*').eq('type', '房間').order('display_order'),
      supabase.from('room_capacity_pricing').select('*'),
    ]);
    setSettingsId(st.data?.id || null);
    setBedBaseRate(st.data?.bed_base_rate ?? 1000);
    setFullOccupancyBonus(st.data?.full_occupancy_bonus ?? 500);
    setMinGroupHeadcount(st.data?.min_group_headcount ?? 1);
    setDateSurchargeSmall(st.data?.date_surcharge_small_holiday ?? 5000);
    setDateSurchargePeak(st.data?.date_surcharge_peak ?? 8000);
    setDateSurchargeHoliday(st.data?.date_surcharge_long_holiday ?? 12000);
    const roomTypeRows = rt.data || [];
    setRoomTypes(roomTypeRows);
    // 每種目前實際啟用中的容量都要有一筆加開費設定，新房型/新容量會自動補一筆預設 0，
    // 已經有的容量沿用資料庫既有的值。
    const distinctCaps = Array.from(new Set(roomTypeRows.filter((r: any) => r.is_active !== false).map((r: any) => r.capacity))).filter(
      (c): c is number => typeof c === 'number' && c > 0
    );
    const existingCap = cap.data || [];
    setCapacityFees(distinctCaps.map((c) => existingCap.find((e: any) => e.capacity === c) || { capacity: c, extra_room_fee: 0 }));
    setLoading(false);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (settingsId) {
        await supabase
          .from('settings')
          .update({
            bed_base_rate: bedBaseRate,
            full_occupancy_bonus: fullOccupancyBonus,
            min_group_headcount: minGroupHeadcount,
            date_surcharge_small_holiday: dateSurchargeSmall,
            date_surcharge_peak: dateSurchargePeak,
            date_surcharge_long_holiday: dateSurchargeHoliday,
          })
          .eq('id', settingsId);
      }
      if (roomTypes.length) await supabase.from('room_types').upsert(roomTypes);
      if (capacityFees.length) await supabase.from('room_capacity_pricing').upsert(capacityFees);
      await fetchAll();
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const updateRoomType = (id: string, field: string, value: any) => {
    setRoomTypes(roomTypes.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const getCapacityFee = (capacity: number): number => capacityFees.find((c) => c.capacity === capacity)?.extra_room_fee ?? 0;
  const updateCapacityFee = (capacity: number, value: string) => {
    const fee = value === '' ? 0 : Number(value);
    setCapacityFees(capacityFees.map((c) => (c.capacity === capacity ? { ...c, extra_room_fee: fee } : c)));
  };

  const distinctCapacities = Array.from(new Set(roomTypes.filter((r) => r.is_active !== false).map((r) => r.capacity)))
    .filter((c): c is number => typeof c === 'number' && c > 0)
    .sort((a, b) => a - b);

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        icon={<SlidersHorizontal className="w-6 h-6 text-green-600" />}
        title="計價公式設定"
        description="所有人數統一用這套公式自動報價：標準房型（依人數湊出的床位數）× 每床基礎價 ＋ 滿載獎勵 ＋ 加開房費 ＋ 日期加價。房型基本資料（名稱/樓層/容納人數/組合優先順序）請到「房型與空間維護」調整，這裡只設定訂價相關欄位。"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-6 border-b space-y-3">
            <p className="text-sm font-medium text-gray-700">基礎公式</p>
            <div className="flex flex-wrap gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">每床基礎價</label>
                <input type="number" value={bedBaseRate} onChange={(e) => setBedBaseRate(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
                  滿載獎勵
                  <InfoTooltip>人數剛好等於標準房型的床位數（沒有空床）才加這筆獎勵金，例如 4 人剛好住滿 4 床的房型組合。人數是奇數時一定會有 1 床空著，不會拿到這筆獎勵。</InfoTooltip>
                </label>
                <input type="number" value={fullOccupancyBonus} onChange={(e) => setFullOccupancyBonus(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
                  最少接待人數
                  <InfoTooltip>低於這個人數，LINE 對話流程不會自動報價，會請客人改由真人客服處理。</InfoTooltip>
                </label>
                <input type="number" min={1} value={minGroupHeadcount} onChange={(e) => setMinGroupHeadcount(Number(e.target.value))} className="w-24 px-3 py-2 border rounded-lg" />
              </div>
            </div>
          </div>

          <div className="p-6">
            <p className="text-sm font-medium text-gray-700 mb-3">日期加價（平日 +0，不可調整）</p>
            <div className="flex flex-wrap gap-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">小假日 +</label>
                <input type="number" value={dateSurchargeSmall} onChange={(e) => setDateSurchargeSmall(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">連假 +</label>
                <input type="number" value={dateSurchargeHoliday} onChange={(e) => setDateSurchargeHoliday(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">旺季 +</label>
                <input type="number" value={dateSurchargePeak} onChange={(e) => setDateSurchargePeak(Number(e.target.value))} className="w-28 px-3 py-2 border rounded-lg" />
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-3">旺季／連假的日期區間，請到「房況/行事曆」頁右上角「旺季/連假日期設定」調整。</p>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-3">
          <p className="text-sm font-medium text-gray-700 flex items-center gap-1">
            各容量加開房費
            <InfoTooltip>客人指定的房型組合跟系統算出的「標準房型」不同時，減少的房型間數先抵掉增加的房型間數（不分容量，1 間抵 1 間），抵完剩下的增加間數，才照這裡各自的費率收費加總。</InfoTooltip>
          </p>
          {distinctCapacities.length === 0 ? (
            <p className="text-sm text-gray-400">尚未在「房型與空間維護」設定任何啟用中的房間</p>
          ) : (
            <div className="flex flex-wrap gap-4">
              {distinctCapacities.map((cap) => (
                <div key={cap}>
                  <label className="block text-xs text-gray-500 mb-1">{cap} 人房</label>
                  <input
                    type="number"
                    value={getCapacityFee(cap)}
                    onChange={(e) => updateCapacityFee(cap, e.target.value)}
                    className="w-24 px-3 py-2 border rounded-lg"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border p-6">
        <p className="text-sm font-medium text-gray-700 mb-1">房型押金</p>
        <p className="text-xs text-gray-500 mb-3">開了哪幾間房，押金就是那幾間房押金的加總。</p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-2 px-3">房型</th>
                <th className="py-2 px-3">押金</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {roomTypes.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 px-3 font-medium">{r.floor ? `${r.floor}-` : ''}{r.name}（{r.capacity}人）</td>
                  <td className="p-2">
                    <input
                      type="number"
                      min={0}
                      value={r.security_deposit ?? 0}
                      onChange={(e) => updateRoomType(r.id, 'security_deposit', Number(e.target.value))}
                      className="w-28 px-2 py-1 border rounded"
                    />
                  </td>
                </tr>
              ))}
              {roomTypes.length === 0 && (
                <tr>
                  <td colSpan={2} className="py-6 text-center text-gray-400">尚未設定任何「房間」類型的資料，請先到「房型與空間維護」新增</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

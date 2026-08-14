import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Home, Calculator, Save, Percent, ChevronDown, CalendarDays, Sparkles, Info } from 'lucide-react';
import {
  computeUnifiedMultiNightQuote,
  UnifiedMultiNightQuoteResult,
  RoomCapacityCount,
  CapacityLayout,
} from '../lib/bookingEngine';
import DateRangeCalendar from '../components/DateRangeCalendar';
import { Button } from '../components/ui';

type TabKey = 'quote' | 'formula' | 'special' | 'discounts';
const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'quote', label: '試算報價', icon: Calculator },
  { key: 'formula', label: '計價公式設定', icon: Home },
  { key: 'special', label: '特殊日期價格', icon: Sparkles },
  { key: 'discounts', label: '促銷與折扣', icon: Percent },
];

function newId(): string {
  return crypto.randomUUID();
}

// 促銷方案的顯示文字：百分比或固定金額折抵，依 discount_type 決定要顯示哪個數字。
function promotionLabel(p: any): string {
  return p.discount_type === 'amount' ? `${p.name}（折抵 NT$${(p.discount_amount || 0).toLocaleString()}）` : `${p.name}（${p.discount_percent}%）`;
}

// 房型組合（容量 -> 間數）的顯示文字，依容量由小到大排序，例如 {2:2, 4:1} -> "2人房×2、4人房×1"。
function layoutLabel(layout: CapacityLayout): string {
  const parts = Object.entries(layout)
    .filter(([, count]) => count > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([cap, count]) => `${cap}人房×${count}`);
  return parts.join('、') || '（無房型組合）';
}

// 依實際啟用中的房型算出「容量 -> 間數」庫存，供標準房型／加開房費試算使用。
function roomCapacityCounts(roomTypes: any[]): RoomCapacityCount[] {
  const counts = new Map<number, number>();
  for (const r of roomTypes) {
    if (r.is_active === false || !r.capacity) continue;
    counts.set(r.capacity, (counts.get(r.capacity) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([capacity, count]) => ({ capacity, count }));
}

// 小驚嘆號 icon，滑鼠移過去顯示提示文字。跟 OrderManagement.tsx 的 StatusHelpIcon 同一套 hover 手法。
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

export default function BookingManagement() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('quote');

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [depositPercent, setDepositPercent] = useState(30);
  // LINE 自動報價已經不分個別租房/包棟，這個欄位現在只給「訂單管理」手動建單勾選「包棟」時的
  // 押金預設值用（人工建單仍保留這個獨立分類，跟自動報價公式無關）。
  const [wholeHouseSecurityDeposit, setWholeHouseSecurityDeposit] = useState(3000);
  const [discountCleaning, setDiscountCleaning] = useState(0);
  const [discountNoCleaning, setDiscountNoCleaning] = useState(0);
  const [consecutiveStayDefaultOption, setConsecutiveStayDefaultOption] = useState<'cleaning' | 'no_cleaning'>('no_cleaning');
  // 旺季平日設定跟旺季/連假日期區間本身都搬到「房況/行事曆」頁編輯了，這裡只讀不寫，
  // 純粹是試算報價需要這份資料才能算出 tier。
  const [peakSeasonWeekdayTier, setPeakSeasonWeekdayTier] = useState<'peak' | 'weekday'>('peak');
  // LINE 對話流程「目前生效的促銷方案」：後台選定後，顧客在 LINE 訂房自動套用同一個，
  // 跟這裡「試算報價」選同一個方案算出來的金額保持一致（見 line-webhook.ts finishBookingFlow）。
  const [activePromotionId, setActivePromotionId] = useState<string>('');
  // 特殊指定日期價格命中時，促銷/連住折扣要不要繼續疊加。true＝疊加（特殊價格只是換掉基礎價，
  // 折扣照常套用）；false＝不疊加（特殊價格就是當晚最終金額）。
  const [specialPriceStacksWithDiscounts, setSpecialPriceStacksWithDiscounts] = useState(true);

  // ---------------- 計價公式 ----------------
  const [bedBaseRate, setBedBaseRate] = useState(1000);
  const [fullOccupancyBonus, setFullOccupancyBonus] = useState(500);
  const [minGroupHeadcount, setMinGroupHeadcount] = useState(1);
  const [dateSurchargeSmall, setDateSurchargeSmall] = useState(5000);
  const [dateSurchargePeak, setDateSurchargePeak] = useState(8000);
  const [dateSurchargeHoliday, setDateSurchargeHoliday] = useState(12000);
  const [capacityFees, setCapacityFees] = useState<{ capacity: number; extra_room_fee: number }[]>([]);

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [promotions, setPromotions] = useState<any[]>([]);
  const [specialPrices, setSpecialPrices] = useState<any[]>([]);

  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);

  const [newSpecialPrice, setNewSpecialPrice] = useState({ start_date: '', end_date: '', name: '', occupancy: '', price: '' });

  const [quoteDate, setQuoteDate] = useState('');
  const [quoteCheckoutDate, setQuoteCheckoutDate] = useState('');
  const [quoteHeadcountInput, setQuoteHeadcountInput] = useState('');
  const [quotePromotionId, setQuotePromotionId] = useState<string>('');
  const [quoteApplyConsecutiveDiscount, setQuoteApplyConsecutiveDiscount] = useState(true);
  const [quoteCleaningOption, setQuoteCleaningOption] = useState<'cleaning' | 'noCleaning'>('noCleaning');
  const [quoteSelectedRoomIds, setQuoteSelectedRoomIds] = useState<string[]>([]); // 選填，指定房型組合預覽加開房費
  const [quoteResult, setQuoteResult] = useState<UnifiedMultiNightQuoteResult | null>(null);

  const headcountInputRef = useRef<HTMLInputElement>(null);
  // 行事曆預設收合成一行摘要，選完日期後自動收回，讓手機上「條件選擇＋計算結果」盡量擠在同一頁內看得到。
  const [calendarOpen, setCalendarOpen] = useState(false);

  // 晚數完全由入住/退房日期算出來，不開放手動輸入，避免跟日期兜不起來。
  const quoteNights = (() => {
    if (!quoteDate || !quoteCheckoutDate) return 0;
    const inD = new Date(`${quoteDate}T00:00:00`);
    const outD = new Date(`${quoteCheckoutDate}T00:00:00`);
    const diff = Math.round((outD.getTime() - inD.getTime()) / 86400000);
    return diff > 0 ? diff : 0;
  })();

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [st, rt, cap, dr, promo, sp] = await Promise.all([
      supabase
        .from('settings')
        .select(
          'id, consecutive_stay_discount_cleaning, consecutive_stay_discount_no_cleaning, consecutive_stay_default_option, peak_season_weekday_tier, active_promotion_id, deposit_percent, special_price_stacks_with_discounts, bed_base_rate, full_occupancy_bonus, min_group_headcount, date_surcharge_small_holiday, date_surcharge_peak, date_surcharge_long_holiday, whole_house_security_deposit'
        )
        .single(),
      // 房型與定價只處理「房間」類型的資料（可訂房、可訂價），其他類型（例如公共空間）在
      // 「房型與空間維護」頁面管理，跟訂價/訂房邏輯無關。
      supabase.from('room_types').select('*').eq('type', '房間').order('display_order'),
      supabase.from('room_capacity_pricing').select('*'),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
      supabase.from('promotions').select('*').order('created_at'),
      supabase.from('special_prices').select('*').order('start_date'),
    ]);
    setSettingsId(st.data?.id || null);
    setDiscountCleaning(st.data?.consecutive_stay_discount_cleaning ?? 0);
    setDiscountNoCleaning(st.data?.consecutive_stay_discount_no_cleaning ?? 0);
    setConsecutiveStayDefaultOption(st.data?.consecutive_stay_default_option ?? 'no_cleaning');
    setPeakSeasonWeekdayTier(st.data?.peak_season_weekday_tier ?? 'peak');
    setActivePromotionId(st.data?.active_promotion_id ?? '');
    setDepositPercent(st.data?.deposit_percent ?? 30);
    setWholeHouseSecurityDeposit(st.data?.whole_house_security_deposit ?? 3000);
    setSpecialPriceStacksWithDiscounts(st.data?.special_price_stacks_with_discounts ?? true);
    setBedBaseRate(st.data?.bed_base_rate ?? 1000);
    setFullOccupancyBonus(st.data?.full_occupancy_bonus ?? 500);
    setMinGroupHeadcount(st.data?.min_group_headcount ?? 1);
    setDateSurchargeSmall(st.data?.date_surcharge_small_holiday ?? 5000);
    setDateSurchargePeak(st.data?.date_surcharge_peak ?? 8000);
    setDateSurchargeHoliday(st.data?.date_surcharge_long_holiday ?? 12000);
    // 試算報價的預設值跟著「目前生效中」的設定走，這樣一打開頁面直接按試算，算出來的金額
    // 就會跟 LINE 顧客實際拿到的一致；仍可手動改去測試其他假設情境。
    setQuotePromotionId(st.data?.active_promotion_id ?? '');
    setQuoteApplyConsecutiveDiscount(true);
    setQuoteCleaningOption(st.data?.consecutive_stay_default_option === 'cleaning' ? 'cleaning' : 'noCleaning');
    const roomTypeRows = rt.data || [];
    setRoomTypes(roomTypeRows);
    // 每種目前實際啟用中的容量都要有一筆加開費設定，新房型/新容量會自動補一筆預設 0，
    // 已經有的容量沿用資料庫既有的值。
    const distinctCaps = Array.from(new Set(roomTypeRows.filter((r: any) => r.is_active !== false).map((r: any) => r.capacity))).filter(
      (c): c is number => typeof c === 'number' && c > 0
    );
    const existingCap = cap.data || [];
    setCapacityFees(distinctCaps.map((c) => existingCap.find((e: any) => e.capacity === c) || { capacity: c, extra_room_fee: 0 }));
    setDateRanges(dr.data || []);
    setPromotions(promo.data || []);
    setSpecialPrices(sp.data || []);
    setPendingDeletes([]);
    setQuoteSelectedRoomIds([]);
    setLoading(false);
  };

  const queueDelete = (table: string, id: string) => setPendingDeletes((prev) => [...prev, { table, id }]);

  // ---------------- 儲存 ----------------
  const handleSaveAll = async () => {
    setSaving(true);
    try {
      if (settingsId) {
        await supabase
          .from('settings')
          .update({
            consecutive_stay_discount_cleaning: discountCleaning,
            consecutive_stay_discount_no_cleaning: discountNoCleaning,
            consecutive_stay_default_option: consecutiveStayDefaultOption,
            active_promotion_id: activePromotionId || null,
            deposit_percent: depositPercent,
            whole_house_security_deposit: wholeHouseSecurityDeposit,
            special_price_stacks_with_discounts: specialPriceStacksWithDiscounts,
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
      if (promotions.length) await supabase.from('promotions').upsert(promotions);
      if (specialPrices.length) await supabase.from('special_prices').upsert(specialPrices);

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

  // ---------------- 房型（基本資料在「房型與空間維護」管理，這裡只改押金） ----------------
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

  // ---------------- 特殊指定日期價格 ----------------
  const addSpecialPrice = () => {
    if (!newSpecialPrice.start_date || !newSpecialPrice.end_date || newSpecialPrice.price === '') {
      alert('請填入起訖日期與金額');
      return;
    }
    setSpecialPrices(
      [
        ...specialPrices,
        {
          id: newId(),
          start_date: newSpecialPrice.start_date,
          end_date: newSpecialPrice.end_date,
          name: newSpecialPrice.name,
          occupancy: newSpecialPrice.occupancy === '' ? null : Number(newSpecialPrice.occupancy),
          price: Number(newSpecialPrice.price),
        },
      ].sort((a, b) => a.start_date.localeCompare(b.start_date))
    );
    setNewSpecialPrice({ start_date: '', end_date: '', name: '', occupancy: '', price: '' });
  };

  const updateSpecialPrice = (id: string, field: string, value: any) => {
    setSpecialPrices(specialPrices.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };

  const deleteSpecialPrice = (id: string) => {
    setSpecialPrices(specialPrices.filter((s) => s.id !== id));
    queueDelete('special_prices', id);
  };

  // ---------------- 促銷方案 ----------------
  const addPromotion = () => {
    setPromotions([...promotions, { id: newId(), name: '新促銷方案', discount_type: 'percent', discount_percent: 0, discount_amount: 0 }]);
  };

  const updatePromotion = (id: string, field: string, value: any) => {
    setPromotions(promotions.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const deletePromotion = (id: string) => {
    setPromotions(promotions.filter((p) => p.id !== id));
    if (quotePromotionId === id) setQuotePromotionId('');
    if (activePromotionId === id) setActivePromotionId('');
    queueDelete('promotions', id);
  };

  // ---------------- 試算報價 ----------------
  const quoteHeadcount = Number(quoteHeadcountInput);

  const toggleQuoteRoom = (roomId: string) => {
    setQuoteSelectedRoomIds((prev) => (prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId]));
  };

  // 指定要試算哪個房型組合時，換算成「容量 -> 間數」，用來預覽加開房費；
  // 沒勾選就不帶，系統自動用這個人數算出的標準房型。
  const quoteRequestedLayout: CapacityLayout | null = quoteSelectedRoomIds.length
    ? quoteSelectedRoomIds.reduce((acc: CapacityLayout, id) => {
        const cap = roomTypes.find((r) => r.id === id)?.capacity;
        if (cap) acc[cap] = (acc[cap] || 0) + 1;
        return acc;
      }, {})
    : null;

  const runTestQuote = () => {
    if (!quoteDate || !quoteCheckoutDate) {
      alert('請在行事曆選擇入住日期與退房日期');
      return;
    }
    if (quoteNights <= 0) {
      alert('退房日期需晚於入住日期');
      return;
    }
    if (!quoteHeadcountInput || Number.isNaN(quoteHeadcount) || quoteHeadcount <= 0) {
      alert('請輸入人數');
      return;
    }
    const selectedPromotion = promotions.find((p) => p.id === quotePromotionId) || null;
    const consecutiveStayDiscountPerNight = quoteApplyConsecutiveDiscount
      ? quoteCleaningOption === 'cleaning'
        ? discountCleaning
        : discountNoCleaning
      : 0;

    const result = computeUnifiedMultiNightQuote({
      checkInDate: new Date(`${quoteDate}T00:00:00`),
      nights: quoteNights,
      headcount: quoteHeadcount,
      dateRanges: dateRanges.map((d) => ({ range_type: d.range_type, start_date: d.start_date, end_date: d.end_date })),
      roomCapacities: roomCapacityCounts(roomTypes),
      capacityFees,
      bedBaseRate,
      fullOccupancyBonus,
      minGroupHeadcount,
      dateSurcharge: { small_holiday: dateSurchargeSmall, peak: dateSurchargePeak, long_holiday: dateSurchargeHoliday },
      requestedLayout: quoteRequestedLayout,
      promotion: selectedPromotion,
      consecutiveStayDiscountPerNight,
      peakSeasonWeekdayTier,
      specialPrices: specialPrices.map((s) => ({ start_date: s.start_date, end_date: s.end_date, occupancy: s.occupancy, price: s.price })),
      specialPriceStacksWithDiscounts,
    });
    setQuoteResult(result);
  };

  // 試算結果每一晚實際套用了哪個優惠：第一晚看促銷方案，第二晚起看連住折扣（開關關閉就是無優惠）。
  const nightDiscountLabel = (index: number): string => {
    if (index === 0) {
      const promo = promotions.find((p) => p.id === quotePromotionId);
      if (!promo) return '無優惠';
      return promo.discount_type === 'amount'
        ? `促銷：${promo.name}（折抵 NT$${(promo.discount_amount || 0).toLocaleString()}）`
        : `促銷：${promo.name}（${promo.discount_percent}% 折扣）`;
    }
    if (!quoteApplyConsecutiveDiscount) return '無優惠';
    const perNight = quoteCleaningOption === 'cleaning' ? discountCleaning : discountNoCleaning;
    const cleaningLabel = quoteCleaningOption === 'cleaning' ? '需打掃' : '無需打掃';
    return perNight > 0 ? `連住折扣・${cleaningLabel}（折抵 NT$${perNight.toLocaleString()}）` : '無優惠';
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-gray-800">報價設定</h2>
          <p className="text-sm text-gray-500">
            所有變更會先暫存在畫面上，按「儲存變更」才會真正寫入資料庫。LINE 訂房對話流程的觸發關鍵字與罐頭訊息，請到「訂房設定 &gt; 流程設定」調整。
          </p>
        </div>
        <Button onClick={handleSaveAll} loading={saving} icon={<Save className="w-4 h-4" />}>
          {saving ? '儲存中...' : '儲存變更'}
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 border-b overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                active ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* ============== 試算報價 ============== */}
      {activeTab === 'quote' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-6 border-b">
            <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2">
              <Calculator className="w-5 h-5 text-orange-600" />
              試算報價
            </h3>
            <p className="text-sm text-gray-500 mt-1">用畫面上目前（含未儲存）的資料試算，方便您調整完馬上驗證，不用先儲存。</p>
          </div>

          <div className="p-6 border-b space-y-4">
            <div>
              <button
                type="button"
                onClick={() => setCalendarOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-2 px-4 py-3 border rounded-lg text-left hover:bg-gray-50"
              >
                <span className="flex items-center gap-2 text-sm text-gray-700 min-w-0">
                  <CalendarDays className="w-4 h-4 text-gray-400 shrink-0" />
                  <span className="truncate">
                    {quoteDate && quoteCheckoutDate
                      ? `入住 ${quoteDate}　退房 ${quoteCheckoutDate}（${quoteNights} 晚）`
                      : quoteDate
                      ? `已選入住 ${quoteDate}，請點選退房日期`
                      : '點此選擇入住／退房日期'}
                  </span>
                </span>
                <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${calendarOpen ? 'rotate-180' : ''}`} />
              </button>
              {calendarOpen && (
                <div className="mt-3 p-3 border rounded-lg">
                  <DateRangeCalendar
                    startDate={quoteDate}
                    endDate={quoteCheckoutDate}
                    onChange={(start, end) => {
                      setQuoteDate(start);
                      setQuoteCheckoutDate(end);
                    }}
                    onRangeComplete={() => {
                      setCalendarOpen(false);
                      headcountInputRef.current?.focus();
                    }}
                  />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">人數</label>
                <input
                  ref={headcountInputRef}
                  type="number"
                  value={quoteHeadcountInput}
                  onChange={(e) => setQuoteHeadcountInput(e.target.value)}
                  className="w-full sm:w-20 px-3 py-2 border rounded-lg"
                  placeholder="請輸入"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">促銷方案（預設＝目前生效中，可改選測試其他情境）</label>
                <select value={quotePromotionId} onChange={(e) => setQuotePromotionId(e.target.value)} className="w-full sm:w-auto px-3 py-2 border rounded-lg bg-white">
                  <option value="">無</option>
                  {promotions.map((p) => (
                    <option key={p.id} value={p.id}>{promotionLabel(p)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="flex items-center gap-2 text-xs text-gray-500 mb-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={quoteApplyConsecutiveDiscount}
                    onChange={(e) => setQuoteApplyConsecutiveDiscount(e.target.checked)}
                    className="w-4 h-4"
                  />
                  連住折扣
                </label>
                <select
                  value={quoteCleaningOption}
                  onChange={(e) => setQuoteCleaningOption(e.target.value as 'cleaning' | 'noCleaning')}
                  disabled={!quoteApplyConsecutiveDiscount}
                  className="w-full sm:w-auto px-3 py-2 border rounded-lg bg-white disabled:bg-gray-100 disabled:text-gray-400"
                >
                  <option value="noCleaning">無需打掃</option>
                  <option value="cleaning">需打掃</option>
                </select>
              </div>
              <div className="flex items-end">
                <button onClick={runTestQuote} className="w-full sm:w-auto flex items-center justify-center gap-1 bg-orange-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-orange-700">
                  <Calculator className="w-4 h-4" /> 試算
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
                指定房型組合（選填）
                <InfoTooltip>不指定就用系統依人數算出的「標準房型」試算。有勾選的話，用來預覽「加開房費」——例如人數沒變多，但多要一間房。</InfoTooltip>
              </label>
              <div className="flex flex-wrap gap-2">
                {roomTypes.filter((r) => r.is_active !== false).map((r) => {
                  const checked = quoteSelectedRoomIds.includes(r.id);
                  return (
                    <label
                      key={r.id}
                      className={`flex items-center gap-1.5 px-3 py-1.5 border rounded-lg text-xs cursor-pointer ${checked ? 'bg-orange-50 border-orange-300' : 'border-gray-200'}`}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleQuoteRoom(r.id)} />
                      {r.name}（{r.capacity}人）
                    </label>
                  );
                })}
                {roomTypes.length === 0 && <span className="text-xs text-gray-400">尚未設定任何房型</span>}
              </div>
            </div>
          </div>

          {quoteResult && (
            <div className="p-6">
              {quoteResult.total == null ? (
                <div className="border border-amber-300 bg-amber-50 rounded-lg p-4 text-sm text-amber-800">
                  無法自動報價：人數可能低於最少接待人數（{minGroupHeadcount} 人）、超過目前房型庫存可接待人數，或現有庫存湊不出這個人數需要的床位數，需轉真人客服處理。
                </div>
              ) : (
                <div className="border rounded-lg p-4">
                  <p className="text-xs text-gray-400 mb-3">標準房型：{layoutLabel(quoteResult.standardLayout || {})}</p>
                  <div className="text-sm space-y-2">
                    {quoteResult.nightly.map((n, i) => (
                      <div key={i} className="flex justify-between gap-2">
                        <span>
                          {n.date.toLocaleDateString('zh-TW')}（{n.tier}）{i === 0 ? '　第一晚' : `　第${i + 1}晚`}
                          <span className="block text-xs text-gray-400">{nightDiscountLabel(i)}</span>
                          <span className="block text-xs text-gray-400">房型：{layoutLabel(n.layoutUsed)}</span>
                        </span>
                        <span className="whitespace-nowrap">NT$ {n.discountedPrice.toLocaleString()}</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold border-t pt-1 mt-1">
                      <span>總計</span>
                      <span>NT$ {quoteResult.total.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ============== 計價公式設定 ============== */}
      {activeTab === 'formula' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-6 border-b">
            <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2"><Home className="w-5 h-5 text-green-600" />計價公式設定</h3>
            <p className="text-sm text-gray-500 mt-1">
              所有人數統一用這套公式自動報價：標準房型（依人數湊出的床位數）× 每床基礎價 ＋ 滿載獎勵 ＋ 加開房費 ＋ 日期加價。
              房型基本資料（名稱/樓層/容納人數/組合優先順序）請到「房型與空間維護」調整，這裡只設定訂價相關欄位。
            </p>
          </div>

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

          <div className="p-6 border-b space-y-3">
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

          <div className="p-6 border-b space-y-3">
            <p className="text-sm font-medium text-gray-700">日期加價（平日 +0，不可調整）</p>
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
            <p className="text-xs text-gray-400">旺季／連假的日期區間，請到「房況與行事曆」設定。</p>
          </div>

          <div className="p-6">
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
      )}

      {/* ============== 特殊日期價格 ============== */}
      {activeTab === 'special' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-6 border-b">
            <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2"><Sparkles className="w-5 h-5 text-amber-600" />特殊日期價格</h3>
            <p className="text-sm text-gray-500 mt-1">
              日期區間命中時直接用這個絕對金額當那一晚的最終基礎價，優先權最高，取代「標準價格＋加開房費＋日期加價」整段計算。
              人數留空＝不分人數都套用；要不要繼續疊加促銷/連住折扣，去「促銷與折扣」分頁設定。
            </p>
          </div>

          <div className="p-6 border-b bg-gray-50 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">起始日期</label>
              <input type="date" value={newSpecialPrice.start_date} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, start_date: e.target.value })} className="px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">結束日期</label>
              <input type="date" value={newSpecialPrice.end_date} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, end_date: e.target.value })} className="px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">名稱</label>
              <input value={newSpecialPrice.name} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, name: e.target.value })} className="w-32 px-3 py-2 border rounded-lg" placeholder="例如：跨年" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">人數（留空＝不分人數）</label>
              <input type="number" value={newSpecialPrice.occupancy} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, occupancy: e.target.value })} className="w-24 px-3 py-2 border rounded-lg" placeholder="不限" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">金額</label>
              <input type="number" value={newSpecialPrice.price} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, price: e.target.value })} className="w-28 px-3 py-2 border rounded-lg" placeholder="30000" />
            </div>
            <button onClick={addSpecialPrice} className="flex items-center gap-1 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-amber-700">
              <Plus className="w-4 h-4" /> 新增
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="py-3 px-4">起始日期</th>
                  <th className="py-3 px-4">結束日期</th>
                  <th className="py-3 px-4">名稱</th>
                  <th className="py-3 px-4">人數</th>
                  <th className="py-3 px-4">金額</th>
                  <th className="py-3 px-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {specialPrices.map((s) => (
                  <tr key={s.id}>
                    <td className="p-2"><input type="date" value={s.start_date} onChange={(e) => updateSpecialPrice(s.id, 'start_date', e.target.value)} className="px-2 py-1 border rounded" /></td>
                    <td className="p-2"><input type="date" value={s.end_date} onChange={(e) => updateSpecialPrice(s.id, 'end_date', e.target.value)} className="px-2 py-1 border rounded" /></td>
                    <td className="p-2"><input value={s.name || ''} onChange={(e) => updateSpecialPrice(s.id, 'name', e.target.value)} className="w-28 px-2 py-1 border rounded" /></td>
                    <td className="p-2">
                      <input
                        type="number"
                        value={s.occupancy ?? ''}
                        onChange={(e) => updateSpecialPrice(s.id, 'occupancy', e.target.value === '' ? null : Number(e.target.value))}
                        className="w-20 px-2 py-1 border rounded"
                        placeholder="不限"
                      />
                    </td>
                    <td className="p-2"><input type="number" value={s.price} onChange={(e) => updateSpecialPrice(s.id, 'price', Number(e.target.value))} className="w-28 px-2 py-1 border rounded" /></td>
                    <td className="p-2">
                      <button onClick={() => deleteSpecialPrice(s.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {specialPrices.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-gray-400">尚未設定任何特殊日期價格</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ============== 促銷與折扣 ============== */}
      {activeTab === 'discounts' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="p-6 border-b bg-amber-50">
            <label className="block text-sm font-medium text-gray-700 mb-1">LINE 對話流程目前套用的促銷方案</label>
            <p className="text-xs text-gray-500 mb-2">
              顧客在 LINE 上聊天訂房會自動套用這裡選定的方案，不用顧客自己提、也不會另外詢問。選「無」就跟現在一樣不打折。
              跟「試算報價」選同一個方案時，算出來的金額會完全一致。
            </p>
            <select value={activePromotionId} onChange={(e) => setActivePromotionId(e.target.value)} className="px-3 py-2 border rounded-lg bg-white">
              <option value="">無（不套用促銷）</option>
              {promotions.map((p) => (
                <option key={p.id} value={p.id}>{promotionLabel(p)}</option>
              ))}
            </select>
          </div>

          <div className="p-6 border-b">
            <div className="flex justify-between items-center mb-3">
              <p className="text-sm font-medium text-gray-700">促銷方案清單（名稱 + 打折%／固定金額折抵，只套用在第一晚）</p>
              <button onClick={addPromotion} className="flex items-center gap-1 bg-gray-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-800">
                <Plus className="w-4 h-4" /> 新增方案
              </button>
            </div>
            <div className="space-y-2">
              {promotions.map((p) => (
                <div key={p.id} className="flex items-center gap-2">
                  <input value={p.name} onChange={(e) => updatePromotion(p.id, 'name', e.target.value)} className="flex-1 px-2 py-1 border rounded" placeholder="促銷方案名稱" />
                  <select value={p.discount_type || 'percent'} onChange={(e) => updatePromotion(p.id, 'discount_type', e.target.value)} className="px-2 py-1 border rounded bg-white">
                    <option value="percent">打折%</option>
                    <option value="amount">固定金額</option>
                  </select>
                  {p.discount_type === 'amount' ? (
                    <>
                      <input type="number" value={p.discount_amount ?? 0} onChange={(e) => updatePromotion(p.id, 'discount_amount', Number(e.target.value))} className="w-24 px-2 py-1 border rounded" />
                      <span className="text-xs text-gray-400">元折抵</span>
                    </>
                  ) : (
                    <>
                      <input type="number" value={p.discount_percent} onChange={(e) => updatePromotion(p.id, 'discount_percent', Number(e.target.value))} className="w-20 px-2 py-1 border rounded" />
                      <span className="text-xs text-gray-400">% 折扣</span>
                    </>
                  )}
                  <button onClick={() => deletePromotion(p.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              {promotions.length === 0 && <p className="text-sm text-gray-400">尚未設定促銷方案</p>}
            </div>
          </div>

          <div className="p-6 border-b">
            <p className="text-sm font-medium text-gray-700 mb-3">連住折扣（固定金額，第二晚（含）以後每晚折抵）</p>
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">需打掃，每晚折抵</label>
                <input type="number" value={discountCleaning} onChange={(e) => setDiscountCleaning(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">無需打掃，每晚折抵</label>
                <input type="number" value={discountNoCleaning} onChange={(e) => setDiscountNoCleaning(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">LINE 自動報價套用哪一種</label>
                <select value={consecutiveStayDefaultOption} onChange={(e) => setConsecutiveStayDefaultOption(e.target.value as 'cleaning' | 'no_cleaning')} className="px-3 py-2 border rounded-lg bg-white">
                  <option value="no_cleaning">無需打掃</option>
                  <option value="cleaning">需打掃</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-2">連住折扣是民宿自訂政策、不是詢問顧客的選項，LINE 對話流程會自動套用這裡選的類型，不會另外問顧客。</p>
          </div>

          <div className="p-6 border-b">
            <p className="text-sm font-medium text-gray-700 mb-1">特殊日期價格遇到促銷/連住折扣</p>
            <p className="text-xs text-gray-500 mb-3">「特殊日期價格」分頁設定的日期命中時，促銷跟連住折扣要不要繼續套用在那晚上面。</p>
            <div className="space-y-2">
              <label className={`flex items-start gap-2 p-3 border rounded-lg cursor-pointer ${specialPriceStacksWithDiscounts === false ? 'border-green-400 bg-green-50' : 'border-gray-200'}`}>
                <input type="radio" checked={specialPriceStacksWithDiscounts === false} onChange={() => setSpecialPriceStacksWithDiscounts(false)} className="mt-0.5" />
                <span className="text-sm text-gray-700 flex items-center gap-1.5">
                  特殊價格就是當晚最終金額
                  <InfoTooltip>例：跨年夜設定特殊價 30000。就算這晚剛好是住宿第一晚（本來可套用促銷 9 折）或第三晚（本來可扣連住折扣 -1000），一律照樣收 30000，不會再打折或扣錢。</InfoTooltip>
                </span>
              </label>
              <label className={`flex items-start gap-2 p-3 border rounded-lg cursor-pointer ${specialPriceStacksWithDiscounts ? 'border-green-400 bg-green-50' : 'border-gray-200'}`}>
                <input type="radio" checked={specialPriceStacksWithDiscounts} onChange={() => setSpecialPriceStacksWithDiscounts(true)} className="mt-0.5" />
                <span className="text-sm text-gray-700 flex items-center gap-1.5">
                  特殊價格只換掉基礎價
                  <InfoTooltip>例：跨年夜特殊價 30000，剛好是住宿第一晚 → 系統還會再打促銷折扣，例如 9 折變 27000；或剛好是第三晚 → 還會再扣連住折扣，實收金額可能比設定的特殊價格低。</InfoTooltip>
                </span>
              </label>
            </div>
          </div>

          <div className="p-6">
            <p className="text-sm font-medium text-gray-700 mb-1">押金與訂金</p>
            <p className="text-xs text-gray-500 mb-3">
              訂單總額 ＝ 房價 ＋ 押金（開了哪幾間房，押金就是那幾間房押金的加總，請到「計價公式設定」分頁調整各房型押金）；
              本次需匯訂金 ＝ <strong>房價</strong>的固定比例（不含押金）。LINE 自動報價會照這裡的設定算好，不需要人工填。
            </p>
            <div className="flex flex-wrap gap-4 items-end">
              <div>
                <label className="block text-xs text-gray-500 mb-1">訂金比例（房價的 %）</label>
                <input type="number" min={0} max={100} value={depositPercent} onChange={(e) => setDepositPercent(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
                  包棟押金（人工建單用）
                  <InfoTooltip>LINE 自動報價已經不分個別租房/包棟，這個金額只有「訂單管理」手動建單時勾選「包棟」才會拿來當押金預設值，跟自動報價公式無關。</InfoTooltip>
                </label>
                <input type="number" min={0} value={wholeHouseSecurityDeposit} onChange={(e) => setWholeHouseSecurityDeposit(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

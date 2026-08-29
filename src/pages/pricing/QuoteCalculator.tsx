import { useState, useEffect, useRef } from 'react';
import { supabase } from '../../lib/supabase';
import { Calculator, ChevronDown, CalendarDays, Info } from 'lucide-react';
import { computeUnifiedMultiNightQuote, UnifiedMultiNightQuoteResult, RoomCapacityCount, CapacityLayout } from '../../lib/bookingEngine';
import DateRangeCalendar from '../../components/DateRangeCalendar';
import { PageHeader } from '../../components/ui';

function promotionLabel(p: any): string {
  return p.discount_type === 'amount' ? `${p.name}（折抵 NT$${(p.discount_amount || 0).toLocaleString()}）` : `${p.name}（${p.discount_percent}%）`;
}

function layoutLabel(layout: CapacityLayout): string {
  const parts = Object.entries(layout)
    .filter(([, count]) => count > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([cap, count]) => `${cap}人房×${count}`);
  return parts.join('、') || '（無房型組合）';
}

function roomCapacityCounts(roomTypes: any[]): RoomCapacityCount[] {
  const counts = new Map<number, number>();
  for (const r of roomTypes) {
    if (r.is_active === false || !r.capacity) continue;
    counts.set(r.capacity, (counts.get(r.capacity) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([capacity, count]) => ({ capacity, count }));
}

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

/**
 * 試算報價。原本是「價格設定」底下的獨立頁面，現在改成「計價公式設定」標題列的一顆按鈕，
 * 開在對話框裡——改公式跟驗證公式本來就是同一件事的兩半，分成兩頁要來回切換才比得出差異。
 *
 * embedded：開在對話框裡時傳 true，省掉頁面標題與外層卡片邊框（對話框自己有標題與框）。
 * 業務邏輯完全共用，沒有第二份試算程式碼。
 */
export default function QuoteCalculator({ embedded = false }: { embedded?: boolean } = {}) {
  const [loading, setLoading] = useState(true);

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [promotions, setPromotions] = useState<any[]>([]);
  const [specialPrices, setSpecialPrices] = useState<any[]>([]);
  const [capacityFees, setCapacityFees] = useState<{ capacity: number; extra_room_fee: number }[]>([]);

  const [bedBaseRate, setBedBaseRate] = useState(1000);
  const [fullOccupancyBonus, setFullOccupancyBonus] = useState(500);
  const [minGroupHeadcount, setMinGroupHeadcount] = useState(1);
  const [dateSurchargeSmall, setDateSurchargeSmall] = useState(5000);
  const [dateSurchargePeak, setDateSurchargePeak] = useState(8000);
  const [dateSurchargeHoliday, setDateSurchargeHoliday] = useState(12000);
  const [peakSeasonWeekdayTier, setPeakSeasonWeekdayTier] = useState<'peak' | 'weekday'>('peak');
  const [weekdayRange, setWeekdayRange] = useState<'sun_thu' | 'sun_fri'>('sun_thu');
  const [discountCleaning, setDiscountCleaning] = useState(0);
  const [discountNoCleaning, setDiscountNoCleaning] = useState(0);
  const [specialPriceStacksWithDiscounts, setSpecialPriceStacksWithDiscounts] = useState(true);

  const [quoteDate, setQuoteDate] = useState('');
  const [quoteCheckoutDate, setQuoteCheckoutDate] = useState('');
  const [quoteHeadcountInput, setQuoteHeadcountInput] = useState('');
  const [quotePromotionId, setQuotePromotionId] = useState<string>('');
  const [quoteApplyConsecutiveDiscount, setQuoteApplyConsecutiveDiscount] = useState(true);
  const [quoteCleaningOption, setQuoteCleaningOption] = useState<'cleaning' | 'noCleaning'>('noCleaning');
  const [quoteSelectedRoomIds, setQuoteSelectedRoomIds] = useState<string[]>([]);
  const [quoteResult, setQuoteResult] = useState<UnifiedMultiNightQuoteResult | null>(null);

  const headcountInputRef = useRef<HTMLInputElement>(null);
  const [calendarOpen, setCalendarOpen] = useState(false);

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
          'bed_base_rate, full_occupancy_bonus, min_group_headcount, date_surcharge_small_holiday, date_surcharge_peak, date_surcharge_long_holiday, peak_season_weekday_tier, weekday_range, consecutive_stay_discount_cleaning, consecutive_stay_discount_no_cleaning, consecutive_stay_default_option, active_promotion_id, special_price_stacks_with_discounts'
        )
        .single(),
      supabase.from('room_types').select('*').eq('type', '房間').order('display_order'),
      supabase.from('room_capacity_pricing').select('*'),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
      supabase.from('promotions').select('*').order('created_at'),
      supabase.from('special_prices').select('*').order('start_date'),
    ]);
    setBedBaseRate(st.data?.bed_base_rate ?? 1000);
    setFullOccupancyBonus(st.data?.full_occupancy_bonus ?? 500);
    setMinGroupHeadcount(st.data?.min_group_headcount ?? 1);
    setDateSurchargeSmall(st.data?.date_surcharge_small_holiday ?? 5000);
    setDateSurchargePeak(st.data?.date_surcharge_peak ?? 8000);
    setDateSurchargeHoliday(st.data?.date_surcharge_long_holiday ?? 12000);
    setPeakSeasonWeekdayTier(st.data?.peak_season_weekday_tier ?? 'peak');
    setWeekdayRange(st.data?.weekday_range ?? 'sun_thu');
    setDiscountCleaning(st.data?.consecutive_stay_discount_cleaning ?? 0);
    setDiscountNoCleaning(st.data?.consecutive_stay_discount_no_cleaning ?? 0);
    setSpecialPriceStacksWithDiscounts(st.data?.special_price_stacks_with_discounts ?? true);
    setQuotePromotionId(st.data?.active_promotion_id ?? '');
    setQuoteApplyConsecutiveDiscount(true);
    setQuoteCleaningOption(st.data?.consecutive_stay_default_option === 'cleaning' ? 'cleaning' : 'noCleaning');
    setRoomTypes(rt.data || []);
    setCapacityFees((cap.data || []).map((c: any) => ({ capacity: c.capacity, extra_room_fee: c.extra_room_fee })));
    setDateRanges(dr.data || []);
    setPromotions(promo.data || []);
    setSpecialPrices(sp.data || []);
    setQuoteSelectedRoomIds([]);
    setQuoteResult(null);
    setLoading(false);
  };

  const quoteHeadcount = Number(quoteHeadcountInput);

  const toggleQuoteRoom = (roomId: string) => {
    setQuoteSelectedRoomIds((prev) => (prev.includes(roomId) ? prev.filter((id) => id !== roomId) : [...prev, roomId]));
  };

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
      weekdayRange,
      specialPrices: specialPrices.map((s) => ({ start_date: s.start_date, end_date: s.end_date, occupancy: s.occupancy, price: s.price })),
      specialPriceStacksWithDiscounts,
    });
    setQuoteResult(result);
  };

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
    <div className={embedded ? '' : 'w-full space-y-4'}>
      {!embedded && (
        <PageHeader
          icon={<Calculator className="w-6 h-6 text-orange-600" />}
          title="試算報價"
          description="這裡試算的是「目前已儲存」的計價公式/日期加價/促銷設定，不含其他分頁還沒按儲存的修改。要改公式請到「計價公式設定」。"
        />
      )}

      <div className={embedded ? 'overflow-hidden' : 'bg-white rounded-xl shadow-sm border overflow-hidden'}>
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
    </div>
  );
}

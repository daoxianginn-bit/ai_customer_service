import { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Home, Users, Calculator, Save, Wand2, Percent, ChevronDown, CalendarDays, Download } from 'lucide-react';
import {
  suggestRoomCombo,
  getAvailableIndividualRooms,
  computeIndividualOptions,
  selectWholeHousePackage,
  selectWholeHouseUpgradeOption,
  compareOptions,
  computeMultiNightQuote,
  MultiNightQuoteResult,
} from '../lib/bookingEngine';
import CollapsibleSection from '../components/CollapsibleSection';
import DateRangeCalendar from '../components/DateRangeCalendar';
import { Button } from '../components/ui';

// 房型/包棟方案定價目前支援的 tier，對應 bookingEngine.resolvePricingTier() 實際會判斷出來的級距。
const PRICING_TIERS = ['平日', '小假日', '連假', '旺季', '定價'];
// 自動報價總表只顯示會被實際判斷出來的營運 tier（不含「定價」這種純參考價）。
const MATRIX_TIERS = ['平日', '小假日', '連假', '旺季'];
const RULE_TYPE_OPTIONS = [
  { value: 'no_extra_room', label: '不開房' },
  { value: 'extra_room', label: '開房' },
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
  const [discountCleaning, setDiscountCleaning] = useState(0);
  const [discountNoCleaning, setDiscountNoCleaning] = useState(0);
  const [consecutiveStayDefaultOption, setConsecutiveStayDefaultOption] = useState<'cleaning' | 'no_cleaning'>('no_cleaning');
  const [peakSeasonWeekdayTier, setPeakSeasonWeekdayTier] = useState<'peak' | 'weekday'>('peak');
  // LINE 對話流程「目前生效的促銷方案」：後台選定後，顧客在 LINE 訂房自動套用同一個，
  // 跟這裡「試算報價」選同一個方案算出來的金額保持一致（見 line-webhook.ts handleBookingFlow）。
  const [activePromotionId, setActivePromotionId] = useState<string>('');

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [roomPricing, setRoomPricing] = useState<any[]>([]);
  const [roomExtraPersonPricing, setRoomExtraPersonPricing] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [packagePricing, setPackagePricing] = useState<any[]>([]);
  const [packageRooms, setPackageRooms] = useState<any[]>([]);
  const [extraRules, setExtraRules] = useState<any[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [promotions, setPromotions] = useState<any[]>([]);

  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);

  const [newRange, setNewRange] = useState({ range_type: '旺季', start_date: '', end_date: '', label: '' });
  const [newPackage, setNewPackage] = useState<{ occupancy: number; roomIds: string[] }>({ occupancy: 10, roomIds: [] });
  const [importYearInput, setImportYearInput] = useState(String(new Date().getFullYear()));
  const [importingHolidays, setImportingHolidays] = useState(false);

  const [quoteDate, setQuoteDate] = useState('');
  const [quoteCheckoutDate, setQuoteCheckoutDate] = useState('');
  const [quoteHeadcountInput, setQuoteHeadcountInput] = useState('');
  const [quotePromotionId, setQuotePromotionId] = useState<string>('');
  const [quoteApplyConsecutiveDiscount, setQuoteApplyConsecutiveDiscount] = useState(true);
  const [quoteCleaningOption, setQuoteCleaningOption] = useState<'cleaning' | 'noCleaning'>('noCleaning');
  const [quoteResult, setQuoteResult] = useState<MultiNightQuoteResult | null>(null);

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
    const [st, rt, rp, rep, wp, wpp, wpr, epr, dr, promo] = await Promise.all([
      supabase
        .from('settings')
        .select(
          'id, booking_whole_house_enabled, consecutive_stay_discount_cleaning, consecutive_stay_discount_no_cleaning, consecutive_stay_default_option, peak_season_weekday_tier, active_promotion_id'
        )
        .single(),
      supabase.from('room_types').select('*').order('display_order'),
      supabase.from('room_pricing').select('*'),
      supabase.from('room_extra_person_pricing').select('*'),
      supabase.from('whole_house_packages').select('*').order('display_order'),
      supabase.from('whole_house_package_pricing').select('*'),
      supabase.from('whole_house_package_rooms').select('*'),
      supabase.from('whole_house_extra_person_rules').select('*'),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
      supabase.from('promotions').select('*').order('created_at'),
    ]);
    setSettingsId(st.data?.id || null);
    setWholeHouseEnabled(st.data?.booking_whole_house_enabled ?? true);
    setDiscountCleaning(st.data?.consecutive_stay_discount_cleaning ?? 0);
    setDiscountNoCleaning(st.data?.consecutive_stay_discount_no_cleaning ?? 0);
    setConsecutiveStayDefaultOption(st.data?.consecutive_stay_default_option ?? 'no_cleaning');
    setPeakSeasonWeekdayTier(st.data?.peak_season_weekday_tier ?? 'peak');
    setActivePromotionId(st.data?.active_promotion_id ?? '');
    // 試算報價的預設值跟著「目前生效中」的設定走，這樣一打開頁面直接按試算，算出來的金額
    // 就會跟 LINE 顧客實際拿到的一致；仍可手動改去測試其他假設情境。
    setQuotePromotionId(st.data?.active_promotion_id ?? '');
    setQuoteApplyConsecutiveDiscount(true);
    setQuoteCleaningOption(st.data?.consecutive_stay_default_option === 'cleaning' ? 'cleaning' : 'noCleaning');
    setRoomTypes(rt.data || []);
    setRoomPricing(rp.data || []);
    setRoomExtraPersonPricing(rep.data || []);
    setPackages(wp.data || []);
    setPackagePricing(wpp.data || []);
    setPackageRooms(wpr.data || []);
    setExtraRules(epr.data || []);
    setDateRanges(dr.data || []);
    setPromotions(promo.data || []);
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
        await supabase
          .from('settings')
          .update({
            booking_whole_house_enabled: wholeHouseEnabled,
            consecutive_stay_discount_cleaning: discountCleaning,
            consecutive_stay_discount_no_cleaning: discountNoCleaning,
            consecutive_stay_default_option: consecutiveStayDefaultOption,
            peak_season_weekday_tier: peakSeasonWeekdayTier,
            active_promotion_id: activePromotionId || null,
          })
          .eq('id', settingsId);
      }
      if (roomTypes.length) await supabase.from('room_types').upsert(roomTypes);
      if (roomPricing.length) await supabase.from('room_pricing').upsert(roomPricing);
      if (roomExtraPersonPricing.length) await supabase.from('room_extra_person_pricing').upsert(roomExtraPersonPricing);
      if (packages.length) await supabase.from('whole_house_packages').upsert(packages);
      if (packagePricing.length) await supabase.from('whole_house_package_pricing').upsert(packagePricing);
      if (packageRooms.length) await supabase.from('whole_house_package_rooms').upsert(packageRooms);
      if (extraRules.length) await supabase.from('whole_house_extra_person_rules').upsert(extraRules);
      if (dateRanges.length) await supabase.from('booking_date_ranges').upsert(dateRanges);
      if (promotions.length) await supabase.from('promotions').upsert(promotions);

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
    setExtraRules([...extraRules, { id: newId(), rule_type: 'no_extra_room', rule_label: '不開房', tier: '平日', price: null }]);
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

  // 匯入國家連假行事曆：資料來源為 TaiwanCalendar（社群整理的政府行政機關辦公日曆表 JSON），
  // 依規定政府每年 6/30 前（特殊情形 8/31 前）會公告次年行事曆，所以通常 5、6 月後就能匯入明年的連假。
  // 把連續放假日分組成一段一段區間，只留有假期名稱的那幾段（純週末六日不匯入，交給預設平日/小假日邏輯處理）。
  const importHolidayCalendar = async () => {
    const year = Number(importYearInput);
    if (!year || year < 2000 || year > 2100) {
      alert('請輸入有效的西元年份，例如 2027');
      return;
    }
    setImportingHolidays(true);
    try {
      const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
      if (!res.ok) throw new Error('查無這個年份的資料，可能政府尚未公告，或年份輸入錯誤');
      const data: { date: string; isHoliday: boolean; description: string }[] = await res.json();

      const runs: { start: string; end: string; labels: string[] }[] = [];
      let current: { start: string; end: string; labels: string[] } | null = null;
      for (const day of data) {
        const iso = `${day.date.slice(0, 4)}-${day.date.slice(4, 6)}-${day.date.slice(6, 8)}`;
        if (day.isHoliday) {
          if (!current) current = { start: iso, end: iso, labels: [] };
          current.end = iso;
          if (day.description && !current.labels.includes(day.description)) current.labels.push(day.description);
        } else if (current) {
          runs.push(current);
          current = null;
        }
      }
      if (current) runs.push(current);

      const namedRuns = runs.filter((r) => r.labels.length > 0);
      const toAdd = namedRuns
        .filter((run) => !dateRanges.some((d) => d.range_type === '連假' && d.start_date === run.start && d.end_date === run.end))
        .map((run) => ({ id: newId(), range_type: '連假', start_date: run.start, end_date: run.end, label: run.labels.join('、') }));

      if (toAdd.length) {
        setDateRanges([...dateRanges, ...toAdd].sort((a, b) => a.start_date.localeCompare(b.start_date)));
      }
      alert(`匯入完成：新增 ${toAdd.length} 筆連假區間，${namedRuns.length - toAdd.length} 筆已存在略過。記得按「儲存變更」才會真正寫入資料庫。`);
    } catch (err: any) {
      alert(`匯入失敗：${err.message || '無法取得資料'}`);
    } finally {
      setImportingHolidays(false);
    }
  };

  // 匯入旺季日期：固定套用暑假旺季區間 07/01～08/31，年份跟「匯入國家連假行事曆」共用同一個輸入框。
  const importPeakSeasonDates = () => {
    const year = Number(importYearInput);
    if (!year || year < 2000 || year > 2100) {
      alert('請輸入有效的西元年份，例如 2027');
      return;
    }
    const start = `${year}-07-01`;
    const end = `${year}-08-31`;
    if (dateRanges.some((d) => d.range_type === '旺季' && d.start_date === start && d.end_date === end)) {
      alert(`${year} 年 07/01～08/31 的旺季區間已經存在，未重複新增。`);
      return;
    }
    setDateRanges(
      [...dateRanges, { id: newId(), range_type: '旺季', start_date: start, end_date: end, label: `${year}年暑假旺季` }].sort((a, b) =>
        a.start_date.localeCompare(b.start_date)
      )
    );
    alert(`已新增 ${year}/07/01～${year}/08/31 旺季區間，記得按「儲存變更」才會真正寫入資料庫。`);
  };

  // ---------------- 促銷方案 ----------------
  const addPromotion = () => {
    setPromotions([...promotions, { id: newId(), name: '新促銷方案', discount_percent: 0 }]);
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
  const runTestQuote = () => {
    if (!quoteDate || !quoteCheckoutDate) {
      alert('請在行事曆選擇入住日期與退房日期');
      return;
    }
    if (quoteNights <= 0) {
      alert('退房日期需晚於入住日期');
      return;
    }
    const headcount = Number(quoteHeadcountInput);
    if (!quoteHeadcountInput || Number.isNaN(headcount) || headcount <= 0) {
      alert('請輸入人數');
      return;
    }
    const maxOccupancy = packages.length ? Math.max(...packages.map((p) => p.occupancy)) : 0;
    const selectedPromotion = promotions.find((p) => p.id === quotePromotionId) || null;
    const consecutiveStayDiscountPerNight = quoteApplyConsecutiveDiscount
      ? quoteCleaningOption === 'cleaning'
        ? discountCleaning
        : discountNoCleaning
      : 0;
    const result = computeMultiNightQuote({
      checkInDate: new Date(`${quoteDate}T00:00:00`),
      nights: quoteNights,
      headcount,
      dateRanges: dateRanges.map((d) => ({ range_type: d.range_type, start_date: d.start_date, end_date: d.end_date })),
      roomTypes,
      roomPricing,
      roomExtraPersonPricing,
      packages: wholeHouseEnabled ? packages : [],
      packagePricing: wholeHouseEnabled ? packagePricing : [],
      extraPersonRules: wholeHouseEnabled ? extraRules : [],
      maxOccupancy,
      promotion: selectedPromotion,
      consecutiveStayDiscountPerNight,
      peakSeasonWeekdayTier,
    });
    setQuoteResult(result);
  };

  // 試算結果每一晚實際套用了哪個優惠：第一晚看促銷方案，第二晚起看連住折扣（開關關閉就是無優惠）。
  const nightDiscountLabel = (index: number, rawPrice: number | null): string => {
    if (rawPrice == null) return '—';
    if (index === 0) {
      const promo = promotions.find((p) => p.id === quotePromotionId);
      return promo ? `促銷：${promo.name}（${promo.discount_percent}% 折扣）` : '無優惠';
    }
    if (!quoteApplyConsecutiveDiscount) return '無優惠';
    const perNight = quoteCleaningOption === 'cleaning' ? discountCleaning : discountNoCleaning;
    const cleaningLabel = quoteCleaningOption === 'cleaning' ? '需打掃' : '無需打掃';
    return perNight > 0 ? `連住折扣・${cleaningLabel}（折抵 NT$${perNight.toLocaleString()}）` : '無優惠';
  };

  // 試算結果房型備註：個別租房顯示用到哪些房型（含容納人數），包棟顯示套用哪個人數級距的方案。
  const individualRoomNote = (rooms: any[] | undefined): string => {
    if (!rooms || !rooms.length) return '';
    return `房型：${rooms.map((r) => `${r.name}（${r.capacity}人）`).join('、')}`;
  };

  const wholeHouseRoomNote = (pkg: any | undefined): string => {
    if (!pkg) return '';
    return `方案：${pkg.occupancy}人棟（${packageRoomNames(pkg.id)}）`;
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
    const upgradeOption = selectWholeHouseUpgradeOption(headcount, packages, packagePricing, tier);
    const recommendation = compareOptions(individualOption, wholeHouseOption);
    const baseTotal = wholeHouseOption
      ? wholeHouseOption.extraPersonOptions.length
        ? Math.min(...wholeHouseOption.extraPersonOptions.map((o) => o.grandTotal))
        : wholeHouseOption.basePrice
      : null;
    // 只有升等後套用的級距跟「不開房」的基礎級距不同（代表人數卡在兩個級距中間），才視為獨立的第二個價格顯示
    const showUpgrade = upgradeOption && wholeHouseOption && upgradeOption.package.id !== wholeHouseOption.package.id;
    return { baseTotal, upgradePrice: showUpgrade ? (upgradeOption as NonNullable<typeof upgradeOption>).price : null, recommendation };
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <CollapsibleSection
        title="報價設定"
        defaultOpen={false}
        headerExtra={
          <Button onClick={handleSaveAll} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      >
        <p className="px-6 pb-6 text-gray-500 text-sm">
          所有變更會先暫存在畫面上，按「儲存變更」才會真正寫入資料庫，避免不小心異動。LINE 訂房對話流程的觸發關鍵字與罐頭訊息，請到「訂房設定 &gt; 流程設定」調整。
        </p>
      </CollapsibleSection>

      {/* 試算報價（主要工具，固定在最上面，不收合） */}
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
                  <option key={p.id} value={p.id}>{p.name}（{p.discount_percent}%）</option>
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
        </div>

        {quoteResult && (
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-2">個別租房</h4>
                <div className="text-sm space-y-2">
                  {quoteResult.individual.nights.map((n, i) => (
                    <div key={i} className="flex justify-between gap-2">
                      <span>
                        {n.date.toLocaleDateString('zh-TW')}（{n.tier}）{i === 0 ? '　第一晚' : `　第${i + 1}晚`}
                        <span className="block text-xs text-gray-400">{nightDiscountLabel(i, n.rawPrice)}</span>
                        {individualRoomNote(n.roomsUsed) && (
                          <span className="block text-xs text-gray-400">{individualRoomNote(n.roomsUsed)}</span>
                        )}
                      </span>
                      <span className="whitespace-nowrap">{n.discountedPrice == null ? '不可用' : `NT$ ${n.discountedPrice.toLocaleString()}`}</span>
                    </div>
                  ))}
                  <div className="flex justify-between font-bold border-t pt-1 mt-1">
                    <span>總計</span>
                    <span>{quoteResult.individual.total == null ? '無法報價' : `NT$ ${quoteResult.individual.total.toLocaleString()}`}</span>
                  </div>
                </div>
              </div>

              <div className="border rounded-lg p-4">
                <h4 className="font-semibold text-gray-700 mb-2">包棟</h4>
                {!wholeHouseEnabled ? (
                  <p className="text-sm text-gray-400">目前已關閉包棟方案</p>
                ) : (
                  <div className="text-sm space-y-2">
                    {quoteResult.wholeHouse.nights.map((n, i) => (
                      <div key={i} className="flex justify-between gap-2">
                        <span>
                          {n.date.toLocaleDateString('zh-TW')}（{n.tier}）{i === 0 ? '　第一晚' : `　第${i + 1}晚`}
                          <span className="block text-xs text-gray-400">{nightDiscountLabel(i, n.rawPrice)}</span>
                          {wholeHouseRoomNote(n.packageUsed) && (
                            <span className="block text-xs text-gray-400">{wholeHouseRoomNote(n.packageUsed)}</span>
                          )}
                        </span>
                        <span className="whitespace-nowrap">{n.discountedPrice == null ? '不可用' : `NT$ ${n.discountedPrice.toLocaleString()}`}</span>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold border-t pt-1 mt-1">
                      <span>總計</span>
                      <span>{quoteResult.wholeHouse.total == null ? '無法報價' : `NT$ ${quoteResult.wholeHouse.total.toLocaleString()}`}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            {quoteResult.individual.total != null && quoteResult.wholeHouse.total != null && (
              <p className="text-sm">
                {quoteResult.individual.total < quoteResult.wholeHouse.total ? (
                  <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded">
                    個別租房較划算，省 NT$ {(quoteResult.wholeHouse.total - quoteResult.individual.total).toLocaleString()}
                  </span>
                ) : quoteResult.wholeHouse.total < quoteResult.individual.total ? (
                  <span className="text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded">
                    包棟較划算，省 NT$ {(quoteResult.individual.total - quoteResult.wholeHouse.total).toLocaleString()}
                  </span>
                ) : null}
              </p>
            )}
          </div>
        )}
      </div>

      {/* 促銷方案與連住折扣設定（收合、預設隱藏） */}
      <CollapsibleSection title="促銷方案與連住折扣設定" icon={<Percent className="w-5 h-5 text-gray-600" />} defaultOpen={false}>
        <div className="p-6 border-b bg-amber-50">
          <label className="block text-sm font-medium text-gray-700 mb-1">LINE 對話流程目前套用的促銷方案</label>
          <p className="text-xs text-gray-500 mb-2">
            顧客在 LINE 上聊天訂房會自動套用這裡選定的方案，不用顧客自己提、也不會另外詢問。選「無」就跟現在一樣不打折。
            跟上面「試算報價」選同一個方案時，算出來的金額會完全一致。
          </p>
          <select value={activePromotionId} onChange={(e) => setActivePromotionId(e.target.value)} className="px-3 py-2 border rounded-lg bg-white">
            <option value="">無（不套用促銷）</option>
            {promotions.map((p) => (
              <option key={p.id} value={p.id}>{p.name}（{p.discount_percent}%）</option>
            ))}
          </select>
        </div>

        <div className="p-6 border-b">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm font-medium text-gray-700">促銷方案清單（名稱 + 折扣%，只套用在第一晚）</p>
            <button onClick={addPromotion} className="flex items-center gap-1 bg-gray-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-800">
              <Plus className="w-4 h-4" /> 新增方案
            </button>
          </div>
          <div className="space-y-2">
            {promotions.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <input value={p.name} onChange={(e) => updatePromotion(p.id, 'name', e.target.value)} className="flex-1 px-2 py-1 border rounded" placeholder="促銷方案名稱" />
                <input type="number" value={p.discount_percent} onChange={(e) => updatePromotion(p.id, 'discount_percent', Number(e.target.value))} className="w-20 px-2 py-1 border rounded" />
                <span className="text-xs text-gray-400">% 折扣</span>
                <button onClick={() => deletePromotion(p.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            {promotions.length === 0 && <p className="text-sm text-gray-400">尚未設定促銷方案</p>}
          </div>
        </div>

        <div className="p-6">
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
      </CollapsibleSection>

      {/* 房型與定價（收合、預設隱藏） */}
      <CollapsibleSection
        title="房型與定價"
        icon={<Home className="w-5 h-5 text-green-600" />}
        headerExtra={
          <Button onClick={addRoomType} icon={<Plus className="w-4 h-4" />}>新增房型</Button>
        }
      >
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
      </CollapsibleSection>

      {/* 包棟方案與定價（收合、預設隱藏） */}
      <CollapsibleSection
        title="包棟方案與定價"
        icon={<Users className="w-5 h-5 text-purple-600" />}
        headerExtra={
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer whitespace-nowrap">
            啟用包棟方案
            <input
              type="checkbox"
              checked={wholeHouseEnabled}
              onChange={(e) => setWholeHouseEnabled(e.target.checked)}
              onClick={(e) => e.stopPropagation()}
              className="w-4 h-4"
            />
          </label>
        }
      >
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
                          <input value={r.rule_label} onChange={(e) => updateExtraRule(r.id, 'rule_label', e.target.value)} className="w-32 px-2 py-1 border rounded" placeholder="不加床、不開房" />
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
                <p className="text-xs text-gray-400 mb-3">
                  資料改了會自動重算，不用理解演算法，直接看數字對不對；「與個別租房比較」是自動算出來的省多少錢。
                  人數卡在兩個級距中間時（例如 11、13、15 人）會多顯示「開房」（直接跳去用更大級距的整組價格）跟「不開房」（維持較小級距、超額用加人規則計算）兩種價格。
                </p>
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
                            const { baseTotal, upgradePrice, recommendation } = computeMatrixCell(h, tier);
                            return (
                              <td key={tier} className="py-2 px-3">
                                {baseTotal == null && upgradePrice == null ? (
                                  <span className="text-gray-300">—</span>
                                ) : (
                                  <div className="space-y-1">
                                    {baseTotal != null && (
                                      <div>
                                        <span className="text-xs text-gray-400">不開房 </span>
                                        NT$ {baseTotal.toLocaleString()}
                                        {recommendation.recommended === 'wholeHouse' && recommendation.savings ? (
                                          <span className="inline-block ml-1 text-xs bg-green-50 text-green-700 px-2 py-0.5 rounded">
                                            省 NT$ {recommendation.savings.toLocaleString()}
                                          </span>
                                        ) : null}
                                      </div>
                                    )}
                                    {upgradePrice != null && (
                                      <div className="text-gray-600">
                                        <span className="text-xs text-gray-400">開房 </span>
                                        NT$ {upgradePrice.toLocaleString()}
                                      </div>
                                    )}
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
      </CollapsibleSection>

      {/* 旺季／連假日期區間（收合、預設隱藏） */}
      <CollapsibleSection
        title="旺季／連假日期區間"
        description="完全由這裡新增/編輯/刪除（優先順序：旺季 > 連假 > 一般日期依星期幾判斷）。"
        defaultOpen={false}
      >
        <div className="p-6 border-b">
          <label className="block text-xs text-gray-500 mb-1">旺季期間的平日（日~四）要套用哪種價格</label>
          <select value={peakSeasonWeekdayTier} onChange={(e) => setPeakSeasonWeekdayTier(e.target.value as 'peak' | 'weekday')} className="px-3 py-2 border rounded-lg bg-white">
            <option value="peak">旺季價（預設，不分平假日一律旺季價）</option>
            <option value="weekday">平日價（旺季期間的平日改用平日價，小假日仍是旺季價）</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">同時套用在個別租房與包棟的定價判斷。</p>
        </div>

        <div className="p-6 border-b">
          <label className="block text-xs text-gray-500 mb-1">匯入年份（西元），下面兩個匯入按鈕共用這個年份</label>
          <input
            type="number"
            value={importYearInput}
            onChange={(e) => setImportYearInput(e.target.value)}
            className="w-28 px-3 py-2 border rounded-lg"
            placeholder="2027"
          />
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              onClick={importHolidayCalendar}
              disabled={importingHolidays}
              className="flex items-center gap-1 bg-gray-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800 disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {importingHolidays ? '匯入中...' : '匯入國家連假行事曆'}
            </button>
            <button
              onClick={importPeakSeasonDates}
              className="flex items-center gap-1 bg-gray-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-800"
            >
              <Download className="w-4 h-4" />
              匯入旺季日期（07/01～08/31）
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            連假資料來源：政府行政機關辦公日曆表（依規定每年 6/30 前會公告次年行事曆，特殊情形延到 8/31 前）。只會匯入有名稱的國定假日／補假區間，純週末六日不會匯入。
            旺季固定匯入該年 07/01～08/31 一段區間，兩者都會自動略過已存在的區間，不會重複新增；匯入後記得按最上面「儲存變更」才會真正寫入資料庫。
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
      </CollapsibleSection>
    </div>
  );
}

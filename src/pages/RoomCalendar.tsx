import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { CalendarDays, ChevronLeft, ChevronRight, Save, Plus, Trash2, Download } from 'lucide-react';
import { PageHeader, Button, Modal, StatusBadge } from '../components/ui';
import { OCCUPYING_STATUSES, bookingStatusLabel } from '../lib/bookingStatus';

type CellInfo = { status: string; guestName: string; bookingId: string };

// 行事曆用實心色塊呈現，跟 StatusBadge 的淺色徽章不同視覺語言，這裡單獨定義。
const STATUS_COLOR: Record<string, string> = {
  awaiting_deposit: 'bg-yellow-400',
  reserved: 'bg-purple-500',
  awaiting_balance: 'bg-orange-500',
  confirmed: 'bg-green-500',
  pending_manual_conflict: 'bg-red-500',
};

const CALENDAR_STATUSES = [...OCCUPYING_STATUSES]; // awaiting_deposit/reserved/awaiting_balance/confirmed/pending_manual_conflict

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toIso(d.getFullYear(), d.getMonth(), d.getDate());
}

function newId(): string {
  return crypto.randomUUID();
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export default function RoomCalendar() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [wholeHouseByDate, setWholeHouseByDate] = useState<Record<string, CellInfo>>({});
  const [roomOccupancy, setRoomOccupancy] = useState<Record<string, Record<string, CellInfo>>>({});
  const [unassignedPending, setUnassignedPending] = useState<any[]>([]);
  const [monthBookings, setMonthBookings] = useState<any[]>([]); // 當月所有訂單原始資料，點日期查當天訂單用
  const [loading, setLoading] = useState(true);

  // 點日期查當天訂單
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // ---------------- 旺季／連假日期區間（從「房型與報價」搬過來，這裡才是「這是不是特殊日子」的房況資訊，
  // 不是報價規則本身；報價頁還是會讀這裡設定的資料去算 tier 價格）----------------
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [peakSeasonWeekdayTier, setPeakSeasonWeekdayTier] = useState<'peak' | 'weekday'>('peak');
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);
  const [newRange, setNewRange] = useState({ range_type: '旺季', start_date: '', end_date: '', label: '' });
  const [importYearInput, setImportYearInput] = useState(String(new Date().getFullYear()));
  const [importingHolidays, setImportingHolidays] = useState(false);
  const [savingRanges, setSavingRanges] = useState(false);

  useEffect(() => {
    fetchMonthData();
  }, [year, month]);

  useEffect(() => {
    fetchDateRangeSettings();
  }, []);

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthStartIso = toIso(year, month, 1);
  const monthEndIso = toIso(year, month, daysInMonth);

  const fetchMonthData = async () => {
    setLoading(true);
    try {
      const { data: rt } = await supabase.from('room_types').select('*').eq('is_active', true).eq('type', '房間').order('display_order');
      setRoomTypes(rt || []);

      const { data: bookings } = await supabase
        .from('bookings')
        .select('id, name, nickname, whole_house, status, checkin_date, checkout_date, room_type_label, total_amount')
        .in('status', [...CALENDAR_STATUSES, 'quoted'])
        .lte('checkin_date', monthEndIso)
        .gt('checkout_date', monthStartIso);

      setMonthBookings(bookings || []);

      const wholeHouseMap: Record<string, CellInfo> = {};
      const pendingList: any[] = [];
      const individualBookings = (bookings || []).filter((b: any) => !b.whole_house);

      for (const b of bookings || []) {
        if (!b.checkin_date || !b.checkout_date) continue;
        const guestName = b.name || b.nickname || '未取得';
        if (b.whole_house) {
          let cursor = b.checkin_date > monthStartIso ? b.checkin_date : monthStartIso;
          const end = b.checkout_date < addDays(monthEndIso, 1) ? b.checkout_date : addDays(monthEndIso, 1);
          while (cursor < end) {
            wholeHouseMap[cursor] = { status: b.status, guestName, bookingId: b.id };
            cursor = addDays(cursor, 1);
          }
        } else if (b.status === 'quoted') {
          pendingList.push(b);
        }
      }
      setWholeHouseByDate(wholeHouseMap);
      setUnassignedPending(pendingList);

      const individualIds = individualBookings.map((b: any) => b.id);
      const bookingById: Record<string, any> = Object.fromEntries((bookings || []).map((b: any) => [b.id, b]));
      const occupancy: Record<string, Record<string, CellInfo>> = {};
      if (individualIds.length) {
        const { data: roomNights } = await supabase
          .from('booking_room_nights')
          .select('*')
          .in('booking_id', individualIds)
          .gte('night_date', monthStartIso)
          .lte('night_date', monthEndIso);
        for (const rn of roomNights || []) {
          const b = bookingById[rn.booking_id];
          if (!b) continue;
          if (!occupancy[rn.room_type_id]) occupancy[rn.room_type_id] = {};
          occupancy[rn.room_type_id][rn.night_date] = { status: b.status, guestName: b.name || b.nickname || '未取得', bookingId: b.id };
        }
      }
      setRoomOccupancy(occupancy);
    } finally {
      setLoading(false);
    }
  };

  const fetchDateRangeSettings = async () => {
    const [{ data: st }, { data: dr }] = await Promise.all([
      supabase.from('settings').select('id, peak_season_weekday_tier').single(),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
    ]);
    setSettingsId(st?.id || null);
    setPeakSeasonWeekdayTier(st?.peak_season_weekday_tier ?? 'peak');
    setDateRanges(dr || []);
    setPendingDeletes([]);
  };

  const queueDelete = (table: string, id: string) => setPendingDeletes((prev) => [...prev, { table, id }]);

  const saveDateRangeSettings = async () => {
    setSavingRanges(true);
    try {
      if (settingsId) {
        await supabase.from('settings').update({ peak_season_weekday_tier: peakSeasonWeekdayTier }).eq('id', settingsId);
      }
      if (dateRanges.length) await supabase.from('booking_date_ranges').upsert(dateRanges);
      for (const del of pendingDeletes) {
        await supabase.from(del.table).delete().eq('id', del.id);
      }
      await fetchDateRangeSettings();
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSavingRanges(false);
    }
  };

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
    const yr = Number(importYearInput);
    if (!yr || yr < 2000 || yr > 2100) {
      alert('請輸入有效的西元年份，例如 2027');
      return;
    }
    setImportingHolidays(true);
    try {
      const res = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${yr}.json`);
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
    const yr = Number(importYearInput);
    if (!yr || yr < 2000 || yr > 2100) {
      alert('請輸入有效的西元年份，例如 2027');
      return;
    }
    const start = `${yr}-07-01`;
    const end = `${yr}-08-31`;
    if (dateRanges.some((d) => d.range_type === '旺季' && d.start_date === start && d.end_date === end)) {
      alert(`${yr} 年 07/01～08/31 的旺季區間已經存在，未重複新增。`);
      return;
    }
    setDateRanges(
      [...dateRanges, { id: newId(), range_type: '旺季', start_date: start, end_date: end, label: `${yr}年暑假旺季` }].sort((a, b) =>
        a.start_date.localeCompare(b.start_date)
      )
    );
    alert(`已新增 ${yr}/07/01～${yr}/08/31 旺季區間，記得按「儲存變更」才會真正寫入資料庫。`);
  };

  // 這個日期落在哪個「旺季」或「連假」區間，回傳命中的那幾筆（可能同時有多筆重疊，例如手動加的跟匯入的重複）。
  const specialRangesForDate = (iso: string) => dateRanges.filter((d) => iso >= d.start_date && iso <= d.end_date);

  const goPrevMonth = () => {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); } else setMonth((m) => m - 1);
  };
  const goNextMonth = () => {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); } else setMonth((m) => m + 1);
  };

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const selectedDayBookings = selectedDay
    ? monthBookings.filter((b) => b.checkin_date <= selectedDay && b.checkout_date > selectedDay)
    : [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        icon={<CalendarDays className="w-6 h-6 text-green-600" />}
        title="房況/行事曆"
        description="依房型檢視本月訂房狀況，顏色代表訂單狀態；日期上方的小標籤代表旺季/連假。點日期數字可以查當天有哪些訂單。"
        action={
          <div className="flex items-center gap-2">
            <button onClick={goPrevMonth} className="p-2 border rounded-lg hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button>
            <span className="font-semibold text-gray-700 w-24 text-center">{year}年{month + 1}月</span>
            <button onClick={goNextMonth} className="p-2 border rounded-lg hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        {CALENDAR_STATUSES.map((status) => (
          <span key={status} className="flex items-center gap-1.5">
            <span className={`w-3 h-3 rounded ${STATUS_COLOR[status]}`} />
            {bookingStatusLabel(status)}
          </span>
        ))}
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-orange-100 border border-orange-300" />旺季</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 border border-red-300" />連假</span>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-gray-50 border-b border-r px-3 py-2 text-left text-gray-600 w-28 z-10">房型</th>
                {days.map((d) => {
                  const weekday = new Date(year, month, d).getDay();
                  const iso = toIso(year, month, d);
                  const special = specialRangesForDate(iso);
                  const isPeak = special.some((s) => s.range_type === '旺季');
                  const isHoliday = special.some((s) => s.range_type === '連假');
                  const specialTitle = special.map((s) => `${s.range_type}${s.label ? `：${s.label}` : ''}`).join('、');
                  return (
                    <th key={d} className="border-b px-1.5 py-2 text-center font-normal w-9">
                      <button
                        onClick={() => setSelectedDay(iso)}
                        title={specialTitle || undefined}
                        className={`w-full rounded hover:bg-green-50 ${weekday === 0 || weekday === 6 ? 'text-red-400' : 'text-gray-500'}`}
                      >
                        <div>{d}</div>
                        <div className="text-[10px]">{WEEKDAY_LABELS[weekday]}</div>
                        <div className="h-1.5 flex justify-center gap-0.5 mt-0.5">
                          {isPeak && <span className="w-1.5 h-1.5 rounded-full bg-orange-400" />}
                          {isHoliday && <span className="w-1.5 h-1.5 rounded-full bg-red-400" />}
                        </div>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              <tr className="bg-purple-50/40">
                <td className="sticky left-0 bg-purple-50 border-r px-3 py-2 font-medium text-purple-700 z-10">包棟</td>
                {days.map((d) => {
                  const iso = toIso(year, month, d);
                  const info = wholeHouseByDate[iso];
                  return (
                    <td key={d} className="border-b border-l p-0.5 text-center">
                      {info ? <div className={`h-6 rounded ${STATUS_COLOR[info.status] || 'bg-gray-300'}`} title={`${info.guestName}（${bookingStatusLabel(info.status)}）`} /> : <div className="h-6" />}
                    </td>
                  );
                })}
              </tr>
              {loading ? (
                <tr><td colSpan={daysInMonth + 1} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : roomTypes.length === 0 ? (
                <tr><td colSpan={daysInMonth + 1} className="py-10 text-center text-gray-400">尚未設定房型</td></tr>
              ) : (
                roomTypes.map((room) => (
                  <tr key={room.id} className="hover:bg-gray-50">
                    <td className="sticky left-0 bg-white border-r px-3 py-2 font-medium text-gray-700 z-10">{room.name}</td>
                    {days.map((d) => {
                      const iso = toIso(year, month, d);
                      const info = roomOccupancy[room.id]?.[iso];
                      const blockedByWholeHouse = !!wholeHouseByDate[iso];
                      return (
                        <td key={d} className="border-b border-l p-0.5 text-center">
                          {info ? (
                            <div className={`h-6 rounded ${STATUS_COLOR[info.status] || 'bg-gray-300'}`} title={`${info.guestName}（${bookingStatusLabel(info.status)}）`} />
                          ) : blockedByWholeHouse ? (
                            <div className="h-6 rounded bg-purple-100" title="包棟佔用" />
                          ) : (
                            <div className="h-6" />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {unassignedPending.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-bold text-gray-800 mb-1">本月已報價訂單（尚未鎖定房型）</h3>
          <p className="text-xs text-gray-400 mb-3">個別租房要等顧客確認訂房、進入「待預定」以後才會鎖定實際房型，這裡先列出還在等待客戶回覆、月曆上暫時看不到的訂單。</p>
          <div className="space-y-1 text-sm text-gray-600">
            {unassignedPending.map((b) => (
              <div key={b.id}>・{b.name || b.nickname || '未取得'}（{String(b.checkin_date).replace(/-/g, '/')} ~ {String(b.checkout_date).replace(/-/g, '/')}）</div>
            ))}
          </div>
        </div>
      )}

      {/* ============== 旺季／連假日期區間（從「房型與報價」搬過來） ============== */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2"><CalendarDays className="w-5 h-5 text-green-600" />旺季／連假日期區間</h3>
            <p className="text-sm text-gray-500 mt-1">完全由這裡新增/編輯/刪除（優先順序：旺季 &gt; 連假 &gt; 一般日期依星期幾判斷），「房型與報價」的定價會依這裡設定的區間套用對應 tier 價格。</p>
          </div>
          <Button onClick={saveDateRangeSettings} loading={savingRanges} icon={<Save className="w-4 h-4" />}>
            {savingRanges ? '儲存中...' : '儲存變更'}
          </Button>
        </div>
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
            旺季固定匯入該年 07/01～08/31 一段區間，兩者都會自動略過已存在的區間，不會重複新增；匯入後記得按「儲存變更」才會真正寫入資料庫。
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

      {/* ============== 點日期查當天訂單 ============== */}
      <Modal
        open={!!selectedDay}
        title={selectedDay ? `${selectedDay.replace(/-/g, '/')} 當天訂單` : ''}
        onClose={() => setSelectedDay(null)}
      >
        {selectedDayBookings.length === 0 ? (
          <p className="text-sm text-gray-400">這天沒有佔用中的訂單。</p>
        ) : (
          <div className="space-y-2">
            {selectedDayBookings.map((b) => (
              <div key={b.id} className="border rounded-lg p-3 text-sm flex justify-between items-center gap-3">
                <div>
                  <p className="font-medium text-gray-800">{b.name || b.nickname || '未取得'}</p>
                  <p className="text-xs text-gray-500">
                    {b.whole_house ? '包棟' : b.room_type_label || '房型未定'}
                    {String(b.checkin_date).replace(/-/g, '/')} ~ {String(b.checkout_date).replace(/-/g, '/')}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {b.total_amount != null && <p className="text-gray-700 mb-1">NT$ {Number(b.total_amount).toLocaleString()}</p>}
                  <StatusBadge status={b.status} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

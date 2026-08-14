import { useEffect, useMemo, useState } from 'react';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './RoomCalendar.css';
import { supabase } from '../lib/supabase';
import { CalendarDays, ChevronLeft, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { PageHeader, Modal, StatusBadge } from '../components/ui';
import { OCCUPYING_STATUSES, bookingStatusLabel } from '../lib/bookingStatus';
import DateRangeSettingsModal from '../components/DateRangeSettingsModal';

// 行事曆事件用實心色塊呈現，跟 StatusBadge 的淺色徽章不同視覺語言，這裡單獨定義（十六進位色碼，
// 直接當 inline style 用，不依賴 Tailwind class 疊在 react-big-calendar 自己的樣式表上時的載入順序）。
const STATUS_HEX: Record<string, string> = {
  awaiting_deposit: '#facc15',
  reserved: '#a855f7',
  awaiting_balance: '#f97316',
  confirmed: '#22c55e',
  pending_manual_conflict: '#ef4444',
};
const QUOTED_HEX = '#9ca3af'; // 已報價但尚未鎖定房型，顏色跟其他狀態區隔用灰色＋虛線框

const CALENDAR_STATUSES = [...OCCUPYING_STATUSES]; // awaiting_deposit/reserved/awaiting_balance/confirmed/pending_manual_conflict

const locales = { 'zh-TW': zhTW };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { locale: zhTW }),
  getDay,
  locales,
});

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toIso(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

interface BookingEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: true;
  status: string;
  quoted: boolean;
  booking: any;
}

export default function RoomCalendar() {
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [events, setEvents] = useState<BookingEvent[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedEvent, setSelectedEvent] = useState<BookingEvent | null>(null);
  const [dateRangeModalOpen, setDateRangeModalOpen] = useState(false);

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();

  useEffect(() => {
    fetchMonthData();
  }, [year, month]);

  useEffect(() => {
    fetchDateRanges();
  }, []);

  const fetchMonthData = async () => {
    setLoading(true);
    try {
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const monthStartIso = toIso(year, month, 1);
      const monthEndIso = toIso(year, month, daysInMonth);

      const { data: bookings } = await supabase
        .from('bookings')
        .select('id, name, nickname, whole_house, status, checkin_date, checkout_date, room_type_label, total_amount')
        .in('status', [...CALENDAR_STATUSES, 'quoted'])
        .lte('checkin_date', monthEndIso)
        .gt('checkout_date', monthStartIso);

      const nextEvents: BookingEvent[] = (bookings || [])
        .filter((b: any) => b.checkin_date && b.checkout_date)
        .map((b: any) => {
          const guestName = b.name || b.nickname || '未取得';
          const roomLabel = b.whole_house ? '包棟' : b.room_type_label || (b.status === 'quoted' ? '未指定房型' : '房型未定');
          return {
            id: b.id,
            title: `${guestName}（${roomLabel}）`,
            start: new Date(`${b.checkin_date}T00:00:00`),
            end: new Date(`${b.checkout_date}T00:00:00`), // 退房日不算住宿夜，跟 react-big-calendar 多日事件「end 不含」的慣例一致
            allDay: true,
            status: b.status,
            quoted: b.status === 'quoted',
            booking: b,
          };
        });
      setEvents(nextEvents);
    } finally {
      setLoading(false);
    }
  };

  const fetchDateRanges = async () => {
    const { data: dr } = await supabase.from('booking_date_ranges').select('*').order('start_date');
    setDateRanges(dr || []);
  };

  // 這個日期落在哪個「旺季」或「連假」區間，回傳命中的那幾筆（可能同時有多筆重疊，例如手動加的跟匯入的重複）。
  const specialRangesForDate = (iso: string) => dateRanges.filter((d) => iso >= d.start_date && iso <= d.end_date);

  const dayPropGetter = useMemo(
    () => (date: Date) => {
      const iso = toIso(date.getFullYear(), date.getMonth(), date.getDate());
      const special = specialRangesForDate(iso);
      if (special.some((s) => s.range_type === '連假')) return { className: 'rbc-day-holiday' };
      if (special.some((s) => s.range_type === '旺季')) return { className: 'rbc-day-peak' };
      return {};
    },
    [dateRanges]
  );

  const eventPropGetter = (event: BookingEvent) => ({
    style: {
      backgroundColor: event.quoted ? QUOTED_HEX : STATUS_HEX[event.status] || '#9ca3af',
      color: '#fff',
      border: event.quoted ? '1px dashed #fff' : 'none',
      opacity: event.quoted ? 0.85 : 1,
    },
  });

  const goPrevMonth = () => setCalendarDate(new Date(year, month - 1, 1));
  const goNextMonth = () => setCalendarDate(new Date(year, month + 1, 1));

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        icon={<CalendarDays className="w-6 h-6 text-green-600" />}
        title="房況/行事曆"
        description="每個色塊是一筆訂單（房客／房型），顏色代表訂單狀態；淺橘／淺紅底色代表旺季／連假。點色塊可以查看該筆訂單詳情。"
        action={
          <div className="flex items-center gap-2">
            <button onClick={goPrevMonth} className="p-2 border rounded-lg hover:bg-gray-50"><ChevronLeft className="w-4 h-4" /></button>
            <span className="font-semibold text-gray-700 w-24 text-center">{year}年{month + 1}月</span>
            <button onClick={goNextMonth} className="p-2 border rounded-lg hover:bg-gray-50"><ChevronRight className="w-4 h-4" /></button>
            <button
              onClick={() => setDateRangeModalOpen(true)}
              className="flex items-center gap-1.5 bg-green-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-green-700 ml-1"
            >
              <SlidersHorizontal className="w-4 h-4" /> 旺季/連假日期設定
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        {CALENDAR_STATUSES.map((status) => (
          <span key={status} className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded" style={{ backgroundColor: STATUS_HEX[status] }} />
            {bookingStatusLabel(status)}
          </span>
        ))}
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-dashed" style={{ backgroundColor: QUOTED_HEX }} />已報價（未鎖房型）</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-orange-100 border border-orange-300" />旺季</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-red-100 border border-red-300" />連假</span>
      </div>

      <div className="room-calendar bg-white rounded-xl shadow-sm border p-3" style={{ height: 720 }}>
        {loading && <div className="text-center text-gray-400 text-sm py-2">載入中...</div>}
        <Calendar
          localizer={localizer}
          culture="zh-TW"
          events={events}
          date={calendarDate}
          onNavigate={setCalendarDate}
          views={[Views.MONTH]}
          view={Views.MONTH}
          toolbar={false}
          popup
          dayPropGetter={dayPropGetter}
          eventPropGetter={eventPropGetter as any}
          onSelectEvent={(event: any) => setSelectedEvent(event)}
          messages={{ noEventsInRange: '這段期間沒有訂單', showMore: (total: number) => `還有 ${total} 筆` }}
          style={{ height: '100%' }}
        />
      </div>

      {/* ============== 點色塊看訂單詳情 ============== */}
      <Modal open={!!selectedEvent} title="訂單詳情" onClose={() => setSelectedEvent(null)}>
        {selectedEvent && (
          <div className="border rounded-lg p-3 text-sm flex justify-between items-center gap-3">
            <div>
              <p className="font-medium text-gray-800">{selectedEvent.booking.name || selectedEvent.booking.nickname || '未取得'}</p>
              <p className="text-xs text-gray-500">
                {selectedEvent.booking.whole_house ? '包棟' : selectedEvent.booking.room_type_label || '房型未定'}
                {'　'}
                {String(selectedEvent.booking.checkin_date).replace(/-/g, '/')} ~ {String(selectedEvent.booking.checkout_date).replace(/-/g, '/')}
              </p>
            </div>
            <div className="text-right shrink-0">
              {selectedEvent.booking.total_amount != null && <p className="text-gray-700 mb-1">NT$ {Number(selectedEvent.booking.total_amount).toLocaleString()}</p>}
              <StatusBadge status={selectedEvent.status} />
            </div>
          </div>
        )}
      </Modal>

      <DateRangeSettingsModal
        open={dateRangeModalOpen}
        onClose={() => setDateRangeModalOpen(false)}
        onSaved={fetchDateRanges}
      />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './RoomCalendar.css';
import { supabase } from '../lib/supabase';
import { Box, Paper, Stack, Typography, IconButton, Button, Tooltip, Chip, Dialog, DialogTitle, DialogContent } from '@mui/material';
import { ChevronLeft, ChevronRight, CalendarDays, SlidersHorizontal, X } from 'lucide-react';
import PageHeaderMui from '../components/ui-mui/PageHeaderMui';
import { OCCUPYING_STATUSES, bookingStatusLabel } from '../lib/bookingStatus';
import DateRangeSettingsModal from '../components/DateRangeSettingsModal';

// 行事曆事件用實心色塊呈現，這裡單獨定義（十六進位色碼，直接當 MUI sx/style 用）。
// 跟 bookingStatus.ts 的 badgeClassName 用同一套顏色邏輯（同色系），只是換成十六進位。
const STATUS_HEX: Record<string, string> = {
  awaiting_deposit: '#facc15',
  awaiting_confirmation: '#f59e0b',
  reserved: '#a855f7',
  awaiting_balance: '#f97316',
  awaiting_checkin: '#0ea5e9',
  checked_in: '#14b8a6',
  deposit_processing: '#6366f1',
  completed: '#22c55e',
  pending_manual_conflict: '#ef4444',
};
const INQUIRING_HEX = '#9ca3af'; // 待報價（已算過價但客人還沒決定，尚未鎖定房型），顏色跟其他狀態區隔用灰色＋虛線框

const CALENDAR_STATUSES = [...OCCUPYING_STATUSES];

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
  inquiring: boolean;
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
        // inquiring（待報價）也要撈：quoted 已併入 inquiring，「已算過價但客人還沒決定」
        // 這種有日期、但尚未鎖定房型的訂單，現在就是狀態=inquiring 且有 checkin/checkout_date。
        .in('status', [...CALENDAR_STATUSES, 'inquiring'])
        .lte('checkin_date', monthEndIso)
        .gt('checkout_date', monthStartIso);

      const nextEvents: BookingEvent[] = (bookings || [])
        .filter((b: any) => b.checkin_date && b.checkout_date)
        .map((b: any) => {
          const guestName = b.name || b.nickname || '未取得';
          const roomLabel = b.whole_house ? '包棟' : b.room_type_label || (b.status === 'inquiring' ? '未指定房型' : '房型未定');
          return {
            id: b.id,
            title: `${guestName}（${roomLabel}）`,
            start: new Date(`${b.checkin_date}T00:00:00`),
            end: new Date(`${b.checkout_date}T00:00:00`), // 退房日不算住宿夜，跟 react-big-calendar 多日事件「end 不含」的慣例一致
            allDay: true,
            status: b.status,
            inquiring: b.status === 'inquiring',
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

  const dayPropGetter = (date: Date) => {
    const iso = toIso(date.getFullYear(), date.getMonth(), date.getDate());
    const special = specialRangesForDate(iso);
    if (special.some((s) => s.range_type === '連假')) return { className: 'rbc-day-holiday' };
    if (special.some((s) => s.range_type === '旺季')) return { className: 'rbc-day-peak' };
    return {};
  };

  // 旺季/連假的日期格：日期數字下方加一個小 Chip 標示類型，整格用 Tooltip 包起來，
  // 滑鼠移過去顯示完整說明（例如「連假：端午連假」），一般日期照舊只顯示數字。
  const dateHeaderRenderer = ({ date, label }: { date: Date; label: string }) => {
    const iso = toIso(date.getFullYear(), date.getMonth(), date.getDate());
    const special = specialRangesForDate(iso);
    if (special.length === 0) return <Typography variant="caption">{label}</Typography>;
    const isHoliday = special.some((s) => s.range_type === '連假');
    const tooltipText = special.map((s) => `${s.range_type}${s.label ? `：${s.label}` : ''}`).join('、');
    return (
      <Tooltip title={tooltipText} arrow placement="top">
        <Stack alignItems="center" spacing={0.25} sx={{ cursor: 'help' }}>
          <Typography variant="caption">{label}</Typography>
          <Chip
            label={isHoliday ? '連假' : '旺季'}
            size="small"
            sx={{
              height: 16, fontSize: '0.6rem', px: 0, '& .MuiChip-label': { px: 0.5 },
              bgcolor: isHoliday ? '#fecaca' : '#fed7aa',
              color: isHoliday ? '#991b1b' : '#9a3412',
            }}
          />
        </Stack>
      </Tooltip>
    );
  };

  const eventPropGetter = (event: BookingEvent) => ({
    style: {
      backgroundColor: event.inquiring ? INQUIRING_HEX : STATUS_HEX[event.status] || '#9ca3af',
      color: '#fff',
      border: event.inquiring ? '1px dashed #fff' : 'none',
      opacity: event.inquiring ? 0.85 : 1,
    },
  });

  const goPrevMonth = () => setCalendarDate(new Date(year, month - 1, 1));
  const goNextMonth = () => setCalendarDate(new Date(year, month + 1, 1));

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <PageHeaderMui
        icon={<CalendarDays size={26} color="#16a34a" />}
        title="行事曆"
        description="每個色塊是一筆訂單（房客／房型），顏色代表訂單狀態；旺季／連假日期會有標籤，滑鼠移過去可以看詳細說明。點色塊可以查看該筆訂單詳情。"
        action={
          <Stack direction="row" spacing={1} alignItems="center">
            <IconButton onClick={goPrevMonth} size="small" sx={{ border: '1px solid', borderColor: 'divider' }}><ChevronLeft size={18} /></IconButton>
            <Typography fontWeight={600} sx={{ width: 92, textAlign: 'center' }}>{year}年{month + 1}月</Typography>
            <IconButton onClick={goNextMonth} size="small" sx={{ border: '1px solid', borderColor: 'divider' }}><ChevronRight size={18} /></IconButton>
            <Button variant="contained" startIcon={<SlidersHorizontal size={16} />} onClick={() => setDateRangeModalOpen(true)} sx={{ ml: 1 }}>
              旺季/連假日期設定
            </Button>
          </Stack>
        }
      />

      <Stack direction="row" flexWrap="wrap" gap={2} rowGap={1} alignItems="center">
        {CALENDAR_STATUSES.map((status) => (
          <Stack key={status} direction="row" alignItems="center" spacing={0.75}>
            <Box sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: STATUS_HEX[status] }} />
            <Typography variant="caption" color="text.secondary">{bookingStatusLabel(status)}</Typography>
          </Stack>
        ))}
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <Box sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: INQUIRING_HEX, border: '1px dashed #fff', outline: '1px solid #d1d5db' }} />
          <Typography variant="caption" color="text.secondary">待報價（未鎖房型）</Typography>
        </Stack>
        <Chip label="旺季" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: '#fed7aa', color: '#9a3412' }} />
        <Chip label="連假" size="small" sx={{ height: 20, fontSize: '0.65rem', bgcolor: '#fecaca', color: '#991b1b' }} />
      </Stack>

      <Paper variant="outlined" className="room-calendar" sx={{ p: 1.5, height: 720 }}>
        {loading && <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 0.5 }}>載入中...</Typography>}
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
          components={{ month: { dateHeader: dateHeaderRenderer as any } }}
          onSelectEvent={(event: any) => setSelectedEvent(event)}
          messages={{ noEventsInRange: '這段期間沒有訂單', showMore: (total: number) => `還有 ${total} 筆` }}
          style={{ height: '100%' }}
        />
      </Paper>

      {/* ============== 點色塊看訂單詳情 ============== */}
      <Dialog open={!!selectedEvent} onClose={() => setSelectedEvent(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          訂單詳情
          <IconButton size="small" onClick={() => setSelectedEvent(null)}><X size={18} /></IconButton>
        </DialogTitle>
        <DialogContent sx={{ pb: 3 }}>
          {selectedEvent && (
            <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
              <Box>
                <Typography fontWeight={600}>{selectedEvent.booking.name || selectedEvent.booking.nickname || '未取得'}</Typography>
                <Typography variant="caption" color="text.secondary" component="div">
                  {selectedEvent.booking.whole_house ? '包棟' : selectedEvent.booking.room_type_label || '房型未定'}
                  {'　'}
                  {String(selectedEvent.booking.checkin_date).replace(/-/g, '/')} ~ {String(selectedEvent.booking.checkout_date).replace(/-/g, '/')}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                {selectedEvent.booking.total_amount != null && (
                  <Typography variant="body2" sx={{ mb: 0.5 }}>NT$ {Number(selectedEvent.booking.total_amount).toLocaleString()}</Typography>
                )}
                <Chip
                  label={bookingStatusLabel(selectedEvent.status)}
                  size="small"
                  sx={{ bgcolor: selectedEvent.inquiring ? INQUIRING_HEX : STATUS_HEX[selectedEvent.status] || '#9ca3af', color: '#fff' }}
                />
              </Box>
            </Stack>
          )}
        </DialogContent>
      </Dialog>

      <DateRangeSettingsModal
        open={dateRangeModalOpen}
        onClose={() => setDateRangeModalOpen(false)}
        onSaved={fetchDateRanges}
      />
    </Box>
  );
}

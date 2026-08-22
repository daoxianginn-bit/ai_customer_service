import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { zhTW } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './RoomCalendar.css';
import { supabase } from '../lib/supabase';
import { Box, Paper, Stack, Typography, IconButton, Button, Tooltip, Chip, Dialog, DialogTitle, DialogContent, Alert, CircularProgress } from '@mui/material';
import { ChevronLeft, ChevronRight, CalendarDays, SlidersHorizontal, X, RefreshCw, Eye } from 'lucide-react';
import PageHeaderMui from '../components/ui-mui/PageHeaderMui';
import { OCCUPYING_STATUSES, UNRESERVED_WITH_DATES_STATUSES, bookingStatusLabel } from '../lib/bookingStatus';
import DateRangeSettingsModal from '../components/DateRangeSettingsModal';
import { OtaChannel, otaPlatformLabel, otaChannelExportUrl } from '../lib/otaChannels';
import { parseIcsEvents } from '../lib/icsParser';

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
const UNRESERVED_HEX = '#9ca3af'; // 報價階段（待報價／待預定：已算過價但客人還沒回「是」，尚未鎖定房間），顏色跟其他狀態區隔用灰色＋虛線框

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
  /** 報價階段（待報價／待預定）：有日期但房間還沒鎖定，行事曆上用灰色虛線框跟正式訂單區隔 */
  unreserved: boolean;
  booking: any;
}

export default function RoomCalendar() {
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [events, setEvents] = useState<BookingEvent[]>([]);
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedEvent, setSelectedEvent] = useState<BookingEvent | null>(null);
  const [dateRangeModalOpen, setDateRangeModalOpen] = useState(false);

  // 手動整合第三方：對應「排程管理」裡 task_type = sync_calendars 的那筆排程，直接借用它
  // 現成的「立即執行」邏輯，不用另外做一套同步流程——這樣兩邊行為（含衝突偵測、Google
  // 行事曆同步）永遠一致，不會有兩份邏輯之後跑掉的風險。
  const [syncTaskId, setSyncTaskId] = useState<string | null>(null);
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; text: string } | null>(null);

  // 預覽匯出行事曆：選一個 OTA 頻道，直接抓它對外公開的 ICS 網址來解析顯示——
  // 跟平台實際抓到的內容保證一致，因為就是同一份（calendar-feed.ts）。
  const [previewOpen, setPreviewOpen] = useState(false);
  const [otaChannelList, setOtaChannelList] = useState<OtaChannel[]>([]);
  const [previewChannelId, setPreviewChannelId] = useState<string | null>(null);
  const [previewEvents, setPreviewEvents] = useState<{ id: string; title: string; start: Date; end: Date; allDay: true }[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();

  useEffect(() => {
    fetchMonthData();
  }, [year, month]);

  useEffect(() => {
    fetchDateRanges();
    fetchSyncTask();
    fetchOtaChannels();
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
        // 報價階段（待報價／待預定）的訂單也要撈：這些有日期、但還沒鎖定房間，
        // 管理員仍然需要看到「有人在問這幾天」，只是要跟真正鎖房的訂單區隔開來顯示。
        .in('status', [...CALENDAR_STATUSES, ...UNRESERVED_WITH_DATES_STATUSES])
        .lte('checkin_date', monthEndIso)
        .gt('checkout_date', monthStartIso);

      const nextEvents: BookingEvent[] = (bookings || [])
        .filter((b: any) => b.checkin_date && b.checkout_date)
        .map((b: any) => {
          const guestName = b.name || b.nickname || '未取得';
          const unreserved = UNRESERVED_WITH_DATES_STATUSES.includes(b.status);
          const roomLabel = b.whole_house ? '包棟' : b.room_type_label || (unreserved ? '未指定房型' : '房型未定');
          return {
            id: b.id,
            title: `${guestName}（${roomLabel}）`,
            start: new Date(`${b.checkin_date}T00:00:00`),
            end: new Date(`${b.checkout_date}T00:00:00`), // 退房日不算住宿夜，跟 react-big-calendar 多日事件「end 不含」的慣例一致
            allDay: true,
            status: b.status,
            unreserved,
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

  const fetchSyncTask = async () => {
    const { data } = await supabase.from('scheduled_tasks').select('id').eq('task_type', 'sync_calendars').limit(1).maybeSingle();
    setSyncTaskId(data?.id || null);
  };

  const fetchOtaChannels = async () => {
    const { data } = await supabase.from('ota_channels').select('*').eq('is_active', true).order('display_order');
    setOtaChannelList((data || []) as OtaChannel[]);
  };

  // 借用「排程管理」的立即執行邏輯：POST taskId 給 scheduled-tasks-run，完成後把摘要顯示出來，
  // 讓管理員不用跳頁去排程管理也能知道這次同步有沒有成功、抓到幾筆。
  const runSyncNow = async () => {
    if (!syncTaskId) return;
    setSyncRunning(true);
    setSyncResult(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch('/.netlify/functions/scheduled-tasks-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ taskId: syncTaskId }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || '執行失敗');
      setSyncResult({ ok: true, text: result.summary || '整合完成' });
      fetchMonthData();
    } catch (e: any) {
      setSyncResult({ ok: false, text: `整合失敗：${e.message}` });
    } finally {
      setSyncRunning(false);
    }
  };

  const openPreview = () => {
    setPreviewOpen(true);
    setPreviewError('');
    if (!previewChannelId && otaChannelList.length) {
      selectPreviewChannel(otaChannelList[0].id);
    } else if (previewChannelId) {
      selectPreviewChannel(previewChannelId);
    }
  };

  // 直接抓頻道對外公開的匯出網址（跟平台實際訂閱的是同一份），解析出來的事件本來就不含
  // 房客姓名等個資（見 calendar-feed.ts 的隱私限制），這裡忠實呈現，不額外補資料。
  const selectPreviewChannel = async (channelId: string) => {
    setPreviewChannelId(channelId);
    const channel = otaChannelList.find((c) => c.id === channelId);
    if (!channel) return;
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const url = otaChannelExportUrl(window.location.origin, channel.export_token);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const icsText = await res.text();
      const parsed = parseIcsEvents(icsText);
      setPreviewEvents(
        parsed.map((ev) => ({
          id: ev.uid,
          title: '已預訂 Reserved',
          start: new Date(`${ev.startIso}T00:00:00`),
          end: new Date(`${ev.endIso}T00:00:00`),
          allDay: true,
        }))
      );
    } catch (e: any) {
      setPreviewError(`讀取失敗：${e.message}`);
      setPreviewEvents([]);
    } finally {
      setPreviewLoading(false);
    }
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
      backgroundColor: event.unreserved ? UNRESERVED_HEX : STATUS_HEX[event.status] || '#9ca3af',
      color: '#fff',
      border: event.unreserved ? '1px dashed #fff' : 'none',
      opacity: event.unreserved ? 0.85 : 1,
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
            <Tooltip title={syncTaskId ? '手動抓取第三方平台行事曆、同步進系統並推播到 Google 行事曆' : '請先到「排程管理」新增一筆「第三方平台 iCal 同步」排程'}>
              <span>
                <Button
                  variant="outlined"
                  startIcon={syncRunning ? <CircularProgress size={14} /> : <RefreshCw size={16} />}
                  onClick={runSyncNow}
                  disabled={!syncTaskId || syncRunning}
                >
                  {syncRunning ? '整合中...' : '手動整合第三方'}
                </Button>
              </span>
            </Tooltip>
            <Button variant="outlined" startIcon={<Eye size={16} />} onClick={openPreview}>
              預覽匯出行事曆
            </Button>
          </Stack>
        }
      />

      {syncResult && (
        <Alert severity={syncResult.ok ? 'success' : 'error'} onClose={() => setSyncResult(null)}>
          {syncResult.text}
        </Alert>
      )}

      <Stack direction="row" flexWrap="wrap" gap={2} rowGap={1} alignItems="center">
        {CALENDAR_STATUSES.map((status) => (
          <Stack key={status} direction="row" alignItems="center" spacing={0.75}>
            <Box sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: STATUS_HEX[status] }} />
            <Typography variant="caption" color="text.secondary">{bookingStatusLabel(status)}</Typography>
          </Stack>
        ))}
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <Box sx={{ width: 12, height: 12, borderRadius: 0.5, bgcolor: UNRESERVED_HEX, border: '1px dashed #fff', outline: '1px solid #d1d5db' }} />
          <Typography variant="caption" color="text.secondary">報價中（未鎖房間）</Typography>
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
                  sx={{ bgcolor: selectedEvent.unreserved ? UNRESERVED_HEX : STATUS_HEX[selectedEvent.status] || '#9ca3af', color: '#fff' }}
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

      {/* ============== 預覽匯出行事曆：跟平台實際訂閱到的內容一致（同一份 ICS 網址） ============== */}
      <Dialog open={previewOpen} onClose={() => setPreviewOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          預覽匯出行事曆
          <IconButton size="small" onClick={() => setPreviewOpen(false)}><X size={18} /></IconButton>
        </DialogTitle>
        <DialogContent sx={{ pb: 3 }}>
          {otaChannelList.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              還沒有啟用中的第三方平台頻道，請先到「OTA 頻道管理」新增。
            </Typography>
          ) : (
            <Stack spacing={2}>
              <Stack direction="row" flexWrap="wrap" gap={1}>
                {otaChannelList.map((c) => (
                  <Chip
                    key={c.id}
                    label={`${otaPlatformLabel(c.platform)}｜${c.name}`}
                    onClick={() => selectPreviewChannel(c.id)}
                    color={previewChannelId === c.id ? 'success' : 'default'}
                    variant={previewChannelId === c.id ? 'filled' : 'outlined'}
                  />
                ))}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                這是這個頻道實際對外公開的行事曆內容（平台訂閱到的就是這一份），基於隱私考量不含房客姓名／訂單編號。
              </Typography>
              {previewError && <Alert severity="error">{previewError}</Alert>}
              {previewLoading ? (
                <Box sx={{ py: 6, textAlign: 'center' }}><CircularProgress size={24} /></Box>
              ) : (
                <Paper variant="outlined" sx={{ height: 480, p: 1 }}>
                  <Calendar
                    localizer={localizer}
                    culture="zh-TW"
                    events={previewEvents}
                    views={[Views.MONTH]}
                    view={Views.MONTH}
                    toolbar
                    popup
                    eventPropGetter={() => ({ style: { backgroundColor: '#16a34a', color: '#fff', border: 'none' } })}
                    messages={{ noEventsInRange: '這段期間沒有已預訂日期', showMore: (total: number) => `還有 ${total} 筆` }}
                    style={{ height: '100%' }}
                  />
                </Paper>
              )}
            </Stack>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}

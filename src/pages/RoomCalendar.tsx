import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '../components/ui';
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

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export default function RoomCalendar() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0-indexed

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [wholeHouseByDate, setWholeHouseByDate] = useState<Record<string, CellInfo>>({});
  const [roomOccupancy, setRoomOccupancy] = useState<Record<string, Record<string, CellInfo>>>({});
  const [unassignedPending, setUnassignedPending] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMonthData();
  }, [year, month]);

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
        .select('id, name, nickname, whole_house, status, checkin_date, checkout_date')
        .in('status', [...CALENDAR_STATUSES, 'quoted'])
        .lte('checkin_date', monthEndIso)
        .gt('checkout_date', monthStartIso);

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

  const goPrevMonth = () => {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); } else setMonth((m) => m - 1);
  };
  const goNextMonth = () => {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); } else setMonth((m) => m + 1);
  };

  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        icon={<CalendarDays className="w-6 h-6 text-green-600" />}
        title="房況/行事曆"
        description="依房型檢視本月訂房狀況，顏色代表訂單狀態。"
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
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="border-collapse text-xs">
            <thead>
              <tr>
                <th className="sticky left-0 bg-gray-50 border-b border-r px-3 py-2 text-left text-gray-600 w-28 z-10">房型</th>
                {days.map((d) => {
                  const weekday = new Date(year, month, d).getDay();
                  return (
                    <th key={d} className={`border-b px-1.5 py-2 text-center font-normal w-9 ${weekday === 0 || weekday === 6 ? 'text-red-400' : 'text-gray-500'}`}>
                      <div>{d}</div>
                      <div className="text-[10px]">{WEEKDAY_LABELS[weekday]}</div>
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
    </div>
  );
}

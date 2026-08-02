import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toDateStr(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

interface DateRangeCalendarProps {
  startDate: string; // 'YYYY-MM-DD' or ''
  endDate: string; // 'YYYY-MM-DD' or ''
  onChange: (start: string, end: string) => void;
  onRangeComplete?: () => void;
}

/**
 * 單一行事曆選入住/退房日期區間：第一次點選設入住日，第二次點選（需晚於入住日）設退房日並觸發 onRangeComplete；
 * 點到比目前入住日更早（或兩個日期都已選好時再點）就當作重新開始選一組新區間。
 */
export default function DateRangeCalendar({ startDate, endDate, onChange, onRangeComplete }: DateRangeCalendarProps) {
  const initial = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  const [viewYear, setViewYear] = useState(initial.getFullYear());
  const [viewMonth, setViewMonth] = useState(initial.getMonth());

  const now = new Date();
  const todayStr = toDateStr(now.getFullYear(), now.getMonth(), now.getDate());

  const firstDay = new Date(viewYear, viewMonth, 1);
  const startOffset = (firstDay.getDay() + 6) % 7; // 週一為每列第一格
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toDateStr(viewYear, viewMonth, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const goPrevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const goNextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleClick = (dateStr: string) => {
    if (!startDate || (startDate && endDate)) {
      onChange(dateStr, '');
      return;
    }
    if (dateStr <= startDate) {
      onChange(dateStr, '');
      return;
    }
    onChange(startDate, dateStr);
    onRangeComplete?.();
  };

  return (
    <div className="inline-block select-none">
      <div className="flex items-center justify-between mb-2 px-1">
        <button type="button" onClick={goPrevMonth} className="p-1 rounded hover:bg-gray-100 text-gray-500">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="text-sm font-semibold text-gray-800">
          {viewYear}年{viewMonth + 1}月
        </div>
        <button type="button" onClick={goNextMonth} className="p-1 rounded hover:bg-gray-100 text-gray-500">
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-gray-400 mb-1">
        {WEEKDAY_LABELS.map((w) => (
          <div key={w} className="w-9 h-6 flex items-center justify-center">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((dateStr, idx) => {
          if (!dateStr) return <div key={idx} className="w-9 h-9" />;
          const isStart = dateStr === startDate;
          const isEnd = dateStr === endDate;
          const inRange = !!(startDate && endDate && dateStr > startDate && dateStr < endDate);
          const isToday = dateStr === todayStr;
          const dayNum = Number(dateStr.slice(-2));
          const bandClass = isStart || isEnd || inRange ? 'bg-blue-50' : '';
          const roundClass = isStart && !endDate ? 'rounded-full' : isStart ? 'rounded-l-full' : isEnd ? 'rounded-r-full' : '';
          return (
            <div key={idx} className={`w-9 h-9 flex items-center justify-center ${bandClass} ${roundClass}`}>
              <button
                type="button"
                onClick={() => handleClick(dateStr)}
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm transition-colors ${
                  isStart || isEnd
                    ? 'bg-blue-600 text-white font-semibold'
                    : isToday
                    ? 'border border-blue-400 text-blue-600'
                    : 'text-gray-700 hover:bg-gray-200'
                }`}
              >
                {dayNum}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

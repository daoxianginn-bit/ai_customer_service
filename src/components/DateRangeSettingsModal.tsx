import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Download } from 'lucide-react';
import { Modal, Button } from './ui';

function newId(): string {
  return crypto.randomUUID();
}

interface DateRangeSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function DateRangeSettingsModal({ open, onClose, onSaved }: DateRangeSettingsModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [peakSeasonWeekdayTier, setPeakSeasonWeekdayTier] = useState<'peak' | 'weekday'>('peak');
  const [dateRanges, setDateRanges] = useState<any[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);
  const [newRange, setNewRange] = useState({ range_type: '旺季', start_date: '', end_date: '', label: '' });
  const [importYearInput, setImportYearInput] = useState(String(new Date().getFullYear()));
  const [importingHolidays, setImportingHolidays] = useState(false);

  useEffect(() => {
    if (open) fetchAll();
  }, [open]);

  const fetchAll = async () => {
    setLoading(true);
    const [{ data: st }, { data: dr }] = await Promise.all([
      supabase.from('settings').select('id, peak_season_weekday_tier').single(),
      supabase.from('booking_date_ranges').select('*').order('start_date'),
    ]);
    setSettingsId(st?.id || null);
    setPeakSeasonWeekdayTier(st?.peak_season_weekday_tier ?? 'peak');
    setDateRanges(dr || []);
    setPendingDeletes([]);
    setLoading(false);
  };

  const queueDelete = (table: string, id: string) => setPendingDeletes((prev) => [...prev, { table, id }]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (settingsId) {
        await supabase.from('settings').update({ peak_season_weekday_tier: peakSeasonWeekdayTier }).eq('id', settingsId);
      }
      if (dateRanges.length) await supabase.from('booking_date_ranges').upsert(dateRanges);
      for (const del of pendingDeletes) {
        await supabase.from(del.table).delete().eq('id', del.id);
      }
      await fetchAll();
      onSaved();
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
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

  return (
    <Modal open={open} title="旺季/連假日期設定" onClose={onClose} maxWidth="max-w-4xl" footer={<Button onClick={handleSave} loading={saving}>{saving ? '儲存中...' : '儲存變更'}</Button>}>
      {loading ? (
        <div className="py-8 text-center text-gray-400">載入中...</div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-gray-400">優先順序：旺季 &gt; 連假 &gt; 一般日期依星期幾判斷，計價公式會依這裡設定的區間套用對應 tier 的日期加價。</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="border rounded-lg p-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">旺季期間的平日（日~四）要套用哪種價格</label>
              <select value={peakSeasonWeekdayTier} onChange={(e) => setPeakSeasonWeekdayTier(e.target.value as 'peak' | 'weekday')} className="w-full px-3 py-2 border rounded-lg bg-white text-sm">
                <option value="peak">旺季價（預設，不分平假日一律旺季價）</option>
                <option value="weekday">平日價（旺季期間的平日改用平日價，小假日仍是旺季價）</option>
              </select>
            </div>

            <div className="border rounded-lg p-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">匯入年份（西元），下面兩個匯入按鈕共用</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={importYearInput}
                  onChange={(e) => setImportYearInput(e.target.value)}
                  className="w-24 px-3 py-2 border rounded-lg text-sm"
                  placeholder="2027"
                />
                <button
                  onClick={importHolidayCalendar}
                  disabled={importingHolidays}
                  title="匯入國家連假行事曆"
                  className="flex items-center gap-1 bg-gray-700 text-white px-3 py-2 rounded-lg text-xs hover:bg-gray-800 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  {importingHolidays ? '匯入中' : '連假'}
                </button>
                <button
                  onClick={importPeakSeasonDates}
                  title="匯入旺季日期（07/01～08/31）"
                  className="flex items-center gap-1 bg-gray-700 text-white px-3 py-2 rounded-lg text-xs hover:bg-gray-800"
                >
                  <Download className="w-3.5 h-3.5" />
                  旺季
                </button>
              </div>
              <p className="text-[11px] text-gray-400 mt-1">連假來源：政府行政機關辦公日曆表；旺季固定匯入 07/01～08/31，都會自動略過重複區間。</p>
            </div>
          </div>

          <div className="border rounded-lg p-4">
            <p className="text-xs font-medium text-gray-600 mb-2">新增區間</p>
            <div className="flex flex-wrap gap-2 items-end">
              <select value={newRange.range_type} onChange={(e) => setNewRange({ ...newRange, range_type: e.target.value })} className="px-3 py-2 border rounded-lg bg-white text-sm">
                <option value="旺季">旺季</option>
                <option value="連假">連假</option>
              </select>
              <input type="date" value={newRange.start_date} onChange={(e) => setNewRange({ ...newRange, start_date: e.target.value })} className="px-3 py-2 border rounded-lg text-sm" />
              <input type="date" value={newRange.end_date} onChange={(e) => setNewRange({ ...newRange, end_date: e.target.value })} className="px-3 py-2 border rounded-lg text-sm" />
              <input value={newRange.label} onChange={(e) => setNewRange({ ...newRange, label: e.target.value })} className="flex-1 min-w-[120px] px-3 py-2 border rounded-lg text-sm" placeholder="備註，例如：端午連假" />
              <button onClick={addDateRange} className="flex items-center gap-1 bg-green-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-green-700">
                <Plus className="w-4 h-4" /> 新增
              </button>
            </div>
          </div>

          <div className="border rounded-lg overflow-hidden">
            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 border-b sticky top-0">
                  <tr className="text-gray-600">
                    <th className="py-2 px-3">類型</th>
                    <th className="py-2 px-3">起始日期</th>
                    <th className="py-2 px-3">結束日期</th>
                    <th className="py-2 px-3">備註</th>
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {dateRanges.map((d) => (
                    <tr key={d.id}>
                      <td className="p-2">
                        <select value={d.range_type} onChange={(e) => updateDateRange(d.id, 'range_type', e.target.value)} className="px-2 py-1 border rounded bg-white text-sm">
                          <option value="旺季">旺季</option>
                          <option value="連假">連假</option>
                        </select>
                      </td>
                      <td className="p-2">
                        <input type="date" value={d.start_date} onChange={(e) => updateDateRange(d.id, 'start_date', e.target.value)} className="px-2 py-1 border rounded text-sm" />
                      </td>
                      <td className="p-2">
                        <input type="date" value={d.end_date} onChange={(e) => updateDateRange(d.id, 'end_date', e.target.value)} className="px-2 py-1 border rounded text-sm" />
                      </td>
                      <td className="p-2">
                        <input value={d.label} onChange={(e) => updateDateRange(d.id, 'label', e.target.value)} className="w-36 px-2 py-1 border rounded text-sm" placeholder="例如：端午連假" />
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
                      <td colSpan={5} className="py-8 text-center text-gray-400">尚未設定任何日期區間</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

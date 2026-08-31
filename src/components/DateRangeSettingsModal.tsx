import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, IconButton, Button, TextField, MenuItem, Stack, Typography, Paper, Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import { X, Plus, Trash2, Download } from 'lucide-react';

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
      supabase.from('operational_settings').select('id, peak_season_weekday_tier').single(),
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
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        旺季/連假日期設定
        <IconButton size="small" onClick={onClose}><X size={18} /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Typography color="text.secondary" align="center" sx={{ py: 4 }}>載入中...</Typography>
        ) : (
          <Stack spacing={2.5}>
            <Typography variant="caption" color="text.secondary">
              優先順序：旺季 &gt; 連假 &gt; 一般日期依星期幾判斷，計價公式會依這裡設定的區間套用對應 tier 的日期加價。
            </Typography>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>旺季期間的平日（日~四）要套用哪種價格</Typography>
                <TextField
                  select fullWidth size="small"
                  value={peakSeasonWeekdayTier}
                  onChange={(e) => setPeakSeasonWeekdayTier(e.target.value as 'peak' | 'weekday')}
                >
                  <MenuItem value="peak">旺季價（預設，不分平假日一律旺季價）</MenuItem>
                  <MenuItem value="weekday">平日價（旺季期間的平日改用平日價，小假日仍是旺季價）</MenuItem>
                </TextField>
              </Paper>

              <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>匯入年份（西元），下面兩個匯入按鈕共用</Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <TextField
                    type="number" size="small" sx={{ width: 100 }}
                    value={importYearInput}
                    onChange={(e) => setImportYearInput(e.target.value)}
                    placeholder="2027"
                  />
                  <Button size="small" variant="outlined" startIcon={<Download size={14} />} disabled={importingHolidays} onClick={importHolidayCalendar}>
                    {importingHolidays ? '匯入中' : '連假'}
                  </Button>
                  <Button size="small" variant="outlined" startIcon={<Download size={14} />} onClick={importPeakSeasonDates}>
                    旺季
                  </Button>
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                  連假來源：政府行政機關辦公日曆表；旺季固定匯入 07/01～08/31，都會自動略過重複區間。
                </Typography>
              </Paper>
            </Stack>

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>新增區間</Typography>
              <Stack direction="row" flexWrap="wrap" gap={1.5} alignItems="center">
                <TextField select size="small" sx={{ width: 100 }} value={newRange.range_type} onChange={(e) => setNewRange({ ...newRange, range_type: e.target.value })}>
                  <MenuItem value="旺季">旺季</MenuItem>
                  <MenuItem value="連假">連假</MenuItem>
                </TextField>
                <TextField type="date" size="small" value={newRange.start_date} onChange={(e) => setNewRange({ ...newRange, start_date: e.target.value })} InputLabelProps={{ shrink: true }} />
                <TextField type="date" size="small" value={newRange.end_date} onChange={(e) => setNewRange({ ...newRange, end_date: e.target.value })} InputLabelProps={{ shrink: true }} />
                <TextField size="small" sx={{ flex: 1, minWidth: 140 }} value={newRange.label} onChange={(e) => setNewRange({ ...newRange, label: e.target.value })} placeholder="備註，例如：端午連假" />
                <Button variant="contained" size="small" startIcon={<Plus size={16} />} onClick={addDateRange}>新增</Button>
              </Stack>
            </Paper>

            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 280 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>類型</TableCell>
                    <TableCell>起始日期</TableCell>
                    <TableCell>結束日期</TableCell>
                    <TableCell>備註</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {dateRanges.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>
                        <TextField select size="small" variant="standard" value={d.range_type} onChange={(e) => updateDateRange(d.id, 'range_type', e.target.value)}>
                          <MenuItem value="旺季">旺季</MenuItem>
                          <MenuItem value="連假">連假</MenuItem>
                        </TextField>
                      </TableCell>
                      <TableCell><TextField type="date" size="small" variant="standard" value={d.start_date} onChange={(e) => updateDateRange(d.id, 'start_date', e.target.value)} /></TableCell>
                      <TableCell><TextField type="date" size="small" variant="standard" value={d.end_date} onChange={(e) => updateDateRange(d.id, 'end_date', e.target.value)} /></TableCell>
                      <TableCell><TextField size="small" variant="standard" value={d.label} onChange={(e) => updateDateRange(d.id, 'label', e.target.value)} placeholder="例如：端午連假" /></TableCell>
                      <TableCell>
                        <IconButton size="small" color="error" onClick={() => deleteDateRange(d.id)}><Trash2 size={16} /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {dateRanges.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ color: 'text.disabled', py: 3 }}>尚未設定任何日期區間</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleSave} variant="contained" disabled={saving}>{saving ? '儲存中...' : '儲存變更'}</Button>
      </DialogActions>
    </Dialog>
  );
}

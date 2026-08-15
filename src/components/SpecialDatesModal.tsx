import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, IconButton, Button, TextField, Stack, Typography, Paper, Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import { X, Plus, Trash2 } from 'lucide-react';

function newId(): string {
  return crypto.randomUUID();
}

interface SpecialDatesModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function SpecialDatesModal({ open, onClose, onSaved }: SpecialDatesModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [specialPrices, setSpecialPrices] = useState<any[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);
  const [newSpecialPrice, setNewSpecialPrice] = useState({ start_date: '', end_date: '', name: '', occupancy: '', price: '' });

  useEffect(() => {
    if (open) fetchAll();
  }, [open]);

  const fetchAll = async () => {
    setLoading(true);
    const { data } = await supabase.from('special_prices').select('*').order('start_date');
    setSpecialPrices(data || []);
    setPendingDeletes([]);
    setLoading(false);
  };

  const queueDelete = (table: string, id: string) => setPendingDeletes((prev) => [...prev, { table, id }]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (specialPrices.length) await supabase.from('special_prices').upsert(specialPrices);
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

  const addSpecialPrice = () => {
    if (!newSpecialPrice.start_date || !newSpecialPrice.end_date || newSpecialPrice.price === '') {
      alert('請填入起訖日期與金額');
      return;
    }
    setSpecialPrices(
      [
        ...specialPrices,
        {
          id: newId(),
          start_date: newSpecialPrice.start_date,
          end_date: newSpecialPrice.end_date,
          name: newSpecialPrice.name,
          occupancy: newSpecialPrice.occupancy === '' ? null : Number(newSpecialPrice.occupancy),
          price: Number(newSpecialPrice.price),
        },
      ].sort((a, b) => a.start_date.localeCompare(b.start_date))
    );
    setNewSpecialPrice({ start_date: '', end_date: '', name: '', occupancy: '', price: '' });
  };

  const updateSpecialPrice = (id: string, field: string, value: any) => {
    setSpecialPrices(specialPrices.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  };

  const deleteSpecialPrice = (id: string) => {
    setSpecialPrices(specialPrices.filter((s) => s.id !== id));
    queueDelete('special_prices', id);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        特殊日期價格設定
        <IconButton size="small" onClick={onClose}><X size={18} /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Typography color="text.secondary" align="center" sx={{ py: 4 }}>載入中...</Typography>
        ) : (
          <Stack spacing={2.5}>
            <Typography variant="caption" color="text.secondary">
              日期區間命中時直接用這個絕對金額當那一晚的最終基礎價，優先權最高，取代「標準價格＋加開房費＋日期加價」整段計算。
              人數留空＝不分人數都套用；要不要繼續疊加促銷/連住折扣，去「計價公式設定」的促銷方案卡片設定。
            </Typography>

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>新增特殊日期價格</Typography>
              <Stack direction="row" flexWrap="wrap" gap={1.5} alignItems="center">
                <TextField type="date" size="small" label="起始日期" value={newSpecialPrice.start_date} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, start_date: e.target.value })} InputLabelProps={{ shrink: true }} />
                <TextField type="date" size="small" label="結束日期" value={newSpecialPrice.end_date} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, end_date: e.target.value })} InputLabelProps={{ shrink: true }} />
                <TextField size="small" label="名稱" sx={{ width: 130 }} value={newSpecialPrice.name} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, name: e.target.value })} placeholder="例如：跨年" />
                <TextField type="number" size="small" label="人數" sx={{ width: 100 }} value={newSpecialPrice.occupancy} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, occupancy: e.target.value })} placeholder="不限" />
                <TextField type="number" size="small" label="金額" sx={{ width: 110 }} value={newSpecialPrice.price} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, price: e.target.value })} placeholder="30000" />
                <Button variant="contained" size="small" startIcon={<Plus size={16} />} onClick={addSpecialPrice}>新增</Button>
              </Stack>
            </Paper>

            <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 320 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>起始日期</TableCell>
                    <TableCell>結束日期</TableCell>
                    <TableCell>名稱</TableCell>
                    <TableCell>人數</TableCell>
                    <TableCell>金額</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {specialPrices.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell><TextField type="date" size="small" variant="standard" value={s.start_date} onChange={(e) => updateSpecialPrice(s.id, 'start_date', e.target.value)} /></TableCell>
                      <TableCell><TextField type="date" size="small" variant="standard" value={s.end_date} onChange={(e) => updateSpecialPrice(s.id, 'end_date', e.target.value)} /></TableCell>
                      <TableCell><TextField size="small" variant="standard" value={s.name || ''} onChange={(e) => updateSpecialPrice(s.id, 'name', e.target.value)} /></TableCell>
                      <TableCell>
                        <TextField
                          type="number" size="small" variant="standard" sx={{ width: 70 }}
                          value={s.occupancy ?? ''}
                          onChange={(e) => updateSpecialPrice(s.id, 'occupancy', e.target.value === '' ? null : Number(e.target.value))}
                          placeholder="不限"
                        />
                      </TableCell>
                      <TableCell><TextField type="number" size="small" variant="standard" sx={{ width: 90 }} value={s.price} onChange={(e) => updateSpecialPrice(s.id, 'price', Number(e.target.value))} /></TableCell>
                      <TableCell>
                        <IconButton size="small" color="error" onClick={() => deleteSpecialPrice(s.id)}><Trash2 size={16} /></IconButton>
                      </TableCell>
                    </TableRow>
                  ))}
                  {specialPrices.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center" sx={{ color: 'text.disabled', py: 3 }}>尚未設定任何特殊日期價格</TableCell>
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

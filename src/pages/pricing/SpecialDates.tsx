import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Sparkles, Save, Plus, Trash2 } from 'lucide-react';
import { PageHeader, Button } from '../../components/ui';

function newId(): string {
  return crypto.randomUUID();
}

export default function SpecialDates() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [specialPrices, setSpecialPrices] = useState<any[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);
  const [newSpecialPrice, setNewSpecialPrice] = useState({ start_date: '', end_date: '', name: '', occupancy: '', price: '' });

  useEffect(() => {
    fetchAll();
  }, []);

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

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
      <PageHeader
        icon={<Sparkles className="w-6 h-6 text-amber-600" />}
        title="特殊日期價格"
        description="日期區間命中時直接用這個絕對金額當那一晚的最終基礎價，優先權最高，取代「標準價格＋加開房費＋日期加價」整段計算。人數留空＝不分人數都套用；要不要繼續疊加促銷/連住折扣，去「促銷與折扣」頁設定。"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      />

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b bg-gray-50 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">起始日期</label>
            <input type="date" value={newSpecialPrice.start_date} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, start_date: e.target.value })} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">結束日期</label>
            <input type="date" value={newSpecialPrice.end_date} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, end_date: e.target.value })} className="px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">名稱</label>
            <input value={newSpecialPrice.name} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, name: e.target.value })} className="w-32 px-3 py-2 border rounded-lg" placeholder="例如：跨年" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">人數（留空＝不分人數）</label>
            <input type="number" value={newSpecialPrice.occupancy} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, occupancy: e.target.value })} className="w-24 px-3 py-2 border rounded-lg" placeholder="不限" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">金額</label>
            <input type="number" value={newSpecialPrice.price} onChange={(e) => setNewSpecialPrice({ ...newSpecialPrice, price: e.target.value })} className="w-28 px-3 py-2 border rounded-lg" placeholder="30000" />
          </div>
          <button onClick={addSpecialPrice} className="flex items-center gap-1 bg-amber-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-amber-700">
            <Plus className="w-4 h-4" /> 新增
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">起始日期</th>
                <th className="py-3 px-4">結束日期</th>
                <th className="py-3 px-4">名稱</th>
                <th className="py-3 px-4">人數</th>
                <th className="py-3 px-4">金額</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {specialPrices.map((s) => (
                <tr key={s.id}>
                  <td className="p-2"><input type="date" value={s.start_date} onChange={(e) => updateSpecialPrice(s.id, 'start_date', e.target.value)} className="px-2 py-1 border rounded" /></td>
                  <td className="p-2"><input type="date" value={s.end_date} onChange={(e) => updateSpecialPrice(s.id, 'end_date', e.target.value)} className="px-2 py-1 border rounded" /></td>
                  <td className="p-2"><input value={s.name || ''} onChange={(e) => updateSpecialPrice(s.id, 'name', e.target.value)} className="w-28 px-2 py-1 border rounded" /></td>
                  <td className="p-2">
                    <input
                      type="number"
                      value={s.occupancy ?? ''}
                      onChange={(e) => updateSpecialPrice(s.id, 'occupancy', e.target.value === '' ? null : Number(e.target.value))}
                      className="w-20 px-2 py-1 border rounded"
                      placeholder="不限"
                    />
                  </td>
                  <td className="p-2"><input type="number" value={s.price} onChange={(e) => updateSpecialPrice(s.id, 'price', Number(e.target.value))} className="w-28 px-2 py-1 border rounded" /></td>
                  <td className="p-2">
                    <button onClick={() => deleteSpecialPrice(s.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {specialPrices.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-gray-400">尚未設定任何特殊日期價格</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

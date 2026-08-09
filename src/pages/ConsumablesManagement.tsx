import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Package, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { PageHeader, Button, Modal, ConfirmDialog, EmptyState } from '../components/ui';

interface Consumable {
  id: string;
  name: string;
  unit: string;
  stock_quantity: number;
  restock_threshold: number;
  notes: string;
}

interface SpaceOption {
  id: string;
  name: string;
  type: string;
}

const emptyForm = () => ({ name: '', unit: '', stock_quantity: 0, restock_threshold: 0, notes: '', spaceIds: [] as string[] });

export default function ConsumablesManagement() {
  const [rows, setRows] = useState<Consumable[]>([]);
  const [spacesByConsumable, setSpacesByConsumable] = useState<Record<string, string[]>>({});
  const [spaceOptions, setSpaceOptions] = useState<SpaceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<Consumable | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    setQueryError('');
    const [{ data: consumables, error: cErr }, { data: spaces, error: sErr }, { data: links, error: lErr }] = await Promise.all([
      supabase.from('consumables').select('*').order('name'),
      supabase.from('room_types').select('id, name, type').order('display_order'),
      supabase.from('consumable_spaces').select('consumable_id, room_type_id'),
    ]);
    const err = cErr || sErr || lErr;
    if (err) {
      setQueryError(`查詢失敗：${err.message}`);
      setRows([]);
    } else {
      setRows(consumables || []);
      setSpaceOptions(spaces || []);
      const map: Record<string, string[]> = {};
      for (const link of links || []) {
        if (!map[link.consumable_id]) map[link.consumable_id] = [];
        map[link.consumable_id].push(link.room_type_id);
      }
      setSpacesByConsumable(map);
    }
    setLoading(false);
  };

  const spaceNames = (consumableId: string): string => {
    const ids = spacesByConsumable[consumableId] || [];
    return spaceOptions.filter((s) => ids.includes(s.id)).map((s) => s.name).join('、') || '（未指定）';
  };

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (row: Consumable) => {
    setEditingId(row.id);
    setForm({
      name: row.name,
      unit: row.unit || '',
      stock_quantity: row.stock_quantity ?? 0,
      restock_threshold: row.restock_threshold ?? 0,
      notes: row.notes || '',
      spaceIds: spacesByConsumable[row.id] || [],
    });
    setFormError('');
    setShowForm(true);
  };

  const toggleSpace = (id: string) => {
    setForm((prev) => ({
      ...prev,
      spaceIds: prev.spaceIds.includes(id) ? prev.spaceIds.filter((s) => s !== id) : [...prev.spaceIds, id],
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setFormError('請輸入耗材名稱');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        name: form.name.trim(),
        unit: form.unit,
        stock_quantity: Number(form.stock_quantity) || 0,
        restock_threshold: Number(form.restock_threshold) || 0,
        notes: form.notes,
        updated_at: new Date().toISOString(),
      };

      let consumableId = editingId;
      if (consumableId) {
        const { error } = await supabase.from('consumables').update(payload).eq('id', consumableId);
        if (error) throw error;
        await supabase.from('consumable_spaces').delete().eq('consumable_id', consumableId);
      } else {
        const { data, error } = await supabase.from('consumables').insert(payload).select('id').single();
        if (error) throw error;
        consumableId = data.id;
      }

      if (form.spaceIds.length) {
        const { error: linkError } = await supabase
          .from('consumable_spaces')
          .insert(form.spaceIds.map((roomTypeId) => ({ consumable_id: consumableId, room_type_id: roomTypeId })));
        if (linkError) throw linkError;
      }

      setShowForm(false);
      await fetchAll();
    } catch (e: any) {
      setFormError(`儲存失敗：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('consumables').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      await fetchAll();
    } catch (e: any) {
      setQueryError(`刪除失敗：${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const isLowStock = (row: Consumable) => row.stock_quantity <= row.restock_threshold;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader
        icon={<Package className="w-6 h-6 text-green-600" />}
        title="耗材維護"
        description="管理會被用掉、需要補貨的消耗品庫存（例如沐浴乳、衛生紙）。床單/枕頭套/毛巾這類重複使用的布巾備品，請寫在「房型與空間維護」的設備欄位裡，不算耗材。"
        action={<Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增耗材</Button>}
      />

      {queryError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{queryError}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">名稱</th>
                <th className="py-3 px-4">庫存數量</th>
                <th className="py-3 px-4">補貨門檻</th>
                <th className="py-3 px-4">適用房型/空間</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={5}><EmptyState icon={<Package className="w-12 h-12 text-gray-200" />} message="尚未設定任何耗材，點右上角「新增耗材」開始" /></td></tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} onClick={() => openEdit(row)} className="hover:bg-green-50 transition-colors cursor-pointer">
                    <td className="py-3 px-4 font-medium text-gray-800">{row.name}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 ${isLowStock(row) ? 'text-red-600 font-medium' : 'text-gray-700'}`}>
                        {isLowStock(row) && <AlertTriangle className="w-3.5 h-3.5" />}
                        {row.stock_quantity} {row.unit}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-gray-500">{row.restock_threshold} {row.unit}</td>
                    <td className="py-3 px-4 text-gray-500">{spaceNames(row.id)}</td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={(e) => { e.stopPropagation(); openEdit(row); }} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                        <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={showForm}
        title={editingId ? '編輯耗材' : '新增耗材'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
            <Button onClick={handleSave} loading={saving}>{saving ? '儲存中...' : '儲存'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">名稱</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：沐浴乳" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">單位</label>
            <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="瓶" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">庫存數量</label>
            <input type="number" value={form.stock_quantity} onChange={(e) => setForm({ ...form, stock_quantity: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">補貨門檻</label>
            <input type="number" value={form.restock_threshold} onChange={(e) => setForm({ ...form, restock_threshold: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg" title="庫存低於等於這個數字時，畫面會標示提醒" />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-2">適用房型/空間</label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-40 overflow-y-auto border rounded-lg p-3">
            {spaceOptions.length === 0 ? (
              <p className="text-xs text-gray-400 col-span-full">尚未設定任何房型/空間，請先到「房型與空間維護」新增</p>
            ) : (
              spaceOptions.map((s) => {
                const checked = form.spaceIds.includes(s.id);
                return (
                  <label key={s.id} className={`flex items-center gap-2 px-2 py-1.5 border rounded-lg text-sm cursor-pointer ${checked ? 'bg-green-50 border-green-300' : 'border-gray-200'}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggleSpace(s.id)} />
                    {s.name}
                  </label>
                );
              })
            )}
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">備註</label>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full px-3 py-2 border rounded-lg" />
        </div>
        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除耗材"
        message={`確定要刪除「${deleteTarget?.name}」嗎？`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

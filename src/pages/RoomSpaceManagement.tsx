import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { DoorOpen, Plus, Pencil, Trash2 } from 'lucide-react';
import { PageHeader, Button, Modal, ConfirmDialog, EmptyState, Switch, ResponsiveTable } from '../components/ui';

interface SpaceRow {
  id: string;
  type: string;
  name: string;
  floor: string;
  capacity: number;
  equipment: string;
  is_active: boolean;
  display_order: number;
}

const emptyForm = (): Omit<SpaceRow, 'id'> => ({
  type: '房間', name: '', floor: '', capacity: 2, equipment: '', is_active: true, display_order: 0,
});

export default function RoomSpaceManagement() {
  const [rows, setRows] = useState<SpaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<SpaceRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchRows();
  }, []);

  const fetchRows = async () => {
    setLoading(true);
    setQueryError('');
    const { data, error } = await supabase.from('room_types').select('*').order('display_order');
    if (error) {
      setQueryError(`查詢失敗：${error.message}`);
      setRows([]);
    } else {
      setRows(data || []);
    }
    setLoading(false);
  };

  const openNew = () => {
    setEditingId(null);
    setForm({ ...emptyForm(), display_order: rows.length });
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (row: SpaceRow) => {
    setEditingId(row.id);
    setForm({
      type: row.type || '房間',
      name: row.name,
      floor: row.floor || '',
      capacity: row.capacity ?? 2,
      equipment: row.equipment || '',
      is_active: row.is_active,
      display_order: row.display_order,
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setFormError('請輸入名稱');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const payload = {
        type: form.type.trim() || '房間',
        name: form.name.trim(),
        floor: form.floor,
        capacity: form.type === '房間' ? Number(form.capacity) || 0 : 0,
        equipment: form.equipment,
        is_active: form.is_active,
        display_order: form.display_order,
      };
      if (editingId) {
        const { error } = await supabase.from('room_types').update(payload).eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('room_types').insert(payload);
        if (error) throw error;
      }
      setShowForm(false);
      await fetchRows();
    } catch (e: any) {
      setFormError(`儲存失敗：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (row: SpaceRow) => {
    const { error } = await supabase.from('room_types').update({ is_active: !row.is_active }).eq('id', row.id);
    if (error) {
      setQueryError(`更新失敗：${error.message}`);
      return;
    }
    fetchRows();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('room_types').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      await fetchRows();
    } catch (e: any) {
      setQueryError(`刪除失敗：${e.message}（如果這個房型已經有訂價設定或訂單使用中，需要先清除才能刪除）`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="w-full space-y-6">
      <PageHeader
        icon={<DoorOpen className="w-6 h-6 text-green-600" />}
        title="房型與空間維護"
        description="管理民宿裡每個房間或空間的基本資料。只有「房間」類型會出現在「房型與報價」的訂價與訂房邏輯裡，其他類型（例如公共空間）純粹是設施紀錄。"
        action={<Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增房間/空間</Button>}
      />

      {queryError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{queryError}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <ResponsiveTable
          rows={rows}
          rowKey={(row) => row.id}
          loading={loading}
          empty={<EmptyState icon={<DoorOpen className="w-12 h-12 text-gray-200" />} message="尚未設定任何房間或空間，點右上角「新增房間/空間」開始" />}
          onRowClick={openEdit}
          // 欄位順序維持原本的表格順序。手機卡片是靠 cardTitle／cardAside 這些旗標挑欄位，
          // 跟在陣列裡的位置無關，所以不需要為了卡片版面去動桌機的欄序。
          columns={[
            {
              key: 'type', header: '類型',
              cell: (row) => <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">{row.type || '房間'}</span>,
            },
            // 名稱當卡片標題、啟用開關貼在右上角：手機上掃過去要先看到「哪一間、開著沒」。
            { key: 'name', header: '名稱', cardTitle: true, tdClass: 'font-medium text-gray-800', cell: (row) => row.name },
            { key: 'floor', header: '樓層', cell: (row) => row.floor || '-' },
            { key: 'capacity', header: '容納人數', cell: (row) => (row.type === '房間' ? row.capacity : '-') },
            { key: 'display_order', header: '組合優先順序', cell: (row) => row.display_order },
            { key: 'equipment', header: '設備', tdClass: 'text-gray-500 max-w-xs truncate', cardFullWidth: true, cell: (row) => row.equipment || '-' },
            {
              // 撥開關不該順便把編輯視窗打開，所以擋掉冒泡。
              key: 'is_active', header: '啟用', cardAside: true, stopRowClick: true,
              cell: (row) => <Switch checked={row.is_active} onChange={() => toggleActive(row)} />,
            },
            {
              key: 'actions', header: '', cardActions: true, thClass: 'w-px', tdClass: 'text-right',
              cell: (row) => (
                <div className="flex items-center justify-end gap-1">
                  <button onClick={(e) => { e.stopPropagation(); openEdit(row); }} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                  <button onClick={(e) => { e.stopPropagation(); setDeleteTarget(row); }} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                </div>
              ),
            },
          ]}
        />
      </div>

      <Modal
        open={showForm}
        title={editingId ? '編輯房間/空間' : '新增房間/空間'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
            <Button onClick={handleSave} loading={saving}>{saving ? '儲存中...' : '儲存'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">類型</label>
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
            className="w-full px-3 py-2 border rounded-lg bg-white"
          >
            <option value="房間">房間</option>
            <option value="空間">空間</option>
          </select>
          <p className="text-xs text-gray-400 mt-1">只有「房間」的資料列，才會出現在「房型與報價」的訂價設定裡；「空間」純粹是設施紀錄，不能訂房、不需要價格。</p>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">名稱</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：暖木、交誼廳" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">樓層</label>
            <input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="2F" />
          </div>
          {form.type === '房間' && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">容納人數</label>
              <input type="number" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg" />
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">組合優先順序</label>
          <input type="number" value={form.display_order} onChange={(e) => setForm({ ...form, display_order: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg" />
          <p className="text-xs text-gray-400 mt-1">數字小的排前面。系統自動建議包棟房型組合、或客人沒指定要開哪幾間房時，同容量的房間會優先挑數字小的。</p>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">設備</label>
          <textarea value={form.equipment} onChange={(e) => setForm({ ...form, equipment: e.target.value })} rows={3} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：除濕機、投影機、冷氣" />
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm text-gray-700">啟用</label>
          <Switch checked={form.is_active} onChange={() => setForm({ ...form, is_active: !form.is_active })} />
        </div>
        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除房間/空間"
        message={`確定要刪除「${deleteTarget?.name}」嗎？如果這個房型已經有訂價設定或訂單使用中，會刪除失敗。`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

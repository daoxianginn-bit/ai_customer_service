import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Variable, Plus, Pencil, Trash2 } from 'lucide-react';
import { PageHeader, Button, Modal, ConfirmDialog, EmptyState } from '../components/ui';
import { SOURCE_OPTIONS, VariableSource } from '../lib/messageVariables';

interface VariableRow {
  id: string;
  variable_name: string;
  source: VariableSource;
  field_key: string;
  display_order: number;
}

function sourceLabel(source: VariableSource): string {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.label || source;
}

function fieldLabel(source: VariableSource, fieldKey: string): string {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.fields.find((f) => f.value === fieldKey)?.label || fieldKey;
}

export default function MessageVariables() {
  const [rows, setRows] = useState<VariableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<VariableRow | null>(null);
  const [formName, setFormName] = useState('');
  const [formSource, setFormSource] = useState<VariableSource>('booking');
  const [formField, setFormField] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<VariableRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchRows();
  }, []);

  const fetchRows = async () => {
    setLoading(true);
    setQueryError('');
    const { data, error } = await supabase.from('message_variables').select('*').order('display_order');
    if (error) {
      setQueryError(`查詢失敗：${error.message}`);
      setRows([]);
    } else {
      setRows(data || []);
    }
    setLoading(false);
  };

  const currentSourceFields = SOURCE_OPTIONS.find((s) => s.value === formSource)?.fields || [];

  const openNew = () => {
    setEditing(null);
    setFormName('');
    setFormSource('booking');
    setFormField(SOURCE_OPTIONS[0].fields[0]?.value || '');
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (row: VariableRow) => {
    setEditing(row);
    setFormName(row.variable_name);
    setFormSource(row.source);
    setFormField(row.field_key);
    setFormError('');
    setShowForm(true);
  };

  const handleSourceChange = (source: VariableSource) => {
    setFormSource(source);
    const fields = SOURCE_OPTIONS.find((s) => s.value === source)?.fields || [];
    setFormField(fields[0]?.value || '');
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!name) {
      setFormError('請輸入變數名稱');
      return;
    }
    if (!formField) {
      setFormError('請選擇欄位');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editing) {
        const { error } = await supabase
          .from('message_variables')
          .update({ variable_name: name, source: formSource, field_key: formField, updated_at: new Date().toISOString() })
          .eq('id', editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('message_variables')
          .insert({ variable_name: name, source: formSource, field_key: formField, display_order: rows.length });
        if (error) throw error;
      }
      setShowForm(false);
      await fetchRows();
    } catch (e: any) {
      setFormError(e.message?.includes('duplicate') || e.code === '23505' ? '這個變數名稱已經存在，請換一個名稱' : `儲存失敗：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('message_variables').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      await fetchRows();
    } catch (e: any) {
      setQueryError(`刪除失敗：${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <PageHeader
        icon={<Variable className="w-6 h-6 text-green-600" />}
        title="訊息變數資料維護"
        description="管理「LINE 自定訊息流程」罐頭訊息與「客製訊息發送」範本裡可用的 [變數名稱]，決定每個變數要從訂單、客戶還是民宿設定的哪個欄位取值。"
        action={<Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增變數</Button>}
      />

      {queryError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{queryError}</div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">變數名稱</th>
                <th className="py-3 px-4">來源</th>
                <th className="py-3 px-4">欄位</th>
                <th className="py-3 px-4"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={4} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={4}><EmptyState icon={<Variable className="w-12 h-12 text-gray-200" />} message="尚未設定任何變數，點右上角「新增變數」開始" /></td></tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="hover:bg-green-50 transition-colors">
                    <td className="py-3 px-4 font-mono text-gray-800">[{row.variable_name}]</td>
                    <td className="py-3 px-4 text-gray-600">{sourceLabel(row.source)}</td>
                    <td className="py-3 px-4 text-gray-600">{fieldLabel(row.source, row.field_key)}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openEdit(row)} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                        <button onClick={() => setDeleteTarget(row)} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
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
        title={editing ? '編輯變數' : '新增變數'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
            <Button onClick={handleSave} loading={saving}>{saving ? '儲存中...' : '儲存'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">變數名稱</label>
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg"
            placeholder="例如：訂單編號"
          />
          <p className="text-xs text-gray-400 mt-1">訊息範本裡用 [{formName || '變數名稱'}] 這樣的寫法插入。</p>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">來源</label>
          <select value={formSource} onChange={(e) => handleSourceChange(e.target.value as VariableSource)} className="w-full px-3 py-2 border rounded-lg bg-white">
            {SOURCE_OPTIONS.map((s) => (<option key={s.value} value={s.value}>{s.label}</option>))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">欄位</label>
          <select value={formField} onChange={(e) => setFormField(e.target.value)} className="w-full px-3 py-2 border rounded-lg bg-white">
            {currentSourceFields.map((f) => (<option key={f.value} value={f.value}>{f.label}</option>))}
          </select>
        </div>
        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除變數"
        message={`確定要刪除變數「[${deleteTarget?.variable_name}]」嗎？刪除後，還在用這個變數的訊息範本裡，[${deleteTarget?.variable_name}] 會直接顯示原始文字，不會再被替換成實際資料。`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

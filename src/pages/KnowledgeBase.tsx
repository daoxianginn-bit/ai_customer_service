import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Plus, Trash2, Pencil, FileText, File as FileIcon, X, ClipboardList } from 'lucide-react';

type KbItem = {
  id: string;
  type: 'text' | 'file';
  title: string;
  content: string | null;
  file_url: string | null;
  file_name: string | null;
  is_active: boolean;
  created_at: string;
};

const emptyForm = { id: '', type: 'text' as 'text' | 'file', title: '', content: '', file_url: '', file_name: '' };

export default function KnowledgeBase() {
  const [items, setItems] = useState<KbItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    fetchItems();
  }, []);

  const fetchItems = async () => {
    setLoading(true);
    const { data, error } = await supabase.from('knowledge_base_items').select('*').order('created_at', { ascending: false });
    if (!error) setItems(data || []);
    setLoading(false);
  };

  const openNewForm = () => {
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEditForm = (item: KbItem) => {
    setForm({
      id: item.id,
      type: item.type,
      title: item.title,
      content: item.content || '',
      file_url: item.file_url || '',
      file_name: item.file_name || '',
    });
    setShowForm(true);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSaving(true);
    try {
      const fileExt = file.name.split('.').pop();
      const filePath = `kb/${Math.random()}.${fileExt}`;
      const { error: uploadError } = await supabase.storage.from('knowledge_base').upload(filePath, file);
      if (uploadError) throw uploadError;
      const { data: { publicUrl } } = supabase.storage.from('knowledge_base').getPublicUrl(filePath);
      setForm((prev) => ({ ...prev, file_url: publicUrl, file_name: file.name, title: prev.title || file.name }));
    } catch (err: any) {
      alert(`上傳失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.title.trim()) {
      alert('請輸入標題');
      return;
    }
    if (form.type === 'text' && !form.content.trim()) {
      alert('請輸入內容');
      return;
    }
    if (form.type === 'file' && !form.file_url) {
      alert('請上傳檔案');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        type: form.type,
        title: form.title,
        content: form.type === 'text' ? form.content : null,
        file_url: form.type === 'file' ? form.file_url : null,
        file_name: form.type === 'file' ? form.file_name : null,
        updated_at: new Date().toISOString(),
      };

      if (form.id) {
        const { error } = await supabase.from('knowledge_base_items').update(payload).eq('id', form.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('knowledge_base_items').insert(payload);
        if (error) throw error;
      }

      setShowForm(false);
      setForm(emptyForm);
      fetchItems();
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('確定要刪除這筆知識庫資料嗎？')) return;
    const { error } = await supabase.from('knowledge_base_items').delete().eq('id', id);
    if (error) {
      alert(`刪除失敗：${error.message}`);
      return;
    }
    fetchItems();
  };

  const toggleActive = async (item: KbItem) => {
    const { error } = await supabase.from('knowledge_base_items').update({ is_active: !item.is_active }).eq('id', item.id);
    if (error) {
      alert(`更新失敗：${error.message}`);
      return;
    }
    fetchItems();
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl shadow-sm border">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <ClipboardList className="w-6 h-6 text-blue-600" />
            知識庫管理
          </h2>
          <p className="text-gray-500">可新增多筆文字或檔案資料，AI 回覆時會參考已啟用的項目</p>
        </div>
        <button onClick={openNewForm} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
          <Plus className="w-4 h-4" />
          新增資料
        </button>
      </div>

      {showForm && (
        <div className="bg-white p-6 rounded-xl shadow-sm border space-y-4">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-gray-800">{form.id ? '編輯資料' : '新增資料'}</h3>
            <button onClick={() => setShowForm(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5 text-gray-400" /></button>
          </div>

          <div className="flex gap-3">
            <button onClick={() => setForm({ ...form, type: 'text' })} disabled={!!form.id} className={`flex-1 p-3 rounded-lg border-2 flex items-center justify-center gap-2 disabled:opacity-50 ${form.type === 'text' ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
              <FileText className="w-4 h-4" /> 文字內容
            </button>
            <button onClick={() => setForm({ ...form, type: 'file' })} disabled={!!form.id} className={`flex-1 p-3 rounded-lg border-2 flex items-center justify-center gap-2 disabled:opacity-50 ${form.type === 'file' ? 'border-blue-500 bg-blue-50' : 'border-gray-200'}`}>
              <FileIcon className="w-4 h-4" /> 檔案 (PDF/TXT)
            </button>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">標題</label>
            <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="w-full px-4 py-2 border rounded-lg" placeholder="例如：常見問題、退換貨政策" />
          </div>

          {form.type === 'text' ? (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">內容</label>
              <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} rows={5} className="w-full px-4 py-2 border rounded-lg" />
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">上傳檔案</label>
              <div className="relative border-2 border-dashed border-gray-300 rounded-lg p-6 flex flex-col items-center justify-center text-gray-500 hover:border-blue-400 hover:bg-blue-50">
                <input type="file" accept=".pdf,.txt" onChange={handleFileUpload} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" />
                <FileIcon className="w-8 h-8 mb-2" />
                <p>{form.file_name ? `已選擇：${form.file_name}` : '點擊或拖曳上傳'}</p>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg border text-gray-600 hover:bg-gray-50">取消</button>
            <button onClick={handleSubmit} disabled={saving} className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
              {saving ? '儲存中...' : '儲存'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 border-b">
              <tr className="text-sm font-semibold text-gray-600">
                <th className="py-4 px-6">標題</th>
                <th className="py-4 px-6">類型</th>
                <th className="py-4 px-6">啟用中</th>
                <th className="py-4 px-6">建立時間</th>
                <th className="py-4 px-6">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-20 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-2">
                      <ClipboardList className="w-12 h-12 text-gray-200" />
                      <p>尚未新增任何知識庫資料</p>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="hover:bg-blue-50 transition-colors">
                    <td className="py-4 px-6 font-medium text-gray-800">{item.title}</td>
                    <td className="py-4 px-6 text-sm text-gray-500">{item.type === 'text' ? '文字' : `檔案 (${item.file_name})`}</td>
                    <td className="py-4 px-6">
                      <button
                        onClick={() => toggleActive(item)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${item.is_active ? 'bg-green-500' : 'bg-gray-300'}`}
                      >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${item.is_active ? 'translate-x-6' : 'translate-x-1'}`} />
                      </button>
                    </td>
                    <td className="py-4 px-6 text-sm text-gray-500">{new Date(item.created_at).toLocaleString('zh-TW')}</td>
                    <td className="py-4 px-6">
                      <div className="flex gap-2">
                        <button onClick={() => openEditForm(item)} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                        <button onClick={() => handleDelete(item.id)} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

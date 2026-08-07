import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Search, Send, Plus, Trash2, Pencil, X, Gauge } from 'lucide-react';
import MessageTemplateEditor from '../components/MessageTemplateEditor';

interface Template {
  id: string;
  title: string;
  body: string;
}

// 跟 custom-messages.ts 的 MAX_BATCH_SEND 對齊：同步逐一 push，人太多容易超過 function 執行時間上限。
const MAX_BATCH_SEND = 50;

interface QuotaInfo {
  limit: number | null; // null＝無上限（付費方案）
  used: number;
  remaining: number | null;
}

async function callCustomMessagesFunction(action: string, payload: Record<string, any> = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch('/.netlify/functions/custom-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '請求失敗');
  return result;
}

export default function CustomMessageSending() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  const [search, setSearch] = useState('');
  const [querying, setQuerying] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: number; fail: number } | null>(null);

  useEffect(() => {
    fetchTemplates();
    fetchQuota();
    runQuery();
  }, []);

  const fetchTemplates = async () => {
    const { data } = await supabase.from('custom_message_templates').select('*').order('created_at');
    setTemplates(data || []);
  };

  const fetchQuota = async () => {
    try {
      const result = await callCustomMessagesFunction('quota');
      setQuota(result);
    } catch (e: any) {
      console.error('查詢額度失敗', e.message);
    }
  };

  const rowKey = (row: Record<string, string>, index: number) => row['LINE_USER_ID'] || `row-${index}`;
  const displayName = (row: Record<string, string>) => row['LINE_NAME'] || row['訂房姓名'] || '（未知）';

  const runQuery = async () => {
    setQuerying(true);
    setSelectedKeys(new Set());
    try {
      const result = await callCustomMessagesFunction('list', { search });
      setHeaders(result.headers || []);
      setRows(result.rows || []);
    } catch (e: any) {
      alert(`查詢失敗：${e.message}`);
    } finally {
      setQuerying(false);
    }
  };

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedKeys.size === rows.length) {
      setSelectedKeys(new Set());
    } else {
      setSelectedKeys(new Set(rows.map((r, i) => rowKey(r, i))));
    }
  };

  const selectedRows = rows.filter((r, i) => selectedKeys.has(rowKey(r, i)));
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || null;

  const openNewTemplate = () => {
    setEditingTemplate({ title: '', body: '' });
    setShowTemplateModal(true);
  };

  const openEditTemplate = (t: Template) => {
    setEditingTemplate({ id: t.id, title: t.title, body: t.body });
    setShowTemplateModal(true);
  };

  const saveTemplate = async () => {
    if (!editingTemplate || !editingTemplate.title.trim()) {
      alert('請填寫範本標題');
      return;
    }
    setSavingTemplate(true);
    try {
      if (editingTemplate.id) {
        await supabase.from('custom_message_templates').update({ title: editingTemplate.title, body: editingTemplate.body }).eq('id', editingTemplate.id);
      } else {
        await supabase.from('custom_message_templates').insert({ title: editingTemplate.title, body: editingTemplate.body });
      }
      await fetchTemplates();
      setShowTemplateModal(false);
      setEditingTemplate(null);
    } catch (e: any) {
      alert(`儲存範本失敗：${e.message}`);
    } finally {
      setSavingTemplate(false);
    }
  };

  const deleteTemplate = async (id: string) => {
    if (!confirm('確定要刪除這個範本嗎？')) return;
    await supabase.from('custom_message_templates').delete().eq('id', id);
    if (selectedTemplateId === id) setSelectedTemplateId('');
    await fetchTemplates();
  };

  const handleSendClick = () => {
    if (!selectedRows.length) {
      alert('請先勾選要發送的名單');
      return;
    }
    if (selectedRows.length > MAX_BATCH_SEND) {
      alert(`一次最多發送 ${MAX_BATCH_SEND} 位，請分批發送（目前勾選 ${selectedRows.length} 位）`);
      return;
    }
    if (!selectedTemplate) {
      alert('請選擇要發送的訊息範本');
      return;
    }
    setSendResult(null);
    setShowConfirm(true);
  };

  const confirmSend = async () => {
    if (!selectedTemplate) return;
    setSending(true);
    try {
      const recipients = selectedRows
        .filter((r) => r['LINE_USER_ID'])
        .map((r) => ({ lineUserId: r['LINE_USER_ID'], fields: r }));
      const result = await callCustomMessagesFunction('send', { recipients, template: selectedTemplate.body });
      const ok = (result.results || []).filter((r: any) => r.ok).length;
      const fail = (result.results || []).length - ok;
      setSendResult({ ok, fail });
      setShowConfirm(false);
      await fetchQuota();
    } catch (e: any) {
      alert(`發送失敗：${e.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-wrap justify-between items-start gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Send className="w-6 h-6 text-blue-600" />
            客製訊息發送
          </h2>
          <p className="text-gray-500 mt-1">
            查詢所有跟 LINE 官方帳號聊過天的聯絡人（不限於有訂房詢問），勾選要發送的對象，選一個訊息範本後發送。這是主動推播（push），會消耗 LINE 官方帳號的免費訊息額度。
          </p>
        </div>
        <div className="flex items-center gap-2 bg-gray-50 border rounded-lg px-4 py-2 text-sm text-gray-700">
          <Gauge className="w-4 h-4 text-gray-400" />
          {quota == null ? (
            <span className="text-gray-400">額度查詢中...</span>
          ) : quota.limit == null ? (
            <span>本月已用 {quota.used.toLocaleString()} 則（無上限方案）</span>
          ) : (
            <span>
              本月剩餘 <strong className={quota.remaining !== null && quota.remaining < 50 ? 'text-red-600' : 'text-gray-800'}>{quota.remaining?.toLocaleString()}</strong>
              {' '}
              / {quota.limit.toLocaleString()} 則
            </span>
          )}
        </div>
      </div>

      {/* 步驟一：查詢聯絡人名單 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b">
          <h3 className="text-lg font-bold text-gray-800">① 查詢名單</h3>
          <p className="text-sm text-gray-500 mt-1">可依 LINE 暱稱搜尋，預設依最近互動時間排序（最多顯示 200 位）。</p>
        </div>
        <div className="p-6 border-b flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 mb-1">LINE 暱稱</label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runQuery()}
              placeholder="輸入暱稱關鍵字，留空查全部"
              className="w-full px-3 py-2 border rounded-lg"
            />
          </div>
          <button
            onClick={runQuery}
            disabled={querying}
            className="flex items-center gap-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50"
          >
            <Search className="w-4 h-4" />
            {querying ? '查詢中...' : '查詢'}
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-2 px-4">
                  <input type="checkbox" checked={rows.length > 0 && selectedKeys.size === rows.length} onChange={toggleSelectAll} disabled={!rows.length} />
                </th>
                <th className="py-2 px-4">LINE 暱稱</th>
                <th className="py-2 px-4">最近互動時間</th>
                <th className="py-2 px-4">入住日期</th>
                <th className="py-2 px-4">總金額</th>
                <th className="py-2 px-4">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => {
                const key = rowKey(r, i);
                return (
                  <tr key={key}>
                    <td className="py-2 px-4">
                      <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleSelected(key)} />
                    </td>
                    <td className="py-2 px-4">{displayName(r)}</td>
                    <td className="py-2 px-4 text-gray-500">{r['最近互動時間']}</td>
                    <td className="py-2 px-4">{r['入住日期']}</td>
                    <td className="py-2 px-4">{r['總金額']}</td>
                    <td className="py-2 px-4 text-gray-500">{r['狀態']}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-gray-400">
                    {querying ? '查詢中...' : '查無聯絡人'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 步驟二：訊息範本 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b flex justify-between items-center">
          <div>
            <h3 className="text-lg font-bold text-gray-800">② 訊息範本</h3>
            <p className="text-sm text-gray-500 mt-1">方括號 [欄位名稱] 會用查詢到的那一列資料自動帶入；沒有訂房紀錄的聯絡人，報價相關欄位會是空白。</p>
          </div>
          <button onClick={openNewTemplate} className="flex items-center gap-1 bg-gray-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-800">
            <Plus className="w-4 h-4" /> 新增範本
          </button>
        </div>
        <div className="p-6 space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className={`flex items-center gap-3 px-4 py-3 border rounded-lg cursor-pointer ${selectedTemplateId === t.id ? 'border-blue-400 bg-blue-50' : 'border-gray-200'}`}
              onClick={() => setSelectedTemplateId(t.id)}
            >
              <input type="radio" checked={selectedTemplateId === t.id} onChange={() => setSelectedTemplateId(t.id)} />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-800">{t.title}</p>
                <p className="text-xs text-gray-400 truncate">{t.body}</p>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  openEditTemplate(t);
                }}
                className="p-1.5 text-gray-500 hover:bg-gray-100 rounded"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteTemplate(t.id);
                }}
                className="p-1.5 text-red-500 hover:bg-red-50 rounded"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {templates.length === 0 && <p className="text-sm text-gray-400">尚未新增任何訊息範本</p>}
        </div>
      </div>

      {/* 步驟三：發送 */}
      <div className="bg-white rounded-xl shadow-sm border p-6 flex flex-wrap justify-between items-center gap-4">
        <p className="text-sm text-gray-600">
          已勾選 <strong className={selectedRows.length > MAX_BATCH_SEND ? 'text-red-600' : ''}>{selectedRows.length}</strong> 位
          （單次上限 {MAX_BATCH_SEND} 位），已選範本：<strong>{selectedTemplate?.title || '（尚未選擇）'}</strong>
        </p>
        <button
          onClick={handleSendClick}
          className="flex items-center gap-1 bg-orange-600 text-white px-5 py-2.5 rounded-lg text-sm hover:bg-orange-700"
        >
          <Send className="w-4 h-4" /> 發送
        </button>
      </div>

      {sendResult && (
        <div className="bg-white rounded-xl shadow-sm border p-6 text-sm">
          發送完成：成功 <strong className="text-green-600">{sendResult.ok}</strong> 則，失敗 <strong className="text-red-600">{sendResult.fail}</strong> 則。
        </div>
      )}

      {/* 新增/編輯範本 Modal */}
      {showTemplateModal && editingTemplate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-6 border-b">
              <h3 className="text-lg font-bold text-gray-800">{editingTemplate.id ? '編輯範本' : '新增範本'}</h3>
              <button onClick={() => setShowTemplateModal(false)} className="p-1 text-gray-400 hover:text-gray-600">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">範本標題</label>
                <input
                  value={editingTemplate.title}
                  onChange={(e) => setEditingTemplate({ ...editingTemplate, title: e.target.value })}
                  className="w-full px-3 py-2 border rounded-lg"
                  placeholder="例如：暑假促銷通知"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">訊息內容</label>
                <MessageTemplateEditor
                  value={editingTemplate.body}
                  onChange={(v) => setEditingTemplate({ ...editingTemplate, body: v })}
                  placeholders={headers}
                  rows={10}
                  placeholder={headers.length ? undefined : '先在上面「查詢名單」按一次查詢，這裡才會列出可用的快捷欄位'}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-6 border-t">
              <button onClick={() => setShowTemplateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                取消
              </button>
              <button
                onClick={saveTemplate}
                disabled={savingTemplate}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {savingTemplate ? '儲存中...' : '確認'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 發送確認 Modal */}
      {showConfirm && selectedTemplate && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <h3 className="text-lg font-bold text-gray-800">確認發送</h3>
            </div>
            <div className="p-6 space-y-3">
              <p className="text-sm text-gray-700">
                這次要發送給 <strong>{selectedRows.length}</strong> 位（名單），確定要送出嗎？
              </p>
              <div className="max-h-48 overflow-y-auto border rounded-lg p-3 text-sm text-gray-600 space-y-1">
                {selectedRows.map((r, i) => (
                  <div key={i}>・{displayName(r)}{r['入住日期'] ? `（入住 ${r['入住日期']}）` : ''}</div>
                ))}
              </div>
              <p className="text-xs text-gray-400">範本：{selectedTemplate.title}</p>
            </div>
            <div className="flex justify-end gap-2 p-6 border-t">
              <button onClick={() => setShowConfirm(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                取消
              </button>
              <button
                onClick={confirmSend}
                disabled={sending}
                className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {sending ? '發送中...' : '確定發送'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

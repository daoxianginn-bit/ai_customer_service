import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Search, Send, Plus, Trash2, Pencil, X, Gauge, RotateCcw, Save, Eye, Eraser, User } from 'lucide-react';
import MessageTemplateEditor from '../components/MessageTemplateEditor';

interface Template {
  id: string;
  title: string;
  body: string;
}

const MAX_BATCH_SEND = 50;
const PAGE_SIZE = 10;

const QUICK_INSERT_FIELDS = ['客戶姓名', '入住日期', '退房日期', '入住人數', '房型', '總報價', '訂金', '尾款', '禮金內容', '民宿名稱', '客服LINE'];

const STATUS_OPTIONS = [
  { value: '', label: '全部狀態' },
  { value: 'inquiring', label: '待報價' },
  { value: 'pending_confirmation', label: '待確認' },
  { value: 'confirmed', label: '已確認' },
  { value: 'cancelled', label: '已取消' },
  { value: 'pending_manual_conflict', label: '待人工確認' },
];

const QUICK_FILTER_CHIPS = STATUS_OPTIONS.filter((s) => s.value);

interface QuotaInfo {
  limit: number | null;
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
  const [draftBody, setDraftBody] = useState('');

  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('');
  const [roomType, setRoomType] = useState('');
  const [roomTypeOptions, setRoomTypeOptions] = useState<string[]>([]);

  const [querying, setQuerying] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

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
    fetchRoomTypeOptions();
    runQuery();
  }, []);

  const fetchTemplates = async () => {
    const { data } = await supabase.from('custom_message_templates').select('*').order('created_at');
    setTemplates(data || []);
  };

  const fetchRoomTypeOptions = async () => {
    const { data } = await supabase.from('room_types').select('name').order('display_order');
    setRoomTypeOptions((data || []).map((r: any) => r.name));
  };

  const fetchQuota = async () => {
    try {
      const result = await callCustomMessagesFunction('quota');
      setQuota(result);
    } catch (e: any) {
      console.error('查詢額度失敗', e.message);
    }
  };

  const rowKey = (row: Record<string, string>, index: number) => row['訂單編號'] || row['LINE_USER_ID'] || `row-${index}`;
  const displayName = (row: Record<string, string>) => row['客戶姓名'] || '（未知）';

  const runQuery = async (overrideStatus?: string) => {
    setQuerying(true);
    setSelectedKeys(new Set());
    setPage(0);
    try {
      const result = await callCustomMessagesFunction('list', {
        keyword,
        startDate,
        endDate,
        status: overrideStatus !== undefined ? overrideStatus : status,
        roomType,
      });
      setHeaders(result.headers || []);
      setRows(result.rows || []);
    } catch (e: any) {
      alert(`查詢失敗：${e.message}`);
    } finally {
      setQuerying(false);
    }
  };

  const clearFilters = () => {
    setKeyword('');
    setStartDate('');
    setEndDate('');
    setStatus('');
    setRoomType('');
    setTimeout(() => runQuery(''), 0);
  };

  const toggleQuickFilter = (value: string) => {
    const next = status === value ? '' : value;
    setStatus(next);
    runQuery(next);
  };

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pagedRows = useMemo(() => rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE), [rows, page]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  const toggleSelectAllOnPage = () => {
    const pageKeys = pagedRows.map((r, i) => rowKey(r, page * PAGE_SIZE + i));
    const allSelected = pageKeys.every((k) => selectedKeys.has(k));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) pageKeys.forEach((k) => next.delete(k));
      else pageKeys.forEach((k) => next.add(k));
      return next;
    });
  };

  const selectedRows = rows.filter((r, i) => selectedKeys.has(rowKey(r, i)));
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || null;
  const previewCustomer = selectedRows[0] || null;

  const mergeTemplateLocal = (template: string, fields: Record<string, string>): string => {
    let result = template;
    for (const [key, value] of Object.entries(fields)) {
      result = result.split(`[${key}]`).join(value ?? '');
    }
    return result;
  };

  const previewMessage = previewCustomer ? mergeTemplateLocal(draftBody, previewCustomer) : draftBody;

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
    if (selectedTemplateId === id) {
      setSelectedTemplateId('');
      setDraftBody('');
    }
    await fetchTemplates();
  };

  const applyTemplateSelection = (id: string) => {
    setSelectedTemplateId(id);
    const t = templates.find((tp) => tp.id === id);
    setDraftBody(t?.body || '');
  };

  const saveDraftAsTemplate = () => {
    if (selectedTemplate) {
      openEditTemplate({ ...selectedTemplate, body: draftBody });
    } else {
      setEditingTemplate({ title: '', body: draftBody });
      setShowTemplateModal(true);
    }
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
    if (!draftBody.trim()) {
      alert('請先選擇或輸入訊息內容');
      return;
    }
    setSendResult(null);
    setShowConfirm(true);
  };

  const confirmSend = async () => {
    setSending(true);
    try {
      const recipients = selectedRows
        .filter((r) => r['LINE_USER_ID'])
        .map((r) => ({ lineUserId: r['LINE_USER_ID'], fields: r }));
      const result = await callCustomMessagesFunction('send', { recipients, template: draftBody });
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
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-wrap justify-between items-start gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Send className="w-6 h-6 text-blue-600" />
            客製訊息發送
          </h2>
          <p className="text-gray-500 mt-1">查詢客戶名單、套用訊息範本、帶入報價欄位並批次發送 LINE 訊息。</p>
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
              {' '}/ {quota.limit.toLocaleString()} 則
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* 第一欄：查詢客戶名單 */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="p-4 border-b space-y-3">
              <h3 className="font-bold text-gray-800 text-sm">1. 查詢客戶名單</h3>
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runQuery()}
                placeholder="搜尋姓名、電話或訂單編號..."
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">入住日期（起）</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">入住日期（迄）</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">訂單狀態</label>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm bg-white">
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">房型</label>
                  <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm bg-white">
                    <option value="">全部房型</option>
                    <option value="包棟">包棟</option>
                    {roomTypeOptions.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => runQuery()} disabled={querying} className="flex-1 flex items-center justify-center gap-1 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
                  <Search className="w-4 h-4" />
                  {querying ? '查詢中...' : '查詢'}
                </button>
                <button onClick={clearFilters} className="flex items-center justify-center gap-1 px-3 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">
                  <RotateCcw className="w-4 h-4" /> 清除條件
                </button>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <span className="text-xs text-gray-400 self-center">快速篩選：</span>
                {QUICK_FILTER_CHIPS.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => toggleQuickFilter(c.value)}
                    className={`px-3 py-1 text-xs rounded-full border transition-colors ${status === c.value ? 'bg-blue-600 text-white border-blue-600' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-gray-50 border-b sticky top-0">
                  <tr className="text-gray-600">
                    <th className="py-2 px-3">
                      <input type="checkbox" checked={pagedRows.length > 0 && pagedRows.every((r, i) => selectedKeys.has(rowKey(r, page * PAGE_SIZE + i)))} onChange={toggleSelectAllOnPage} disabled={!pagedRows.length} />
                    </th>
                    <th className="py-2 px-3">姓名</th>
                    <th className="py-2 px-3">入住日期</th>
                    <th className="py-2 px-3">人數</th>
                    <th className="py-2 px-3">房型</th>
                    <th className="py-2 px-3">訂單狀態</th>
                    <th className="py-2 px-3">預估報價</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pagedRows.map((r, i) => {
                    const key = rowKey(r, page * PAGE_SIZE + i);
                    return (
                      <tr key={key} className={selectedKeys.has(key) ? 'bg-blue-50' : ''}>
                        <td className="py-2 px-3">
                          <input type="checkbox" checked={selectedKeys.has(key)} onChange={() => toggleSelected(key)} />
                        </td>
                        <td className="py-2 px-3">{displayName(r)}</td>
                        <td className="py-2 px-3 whitespace-nowrap">{r['入住日期']}</td>
                        <td className="py-2 px-3">{r['入住人數']}</td>
                        <td className="py-2 px-3">{r['房型']}</td>
                        <td className="py-2 px-3">
                          <span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600 whitespace-nowrap">{r['訂單狀態']}</span>
                        </td>
                        <td className="py-2 px-3 whitespace-nowrap">{r['總報價'] ? `NT$ ${Number(r['總報價']).toLocaleString()}` : ''}</td>
                      </tr>
                    );
                  })}
                  {pagedRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-16 text-center text-gray-400">{querying ? '查詢中...' : '查無符合條件的訂單'}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center px-4 py-3 border-t text-xs text-gray-500">
              <span>已選取 {selectedRows.length} 位顧客</span>
              <div className="flex items-center gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 border rounded disabled:opacity-40">‹</button>
                <span>{page + 1} / {totalPages}</span>
                <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 border rounded disabled:opacity-40">›</button>
              </div>
              <span>每頁顯示 {PAGE_SIZE}</span>
            </div>
          </div>
        </div>

        {/* 第二欄：訊息範本與內容編輯 */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
            <h3 className="font-bold text-gray-800 text-sm">2. 訊息範本與內容編輯</h3>
            <div className="flex items-center gap-2">
              <select value={selectedTemplateId} onChange={(e) => applyTemplateSelection(e.target.value)} className="flex-1 px-2 py-1.5 border rounded-lg text-sm bg-white">
                <option value="">選擇訊息範本</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
              <button onClick={openNewTemplate} className="p-2 border rounded-lg hover:bg-gray-50" title="新增範本"><Plus className="w-4 h-4 text-gray-500" /></button>
              {selectedTemplate && (
                <>
                  <button onClick={() => openEditTemplate(selectedTemplate)} className="p-2 border rounded-lg hover:bg-gray-50" title="編輯範本"><Pencil className="w-4 h-4 text-gray-500" /></button>
                  <button onClick={() => deleteTemplate(selectedTemplate.id)} className="p-2 border rounded-lg hover:bg-red-50" title="刪除範本"><Trash2 className="w-4 h-4 text-red-500" /></button>
                </>
              )}
            </div>

            <MessageTemplateEditor value={draftBody} onChange={setDraftBody} placeholders={QUICK_INSERT_FIELDS} rows={14} placeholder="輸入訊息內容，或點下方快捷欄位插入合併欄位" />

            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={saveDraftAsTemplate} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                <Save className="w-3.5 h-3.5" /> 儲存範本
              </button>
              <button onClick={() => setShowConfirm(false)} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                <Eye className="w-3.5 h-3.5" /> 預覽套用
              </button>
              <button onClick={() => setDraftBody('')} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                <Eraser className="w-3.5 h-3.5" /> 清空內容
              </button>
            </div>
          </div>
        </div>

        {/* 第三欄：發送預覽 */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
            <h3 className="font-bold text-gray-800 text-sm">3. 發送預覽</h3>

            {previewCustomer ? (
              <div className="border rounded-lg p-3 text-xs space-y-1 bg-gray-50">
                <div className="flex justify-between"><span className="text-gray-400">客戶姓名</span><span className="font-medium text-gray-800">{previewCustomer['客戶姓名']}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">入住日期</span><span>{previewCustomer['入住日期']}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">入住人數</span><span>{previewCustomer['入住人數']}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">房型</span><span>{previewCustomer['房型']}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">總報價</span><span>{previewCustomer['總報價'] ? `NT$ ${Number(previewCustomer['總報價']).toLocaleString()}` : '-'}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">訂金</span><span>{previewCustomer['訂金'] ? `NT$ ${Number(previewCustomer['訂金']).toLocaleString()}` : '-'}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">尾款</span><span>{previewCustomer['尾款'] ? `NT$ ${Number(previewCustomer['尾款']).toLocaleString()}` : '-'}</span></div>
              </div>
            ) : (
              <p className="text-xs text-gray-400">勾選左側名單中的顧客，這裡會即時預覽套版後的訊息內容。</p>
            )}

            <div className="flex items-start gap-2">
              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="bg-blue-50 rounded-2xl rounded-tl-sm px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap break-words">
                  {previewMessage || '（訊息內容預覽）'}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">{new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>

            <p className="text-xs text-gray-500 pt-2 border-t">
              已勾選 <strong className={selectedRows.length > MAX_BATCH_SEND ? 'text-red-600' : ''}>{selectedRows.length}</strong> 位（單次上限 {MAX_BATCH_SEND} 位）
            </p>
            <button
              onClick={handleSendClick}
              className="w-full flex items-center justify-center gap-1 bg-orange-600 text-white px-5 py-2.5 rounded-lg text-sm hover:bg-orange-700"
            >
              <Send className="w-4 h-4" /> 發送給已勾選顧客
            </button>

            {sendResult && (
              <div className="text-xs bg-gray-50 border rounded-lg p-3">
                發送完成：成功 <strong className="text-green-600">{sendResult.ok}</strong> 則，失敗 <strong className="text-red-600">{sendResult.fail}</strong> 則。
              </div>
            )}
          </div>
        </div>
      </div>

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
                  placeholder="例如：包棟報價通知"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">訊息內容</label>
                <MessageTemplateEditor
                  value={editingTemplate.body}
                  onChange={(v) => setEditingTemplate({ ...editingTemplate, body: v })}
                  placeholders={QUICK_INSERT_FIELDS}
                  rows={10}
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
      {showConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <h3 className="text-lg font-bold text-gray-800">確認發送訊息</h3>
            </div>
            <div className="p-6 space-y-3">
              <p className="text-sm text-gray-700">即將發送給 <strong>{selectedRows.length}</strong> 位顧客，訊息內容會依各顧客的報價資訊自動帶入。是否確認發送？</p>
              <div className="space-y-1.5 text-sm text-gray-600">
                <p>✅ 已套用範本：{selectedTemplate?.title || '（自訂內容）'}</p>
                <p>✅ 發送對象：{selectedRows.length} 位顧客</p>
                <p>✅ 發送方式：LINE 訊息</p>
              </div>
              <div className="max-h-40 overflow-y-auto border rounded-lg p-3 text-sm text-gray-600 space-y-1">
                {selectedRows.map((r, i) => (
                  <div key={i}>・{displayName(r)}{r['入住日期'] ? `（入住 ${r['入住日期']}）` : ''}</div>
                ))}
              </div>
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
                {sending ? '發送中...' : '確認發送'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

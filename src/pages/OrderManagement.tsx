import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ClipboardList, Search, RotateCcw, X, Save } from 'lucide-react';

const PAGE_SIZE = 15;

const STATUS_OPTIONS = [
  { value: '', label: '全部狀態' },
  { value: 'inquiring', label: '待報價' },
  { value: 'pending_confirmation', label: '待確認' },
  { value: 'confirmed', label: '已確認' },
  { value: 'cancelled', label: '已取消' },
  { value: 'pending_manual_conflict', label: '待人工確認' },
];

const EDITABLE_STATUS_OPTIONS = STATUS_OPTIONS.filter((s) => s.value);

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'inquiring': return 'bg-gray-100 text-gray-600';
    case 'pending_confirmation': return 'bg-yellow-100 text-yellow-700';
    case 'confirmed': return 'bg-green-100 text-green-700';
    case 'cancelled': return 'bg-red-100 text-red-600';
    case 'pending_manual_conflict': return 'bg-orange-100 text-orange-700';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((s) => s.value === status)?.label || status;
}

export default function OrderManagement() {
  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('');
  const [roomType, setRoomType] = useState('');
  const [roomTypeOptions, setRoomTypeOptions] = useState<string[]>([]);

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [selected, setSelected] = useState<any | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editDeposit, setEditDeposit] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchRoomTypeOptions();
    runQuery(0);
  }, []);

  const fetchRoomTypeOptions = async () => {
    const { data } = await supabase.from('room_types').select('name').order('display_order');
    setRoomTypeOptions((data || []).map((r: any) => r.name));
  };

  const runQuery = async (pageIndex: number) => {
    setLoading(true);
    let query = supabase
      .from('bookings')
      .select('*')
      .order('created_at', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (startDate) query = query.gte('checkin_date', startDate);
    if (endDate) query = query.lte('checkin_date', endDate);
    if (status) query = query.eq('status', status);
    if (roomType === '包棟') query = query.eq('whole_house', true);
    else if (roomType) query = query.ilike('room_type_label', `%${roomType}%`);
    if (keyword.trim()) {
      const kw = keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
    }

    const { data, error } = await query;
    if (!error) {
      setRows(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setLoading(false);
  };

  const clearFilters = () => {
    setKeyword('');
    setStartDate('');
    setEndDate('');
    setStatus('');
    setRoomType('');
    setTimeout(() => runQuery(0), 0);
  };

  const openDetail = (row: any) => {
    setSelected(row);
    setEditStatus(row.status);
    setEditDeposit(row.deposit != null ? String(row.deposit) : '');
    setEditNotes(row.notes || '');
  };

  const closeDetail = () => setSelected(null);

  const saveDetail = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const depositValue = editDeposit === '' ? null : Number(editDeposit);
      const { error } = await supabase
        .from('bookings')
        .update({ status: editStatus, deposit: depositValue, notes: editNotes, updated_at: new Date().toISOString() })
        .eq('id', selected.id);
      if (error) throw error;
      setSelected(null);
      runQuery(page);
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const balanceDue = (row: any) => (row.total_amount != null ? row.total_amount - (row.deposit ?? 0) : null);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-xl shadow-sm border">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <ClipboardList className="w-6 h-6 text-blue-600" />
          訂單管理
        </h2>
        <p className="text-gray-500 mt-1">查詢、檢視與編輯所有訂房紀錄的狀態、訂金與備註。</p>
      </div>

      <div className="bg-white p-4 rounded-xl shadow-sm border space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 mb-1">關鍵字搜尋</label>
            <input value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runQuery(0)} placeholder="搜尋姓名、電話或訂單編號" className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住日期（起）</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">入住日期（迄）</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">訂單狀態</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 border rounded-lg text-sm bg-white">
              {STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">房型</label>
            <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">全部房型</option>
              <option value="包棟">包棟</option>
              {roomTypeOptions.map((r) => (<option key={r} value={r}>{r}</option>))}
            </select>
          </div>
          <button onClick={() => runQuery(0)} disabled={loading} className="flex items-center gap-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50">
            <Search className="w-4 h-4" /> 查詢
          </button>
          <button onClick={clearFilters} className="flex items-center gap-1 px-4 py-2 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">
            <RotateCcw className="w-4 h-4" /> 清除條件
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">訂單編號</th>
                <th className="py-3 px-4">姓名</th>
                <th className="py-3 px-4">入住日期</th>
                <th className="py-3 px-4">退房日期</th>
                <th className="py-3 px-4">人數</th>
                <th className="py-3 px-4">房型</th>
                <th className="py-3 px-4">總報價</th>
                <th className="py-3 px-4">尾款</th>
                <th className="py-3 px-4">狀態</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={9} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={9} className="py-16 text-center text-gray-400">查無符合條件的訂單</td></tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} onClick={() => openDetail(row)} className="hover:bg-blue-50 transition-colors cursor-pointer">
                    <td className="py-3 px-4 font-mono text-xs text-gray-500">{row.order_number || '-'}</td>
                    <td className="py-3 px-4 font-medium text-gray-800">{row.name || row.nickname || '未取得'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.checkin_date ? String(row.checkin_date).replace(/-/g, '/') : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.checkout_date ? String(row.checkout_date).replace(/-/g, '/') : '-'}</td>
                    <td className="py-3 px-4">{row.headcount ?? '-'}</td>
                    <td className="py-3 px-4">{row.room_type_label || (row.whole_house ? '包棟' : '-')}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{row.total_amount != null ? `NT$ ${Number(row.total_amount).toLocaleString()}` : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{balanceDue(row) != null ? `NT$ ${Number(balanceDue(row)).toLocaleString()}` : '-'}</td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${statusBadgeClass(row.status)}`}>{statusLabel(row.status)}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center px-6 py-4 border-t text-sm text-gray-500">
          <button disabled={page === 0 || loading} onClick={() => runQuery(page - 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">上一頁</button>
          <span>第 {page + 1} 頁</span>
          <button disabled={!hasMore || loading} onClick={() => runQuery(page + 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">下一頁</button>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-6 border-b">
              <h3 className="text-lg font-bold text-gray-800">訂單詳情 {selected.order_number ? `（${selected.order_number}）` : ''}</h3>
              <button onClick={closeDetail} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-6 space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 text-gray-600">
                <div><span className="text-gray-400">客戶姓名／暱稱：</span>{selected.name || selected.nickname || '未取得'}</div>
                <div><span className="text-gray-400">電話：</span>{selected.phone || '-'}</div>
                <div><span className="text-gray-400">入住日期：</span>{selected.checkin_date ? String(selected.checkin_date).replace(/-/g, '/') : '-'}</div>
                <div><span className="text-gray-400">退房日期：</span>{selected.checkout_date ? String(selected.checkout_date).replace(/-/g, '/') : '-'}</div>
                <div><span className="text-gray-400">人數：</span>{selected.headcount ?? '-'}</div>
                <div><span className="text-gray-400">房型：</span>{selected.room_type_label || (selected.whole_house ? '包棟' : '-')}</div>
                <div><span className="text-gray-400">總報價：</span>{selected.total_amount != null ? `NT$ ${Number(selected.total_amount).toLocaleString()}` : '-'}</div>
                <div><span className="text-gray-400">尾款：</span>{balanceDue(selected) != null ? `NT$ ${Number(balanceDue(selected)).toLocaleString()}` : '-'}</div>
                <div className="col-span-2 font-mono text-xs text-gray-400 break-all">LINE ID：{selected.line_user_id}</div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 mb-1">訂單狀態</label>
                <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className="w-full px-3 py-2 border rounded-lg bg-white">
                  {EDITABLE_STATUS_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">訂金</label>
                <input type="number" value={editDeposit} onChange={(e) => setEditDeposit(e.target.value)} className="w-full px-3 py-2 border rounded-lg" placeholder="尚未填寫" />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">備註</label>
                <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} rows={4} className="w-full px-3 py-2 border rounded-lg" placeholder="內部備註，客戶不會看到" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-6 border-t">
              <button onClick={closeDetail} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">取消</button>
              <button onClick={saveDetail} disabled={saving} className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                <Save className="w-4 h-4" />
                {saving ? '儲存中...' : '儲存變更'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

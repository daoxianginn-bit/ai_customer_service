import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { MessageSquare, Search, RefreshCcw } from 'lucide-react';

type ConversationRow = {
  id: string;
  line_user_id: string;
  nickname: string | null;
  direction: 'inbound' | 'outbound';
  content: string;
  source: string;
  created_at: string;
};

const sourceLabel: Record<string, string> = {
  user: '用戶',
  ai_gpt: 'GPT',
  ai_gemini: 'Gemini',
  human_agent: '真人客服',
  system: '系統',
};

const PAGE_SIZE = 30;

export default function Conversations() {
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    fetchRows(0, userFilter);
  }, []);

  const fetchRows = async (pageIndex: number, filter: string) => {
    setLoading(true);
    let query = supabase
      .from('conversations')
      .select('*')
      .order('created_at', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (filter.trim()) {
      query = query.or(`line_user_id.ilike.%${filter.trim()}%,nickname.ilike.%${filter.trim()}%`);
    }

    const { data, error } = await query;
    if (!error) {
      setRows(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setLoading(false);
  };

  const handleSearch = () => fetchRows(0, userFilter);

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl shadow-sm border">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <MessageSquare className="w-6 h-6 text-blue-600" />
            對話紀錄
          </h2>
          <p className="text-gray-500">依用戶暱稱或 LINE ID 查詢，紀錄會依保留天數設定自動清除</p>
        </div>
        <button onClick={() => fetchRows(page, userFilter)} className="p-2 hover:bg-gray-100 rounded-lg">
          <RefreshCcw className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      <div className="bg-white p-4 rounded-xl shadow-sm border flex gap-2">
        <input
          type="text"
          value={userFilter}
          onChange={(e) => setUserFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="搜尋暱稱或 LINE User ID"
          className="flex-1 px-4 py-2 border rounded-lg"
        />
        <button onClick={handleSearch} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
          <Search className="w-4 h-4" />
          搜尋
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 border-b">
              <tr className="text-sm font-semibold text-gray-600">
                <th className="py-4 px-6">時間</th>
                <th className="py-4 px-6">用戶</th>
                <th className="py-4 px-6">方向</th>
                <th className="py-4 px-6">來源</th>
                <th className="py-4 px-6">內容</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-20 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-2">
                      <MessageSquare className="w-12 h-12 text-gray-200" />
                      <p>查無對話紀錄</p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="hover:bg-blue-50 transition-colors align-top">
                    <td className="py-4 px-6 text-sm text-gray-500 whitespace-nowrap">{new Date(row.created_at).toLocaleString('zh-TW')}</td>
                    <td className="py-4 px-6 text-sm">
                      <div className="font-medium text-gray-800">{row.nickname || '未取得'}</div>
                      <div className="text-xs text-gray-400 font-mono">{row.line_user_id}</div>
                    </td>
                    <td className="py-4 px-6 text-sm">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${row.direction === 'inbound' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                        {row.direction === 'inbound' ? '收到' : '回覆'}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-sm text-gray-600">{sourceLabel[row.source] || row.source}</td>
                    <td className="py-4 px-6 text-sm text-gray-700 max-w-md whitespace-pre-wrap break-words">{row.content}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center px-6 py-4 border-t text-sm text-gray-500">
          <button disabled={page === 0 || loading} onClick={() => fetchRows(page - 1, userFilter)} className="px-3 py-1 border rounded-lg disabled:opacity-40">上一頁</button>
          <span>第 {page + 1} 頁</span>
          <button disabled={!hasMore || loading} onClick={() => fetchRows(page + 1, userFilter)} className="px-3 py-1 border rounded-lg disabled:opacity-40">下一頁</button>
        </div>
      </div>
    </div>
  );
}

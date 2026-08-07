import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Bot, UserCheck, RefreshCcw, History, ListChecks, MessageSquare, Search, Headphones } from 'lucide-react';

type Tab = 'active' | 'history' | 'conversations';

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

export default function AiServiceCenter() {
  const [tab, setTab] = useState<Tab>('active');
  const [users, setUsers] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [convRows, setConvRows] = useState<ConversationRow[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (tab === 'active') {
      fetchHandoverUsers();
      const interval = setInterval(fetchHandoverUsers, 10000);
      return () => clearInterval(interval);
    } else if (tab === 'history') {
      fetchHistory();
    } else {
      fetchConversations(0, userFilter);
    }
  }, [tab]);

  const fetchHandoverUsers = async () => {
    const { data, error } = await supabase
      .from('user_states')
      .select('*')
      .eq('is_human_mode', true)
      .order('last_human_interaction', { ascending: false });

    if (!error) setUsers(data || []);
    setLoading(false);
  };

  const fetchHistory = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('handover_logs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(50);

    if (!error) setHistory(data || []);
    setLoading(false);
  };

  const fetchConversations = async (pageIndex: number, filter: string) => {
    setConvLoading(true);
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
      setConvRows(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setConvLoading(false);
  };

  const handleConvSearch = () => fetchConversations(0, userFilter);

  const switchToAI = async (userId: string) => {
    try {
      const { error } = await supabase
        .from('user_states')
        .update({
          is_human_mode: false,
          last_ai_reset_at: new Date().toISOString()
        })
        .eq('line_user_id', userId);

      if (error) throw error;

      const { data: { user } } = await supabase.auth.getUser();
      await supabase
        .from('handover_logs')
        .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: user?.email || 'admin' })
        .eq('line_user_id', userId)
        .eq('status', 'open');

      alert('已成功切換回 AI 客服。');
      fetchHandoverUsers();
    } catch (err: any) {
      console.error('Switch back to AI error:', err);
      alert(`操作失敗：${err.message}`);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl shadow-sm border">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Headphones className="w-6 h-6 text-red-600" />
            AI客服中心
          </h2>
          <p className="text-gray-500">處理進行中的真人對話請求、查詢轉接歷史與完整對話紀錄</p>
        </div>
        <button
          onClick={tab === 'active' ? fetchHandoverUsers : tab === 'history' ? fetchHistory : () => fetchConversations(page, userFilter)}
          className="p-2 hover:bg-gray-100 rounded-lg"
        >
          <RefreshCcw className="w-5 h-5 text-gray-400" />
        </button>
      </div>

      <div className="flex gap-2 bg-white p-1.5 rounded-xl shadow-sm border w-fit">
        <button
          onClick={() => setTab('active')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'active' ? 'bg-red-50 text-red-600' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          <ListChecks className="w-4 h-4" /> 進行中
        </button>
        <button
          onClick={() => setTab('history')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'history' ? 'bg-red-50 text-red-600' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          <History className="w-4 h-4" /> 轉接歷史
        </button>
        <button
          onClick={() => setTab('conversations')}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === 'conversations' ? 'bg-red-50 text-red-600' : 'text-gray-500 hover:bg-gray-50'}`}
        >
          <MessageSquare className="w-4 h-4" /> 對話紀錄
        </button>
      </div>

      {tab === 'active' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50 border-b">
                <tr className="text-sm font-semibold text-gray-600">
                  <th className="py-4 px-6">用戶暱稱</th>
                  <th className="py-4 px-6">LINE User ID</th>
                  <th className="py-4 px-6">呼叫時間</th>
                  <th className="py-4 px-6">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={4} className="py-10 text-center text-gray-400">載入中...</td></tr>
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-20 text-center text-gray-400">
                      <div className="flex flex-col items-center gap-2">
                        <Bot className="w-12 h-12 text-gray-200" />
                        <p>目前沒有待處理的真人請求</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  users.map(user => (
                    <tr key={user.line_user_id} className="hover:bg-red-50 transition-colors">
                      <td className="py-4 px-6 font-medium text-gray-800">{user.nickname || '未取得'}</td>
                      <td className="py-4 px-6 font-mono text-xs text-gray-500">{user.line_user_id}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">
                        {new Date(user.last_human_interaction).toLocaleString('zh-TW')}
                      </td>
                      <td className="py-4 px-6">
                        <button
                          onClick={() => switchToAI(user.line_user_id)}
                          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 shadow-sm"
                        >
                          轉回 AI 接手
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50 border-b">
                <tr className="text-sm font-semibold text-gray-600">
                  <th className="py-4 px-6">用戶暱稱</th>
                  <th className="py-4 px-6">觸發關鍵字</th>
                  <th className="py-4 px-6">開始時間</th>
                  <th className="py-4 px-6">結束時間</th>
                  <th className="py-4 px-6">狀態</th>
                  <th className="py-4 px-6">處理人</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={6} className="py-10 text-center text-gray-400">載入中...</td></tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-20 text-center text-gray-400">
                      <div className="flex flex-col items-center gap-2">
                        <History className="w-12 h-12 text-gray-200" />
                        <p>尚無歷史紀錄</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  history.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                      <td className="py-4 px-6 font-medium text-gray-800">{row.nickname || '未取得'}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">{row.triggered_keyword || '-'}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">{new Date(row.started_at).toLocaleString('zh-TW')}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">{row.ended_at ? new Date(row.ended_at).toLocaleString('zh-TW') : '-'}</td>
                      <td className="py-4 px-6">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${row.status === 'open' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                          {row.status === 'open' ? '進行中' : '已結束'}
                        </span>
                      </td>
                      <td className="py-4 px-6 text-sm text-gray-600">{row.resolved_by === 'timeout_auto' ? '自動逾時' : (row.resolved_by || '-')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'conversations' && (
        <>
          <div className="bg-white p-4 rounded-xl shadow-sm border flex gap-2">
            <input
              type="text"
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleConvSearch()}
              placeholder="搜尋暱稱或 LINE User ID"
              className="flex-1 px-4 py-2 border rounded-lg"
            />
            <button onClick={handleConvSearch} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
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
                  {convLoading ? (
                    <tr><td colSpan={5} className="py-10 text-center text-gray-400">載入中...</td></tr>
                  ) : convRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-20 text-center text-gray-400">
                        <div className="flex flex-col items-center gap-2">
                          <MessageSquare className="w-12 h-12 text-gray-200" />
                          <p>查無對話紀錄</p>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    convRows.map((row) => (
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
              <button disabled={page === 0 || convLoading} onClick={() => fetchConversations(page - 1, userFilter)} className="px-3 py-1 border rounded-lg disabled:opacity-40">上一頁</button>
              <span>第 {page + 1} 頁</span>
              <button disabled={!hasMore || convLoading} onClick={() => fetchConversations(page + 1, userFilter)} className="px-3 py-1 border rounded-lg disabled:opacity-40">下一頁</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Bot, RefreshCcw, History, ListChecks, MessageSquare, Search, Headphones, Users } from 'lucide-react';
import { PageHeader, Button, EmptyState, StatusBadge, Pagination } from '../components/ui';

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

type ConvUser = {
  line_user_id: string;
  nickname: string | null;
  last_message_at: string | null;
};

const sourceLabel: Record<string, string> = {
  user: '用戶',
  ai_gpt: 'GPT',
  ai_gemini: 'Gemini',
  human_agent: '真人客服',
  system: '系統',
};

const PAGE_SIZE = 20;

export default function AiServiceCenter() {
  const [tab, setTab] = useState<Tab>('active');
  const [users, setUsers] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [convUsers, setConvUsers] = useState<ConvUser[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [selectedConvUserId, setSelectedConvUserId] = useState<string | null>(null);
  const [selectedConvMessages, setSelectedConvMessages] = useState<ConversationRow[]>([]);
  const [selectedConvLoading, setSelectedConvLoading] = useState(false);
  const selectedConvUser = convUsers.find((u) => u.line_user_id === selectedConvUserId) || null;

  useEffect(() => {
    if (tab === 'active') {
      fetchHandoverUsers();
      const interval = setInterval(fetchHandoverUsers, 10000);
      return () => clearInterval(interval);
    } else if (tab === 'history') {
      fetchHistory();
    } else {
      fetchConvUsers(0, userFilter);
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

  // 對話紀錄改成「左側客戶清單、右側該客戶完整對話」，清單資料來源用 user_states（每個 LINE
  // 用戶一列，跟「客戶資料」頁同一張表），比逐則訊息去重更直接。
  const fetchConvUsers = async (pageIndex: number, filter: string) => {
    setConvLoading(true);
    let query = supabase
      .from('user_states')
      .select('line_user_id, nickname, last_message_at')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (filter.trim()) {
      const kw = filter.trim().replace(/[%,()]/g, '');
      query = query.or(`line_user_id.ilike.%${kw}%,nickname.ilike.%${kw}%`);
    }

    const { data, error } = await query;
    if (!error) {
      setConvUsers(data || []);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setConvLoading(false);
    if (!(data || []).some((u: any) => u.line_user_id === selectedConvUserId)) setSelectedConvUserId(null);
  };

  const handleConvSearch = () => fetchConvUsers(0, userFilter);

  const selectConvUser = async (lineUserId: string) => {
    setSelectedConvUserId(lineUserId);
    setSelectedConvLoading(true);
    const { data } = await supabase
      .from('conversations')
      .select('*')
      .eq('line_user_id', lineUserId)
      .order('created_at', { ascending: false })
      .limit(100);
    setSelectedConvMessages(data || []);
    setSelectedConvLoading(false);
  };

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
      <PageHeader
        icon={<Headphones className="w-6 h-6 text-green-600" />}
        title="AI客服中心"
        description="處理進行中的真人對話請求、查詢轉接歷史與完整對話紀錄"
        action={
          <button
            onClick={tab === 'active' ? fetchHandoverUsers : tab === 'history' ? fetchHistory : () => fetchConvUsers(page, userFilter)}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCcw className="w-5 h-5 text-gray-400" />
          </button>
        }
      />

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
                  <tr><td colSpan={4}><EmptyState icon={<Bot className="w-12 h-12 text-gray-200" />} message="目前沒有待處理的真人請求" /></td></tr>
                ) : (
                  users.map(user => (
                    <tr key={user.line_user_id} className="hover:bg-red-50 transition-colors">
                      <td className="py-4 px-6 font-medium text-gray-800">{user.nickname || '未取得'}</td>
                      <td className="py-4 px-6 font-mono text-xs text-gray-500">{user.line_user_id}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">
                        {new Date(user.last_human_interaction).toLocaleString('zh-TW')}
                      </td>
                      <td className="py-4 px-6">
                        <Button onClick={() => switchToAI(user.line_user_id)}>轉回 AI 接手</Button>
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
                  <tr><td colSpan={6}><EmptyState icon={<History className="w-12 h-12 text-gray-200" />} message="尚無歷史紀錄" /></td></tr>
                ) : (
                  history.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                      <td className="py-4 px-6 font-medium text-gray-800">{row.nickname || '未取得'}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">{row.triggered_keyword || '-'}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">{new Date(row.started_at).toLocaleString('zh-TW')}</td>
                      <td className="py-4 px-6 text-sm text-gray-600">{row.ended_at ? new Date(row.ended_at).toLocaleString('zh-TW') : '-'}</td>
                      <td className="py-4 px-6"><StatusBadge status={row.status} /></td>
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
            <Button onClick={handleConvSearch} icon={<Search className="w-4 h-4" />}>搜尋</Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
            <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-gray-50 border-b">
                    <tr className="text-sm font-semibold text-gray-600">
                      <th className="py-3 px-4">用戶</th>
                      <th className="py-3 px-4">最近互動</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {convLoading ? (
                      <tr><td colSpan={2} className="py-10 text-center text-gray-400">載入中...</td></tr>
                    ) : convUsers.length === 0 ? (
                      <tr><td colSpan={2}><EmptyState icon={<Users className="w-12 h-12 text-gray-200" />} message="查無客戶" /></td></tr>
                    ) : (
                      convUsers.map((u) => (
                        <tr
                          key={u.line_user_id}
                          onClick={() => selectConvUser(u.line_user_id)}
                          className={`cursor-pointer transition-colors ${selectedConvUserId === u.line_user_id ? 'bg-green-50' : 'hover:bg-green-50'}`}
                        >
                          <td className="py-3 px-4 text-sm">
                            <div className="font-medium text-gray-800">{u.nickname || '未取得'}</div>
                            <div className="text-xs text-gray-400 font-mono">{u.line_user_id}</div>
                          </td>
                          <td className="py-3 px-4 text-xs text-gray-500 whitespace-nowrap">{u.last_message_at ? new Date(u.last_message_at).toLocaleString('zh-TW') : '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <Pagination page={page} hasMore={hasMore} onPrev={() => fetchConvUsers(page - 1, userFilter)} onNext={() => fetchConvUsers(page + 1, userFilter)} />
            </div>

            <div className="lg:col-span-3 bg-white rounded-xl shadow-sm border p-6 lg:sticky lg:top-6">
              {!selectedConvUser ? (
                <EmptyState icon={<MessageSquare className="w-12 h-12 text-gray-200" />} message="請從左側選擇一位客戶查看完整對話" />
              ) : (
                <>
                  <div className="flex items-center justify-between mb-3 pb-3 border-b">
                    <div>
                      <p className="font-bold text-gray-800">{selectedConvUser.nickname || '未取得'}</p>
                      <p className="text-xs text-gray-400 font-mono">{selectedConvUser.line_user_id}</p>
                    </div>
                    <p className="text-xs text-gray-400">依系統保留天數設定自動清除，最多顯示 100 則</p>
                  </div>
                  {selectedConvLoading ? (
                    <p className="text-sm text-gray-400">載入中...</p>
                  ) : selectedConvMessages.length === 0 ? (
                    <p className="text-sm text-gray-400">查無對話紀錄</p>
                  ) : (
                    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                      {[...selectedConvMessages].reverse().map((row) => (
                        <div key={row.id} className={`flex ${row.direction === 'inbound' ? 'justify-start' : 'justify-end'}`}>
                          <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${row.direction === 'inbound' ? 'bg-gray-100 text-gray-800 rounded-bl-sm' : 'bg-green-600 text-white rounded-br-sm'}`}>
                            <p className="whitespace-pre-wrap break-words">{row.content}</p>
                            <p className={`text-[10px] mt-1 flex items-center gap-1 ${row.direction === 'inbound' ? 'text-gray-400' : 'text-green-100'}`}>
                              {sourceLabel[row.source] || row.source} · {new Date(row.created_at).toLocaleString('zh-TW')}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

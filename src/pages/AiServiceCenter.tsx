import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Bot, RefreshCcw, History, ListChecks, MessageSquare, Search, Headphones, Users } from 'lucide-react';
import { PageHeader, Button, EmptyState, StatusBadge, Pagination, ResponsiveTable } from '../components/ui';

type Tab = 'active' | 'history' | 'conversations';

// 客人訊息的處理過程診斷，由 line-webhook 寫在 inbound 那一列（見 supabase_schema.sql 的
// conversations.meta 說明）。steps／errors／elapsed_ms 一定有；其餘鍵值依走到哪條路而定：
// flow（進了哪個流程哪一步）、extracted（抓到的欄位）、ai_extract／ai_chat（AI 原文與耗時）。
type TurnMeta = {
  elapsed_ms: number;
  steps: string[];
  errors: string[];
  [key: string]: unknown;
};

type ConversationRow = {
  id: string;
  line_user_id: string;
  nickname: string | null;
  direction: 'inbound' | 'outbound';
  content: string;
  source: string;
  created_at: string;
  meta?: TurnMeta | null;
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

// meta 裡各區塊的中文標題。沒列在這裡的鍵值也會顯示（用原始鍵名），
// 之後 webhook 多記什麼都不用改這邊。
const metaSectionLabel: Record<string, string> = {
  flow: '訂房流程',
  extracted: '這句抓到的欄位',
  ai_extract: 'AI 欄位擷取',
  ai_chat: 'AI 問答',
};

function MetaValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-gray-400">（空）</span>;
  if (typeof value === 'string') return <span className="whitespace-pre-wrap break-words">{value}</span>;
  if (typeof value === 'number' || typeof value === 'boolean') return <span className="font-mono">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-gray-400">（無）</span>;
    return <span>{value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('、')}</span>;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="text-gray-400">（無）</span>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500 whitespace-nowrap">{k}</dt>
          <dd className="min-w-0">
            {/* AI 原文另外用等寬字＋可捲動區塊，長的 JSON 才看得清楚 */}
            {k === 'raw' || k === 'reply' ? (
              <pre className="font-mono text-[11px] bg-white border border-gray-200 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{String(v)}</pre>
            ) : (
              <MetaValue value={v} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// 客人訊息底下的「處理過程」摺疊區。預設收起，只露出一行摘要（耗時、有沒有錯誤），
// 點開才看細節——對話紀錄的主角還是對話本身，診斷是要查問題時才需要的。
function TurnDiagnostics({ meta }: { meta: TurnMeta }) {
  const [open, setOpen] = useState(false);
  const hasError = meta.errors?.length > 0;
  const lastStep = meta.steps?.[meta.steps.length - 1];
  const otherKeys = Object.keys(meta).filter((k) => !['elapsed_ms', 'steps', 'errors'].includes(k));

  return (
    <div className={`mt-1 max-w-[85%] text-xs rounded-lg border ${hasError ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full text-left px-2.5 py-1.5 flex items-center gap-2 ${hasError ? 'text-red-700' : 'text-gray-600'}`}
      >
        <span className="font-medium">{open ? '▾' : '▸'} 處理過程</span>
        <span className="text-[10px] text-gray-400">{meta.elapsed_ms} ms</span>
        {hasError && <span className="text-[10px] bg-red-600 text-white px-1.5 rounded">{meta.errors.length} 個錯誤</span>}
        {!open && lastStep && <span className="truncate text-gray-500 ml-auto">{lastStep}</span>}
      </button>

      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 text-gray-700">
          {hasError && (
            <div>
              <p className="font-semibold text-red-700 mb-0.5">錯誤</p>
              <ul className="list-disc pl-4 text-red-700 space-y-0.5">
                {meta.errors.map((e, i) => <li key={i} className="break-words">{e}</li>)}
              </ul>
            </div>
          )}
          <div>
            <p className="font-semibold mb-0.5">決策過程</p>
            {meta.steps?.length ? (
              <ol className="list-decimal pl-4 space-y-0.5">
                {meta.steps.map((s, i) => <li key={i} className="break-words">{s}</li>)}
              </ol>
            ) : (
              <p className="text-gray-400">（沒有記錄到任何步驟——可能在前置檢查就結束了）</p>
            )}
          </div>
          {otherKeys.map((k) => (
            <div key={k}>
              <p className="font-semibold mb-0.5">{metaSectionLabel[k] || k}</p>
              <div className="bg-white/70 border border-gray-200 rounded p-2">
                <MetaValue value={meta[k]} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 20;

// V2 把這頁拆成兩個路由（§4.3）：/service 是客服工作台（進行中＋轉接歷史），
// /service/conversations 是對話紀錄。view 決定顯示哪一組，內部頁籤只在工作台切進行中／歷史。
// 第二階段會把工作台改成三欄式（§28）；這一步先讓兩個路由各自對應正確的內容。
export default function AiServiceCenter({ view = 'workbench' }: { view?: 'workbench' | 'conversations' } = {}) {
  const [tab, setTab] = useState<Tab>(view === 'conversations' ? 'conversations' : 'active');
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
    // 只在切換分頁時重抓。userFilter 是刻意不放的——放了會變成每打一個字就查一次，搜尋由按鈕觸發。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    <div className="w-full space-y-6">
      <PageHeader
        icon={<Headphones className="w-6 h-6 text-green-600" />}
        title={view === 'conversations' ? '對話紀錄' : '客服工作台'}
        description={view === 'conversations' ? '每位客人的完整對話，可展開每則訊息的處理過程' : '處理進行中的真人對話請求與轉接歷史'}
        action={
          <button
            onClick={tab === 'active' ? fetchHandoverUsers : tab === 'history' ? fetchHistory : () => fetchConvUsers(page, userFilter)}
            className="p-2 hover:bg-gray-100 rounded-lg"
          >
            <RefreshCcw className="w-5 h-5 text-gray-400" />
          </button>
        }
      />

      {view === 'workbench' && (
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
      </div>
      )}

      {tab === 'active' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <ResponsiveTable
            rows={users}
            rowKey={(user) => user.line_user_id}
            loading={loading}
            empty={<EmptyState icon={<Bot className="w-12 h-12 text-gray-200" />} message="目前沒有待處理的真人請求" />}
            rowClass={() => 'hover:bg-red-50 transition-colors'}
            columns={[
              { key: 'nickname', header: '用戶暱稱', cardTitle: true, thClass: 'text-sm font-semibold', tdClass: 'font-medium text-gray-800', cell: (u) => u.nickname || '未取得' },
              { key: 'line_user_id', header: 'LINE User ID', thClass: 'text-sm font-semibold', tdClass: 'font-mono text-xs text-gray-500', cardFullWidth: true, cell: (u) => u.line_user_id },
              { key: 'called_at', header: '呼叫時間', thClass: 'text-sm font-semibold', tdClass: 'text-sm text-gray-600', cell: (u) => new Date(u.last_human_interaction).toLocaleString('zh-TW') },
              {
                // 「轉回 AI 接手」是這頁唯一的動作，手機上放在卡片底部整條比較好按。
                key: 'actions', header: '操作', cardActions: true, thClass: 'text-sm font-semibold',
                cell: (u) => <Button onClick={() => switchToAI(u.line_user_id)}>轉回 AI 接手</Button>,
              },
            ]}
          />
        </div>
      )}

      {tab === 'history' && (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <ResponsiveTable
            rows={history}
            rowKey={(row) => row.id}
            loading={loading}
            empty={<EmptyState icon={<History className="w-12 h-12 text-gray-200" />} message="尚無歷史紀錄" />}
            rowClass={() => 'hover:bg-gray-50 transition-colors'}
            columns={[
              { key: 'nickname', header: '用戶暱稱', cardTitle: true, thClass: 'text-sm font-semibold', tdClass: 'font-medium text-gray-800', cell: (row) => row.nickname || '未取得' },
              { key: 'keyword', header: '觸發關鍵字', thClass: 'text-sm font-semibold', tdClass: 'text-sm text-gray-600', cell: (row) => row.triggered_keyword || '-' },
              { key: 'started_at', header: '開始時間', thClass: 'text-sm font-semibold', tdClass: 'text-sm text-gray-600', cell: (row) => new Date(row.started_at).toLocaleString('zh-TW') },
              { key: 'ended_at', header: '結束時間', thClass: 'text-sm font-semibold', tdClass: 'text-sm text-gray-600', cell: (row) => (row.ended_at ? new Date(row.ended_at).toLocaleString('zh-TW') : '-') },
              { key: 'status', header: '狀態', cardAside: true, thClass: 'text-sm font-semibold', cell: (row) => <StatusBadge status={row.status} /> },
              { key: 'resolved_by', header: '處理人', thClass: 'text-sm font-semibold', tdClass: 'text-sm text-gray-600', cell: (row) => (row.resolved_by === 'timeout_auto' ? '自動逾時' : (row.resolved_by || '-')) },
            ]}
          />
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
                        <div key={row.id} className={`flex flex-col ${row.direction === 'inbound' ? 'items-start' : 'items-end'}`}>
                          <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${row.direction === 'inbound' ? 'bg-gray-100 text-gray-800 rounded-bl-sm' : 'bg-green-600 text-white rounded-br-sm'}`}>
                            <p className="whitespace-pre-wrap break-words">{row.content}</p>
                            <p className={`text-[10px] mt-1 flex items-center gap-1 ${row.direction === 'inbound' ? 'text-gray-400' : 'text-green-100'}`}>
                              {sourceLabel[row.source] || row.source} · {new Date(row.created_at).toLocaleString('zh-TW')}
                            </p>
                          </div>
                          {row.direction === 'inbound' && row.meta && <TurnDiagnostics meta={row.meta} />}
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

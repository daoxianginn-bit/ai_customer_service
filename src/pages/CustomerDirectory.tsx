import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Users, Search, RotateCcw, MessageSquare, ClipboardList, Copy, RefreshCcw, AlertCircle } from 'lucide-react';
import { PageHeader, Button, Modal, StatusBadge, EmptyState, Pagination } from '../components/ui';
import { DEPOSIT_OR_LATER_STATUSES } from '../lib/bookingStatus';

const PAGE_SIZE_OPTIONS = [10, 20, 50];

interface Contact {
  line_user_id: string;
  nickname: string | null;
  avatar_url: string | null;
  last_message_at: string | null;
  first_message_at: string | null;
  bookingCount: number;
  hasConfirmed: boolean;
  hasAnyBooking: boolean;
}

type ContactStatus = 'missing_nickname' | 'ordered' | 'inquiry_only' | 'interacted';

const CONTACT_STATUS_CONFIG: Record<ContactStatus, { label: string; className: string }> = {
  missing_nickname: { label: '未取得暱稱', className: 'bg-orange-100 text-orange-700' },
  ordered: { label: '已下訂', className: 'bg-green-100 text-green-700' },
  inquiry_only: { label: '僅諮詢', className: 'bg-purple-100 text-purple-700' },
  interacted: { label: '已互動', className: 'bg-blue-100 text-blue-700' },
};

function getContactStatus(c: Contact): ContactStatus {
  if (!c.nickname) return 'missing_nickname';
  if (c.hasConfirmed) return 'ordered';
  if (c.hasAnyBooking) return 'inquiry_only';
  return 'interacted';
}

function ContactStatusBadge({ contact }: { contact: Contact }) {
  const status = getContactStatus(contact);
  const config = CONTACT_STATUS_CONFIG[status];
  return <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${config.className}`}>{config.label}</span>;
}

function Avatar({ url, size = 'w-9 h-9' }: { url: string | null; size?: string }) {
  return url ? (
    <img src={url} alt="" className={`${size} rounded-full object-cover shrink-0`} />
  ) : (
    <div className={`${size} rounded-full bg-gray-200 flex items-center justify-center shrink-0`}>
      <Users className="w-1/2 h-1/2 text-gray-400" />
    </div>
  );
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

async function callLineProfileFunction(lineUserId: string) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch('/.netlify/functions/line-profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ lineUserId }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '查詢失敗');
  return result;
}

export default function CustomerDirectory() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [queryError, setQueryError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const [keyword, setKeyword] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [nicknameStatus, setNicknameStatus] = useState<'all' | 'has' | 'missing'>('all');

  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailBookings, setDetailBookings] = useState<any[]>([]);
  const [detailConversations, setDetailConversations] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  const [showFullConvo, setShowFullConvo] = useState(false);
  const [fullConvoLoading, setFullConvoLoading] = useState(false);
  const [fullConvoList, setFullConvoList] = useState<any[]>([]);

  const selectedContact = contacts.find((c) => c.line_user_id === selectedId) || null;

  useEffect(() => {
    runQuery(0);
  }, [pageSize]);

  const runQuery = async (pageIndex: number) => {
    setLoading(true);
    setQueryError('');
    let query = supabase
      .from('user_states')
      .select('line_user_id, nickname, avatar_url, last_message_at, first_message_at')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(pageIndex * pageSize, pageIndex * pageSize + pageSize - 1);

    if (keyword.trim()) {
      const kw = keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`nickname.ilike.%${kw}%,line_user_id.ilike.%${kw}%`);
    }
    if (dateFrom) query = query.gte('last_message_at', `${dateFrom}T00:00:00`);
    if (dateTo) query = query.lte('last_message_at', `${dateTo}T23:59:59`);
    if (nicknameStatus === 'missing') query = query.is('nickname', null);
    else if (nicknameStatus === 'has') query = query.not('nickname', 'is', null);

    const { data: states, error: statesError } = await query;
    if (statesError) {
      setQueryError(`查詢聯絡人失敗：${statesError.message}`);
      setContacts([]);
      setLoading(false);
      return;
    }

    const userIds = (states || []).map((s: any) => s.line_user_id);
    let bookingsByUser: Record<string, any[]> = {};
    if (userIds.length) {
      const { data: bookings, error: bookingsError } = await supabase.from('bookings').select('line_user_id, status').in('line_user_id', userIds);
      if (bookingsError) setQueryError(`查詢訂單統計失敗：${bookingsError.message}`);
      for (const b of bookings || []) {
        if (!bookingsByUser[b.line_user_id]) bookingsByUser[b.line_user_id] = [];
        bookingsByUser[b.line_user_id].push(b);
      }
    }

    const merged: Contact[] = (states || []).map((s: any) => {
      const bookings = bookingsByUser[s.line_user_id] || [];
      return {
        line_user_id: s.line_user_id,
        nickname: s.nickname,
        avatar_url: s.avatar_url,
        last_message_at: s.last_message_at,
        first_message_at: s.first_message_at,
        bookingCount: bookings.length,
        hasConfirmed: bookings.some((b: any) => DEPOSIT_OR_LATER_STATUSES.includes(b.status)),
        hasAnyBooking: bookings.length > 0,
      };
    });
    setContacts(merged);
    setHasMore((states || []).length === pageSize);
    setPage(pageIndex);
    setLoading(false);
  };

  const clearFilters = () => {
    setKeyword('');
    setDateFrom('');
    setDateTo('');
    setNicknameStatus('all');
    setTimeout(() => runQuery(0), 0);
  };

  const applyQuickFilter = (preset: 'all' | 'today' | '7days' | 'missing') => {
    const today = toIsoDate(new Date());
    if (preset === 'all') {
      setDateFrom('');
      setDateTo('');
      setNicknameStatus('all');
    } else if (preset === 'today') {
      setDateFrom(today);
      setDateTo(today);
      setNicknameStatus('all');
    } else if (preset === '7days') {
      setDateFrom(toIsoDate(addDays(new Date(), -6)));
      setDateTo(today);
      setNicknameStatus('all');
    } else {
      setDateFrom('');
      setDateTo('');
      setNicknameStatus('missing');
    }
    setTimeout(() => runQuery(0), 0);
  };

  const activeQuickFilter = useMemo(() => {
    const today = toIsoDate(new Date());
    const sevenDaysAgo = toIsoDate(addDays(new Date(), -6));
    if (nicknameStatus === 'missing' && !dateFrom && !dateTo) return 'missing';
    if (nicknameStatus === 'all' && dateFrom === today && dateTo === today) return 'today';
    if (nicknameStatus === 'all' && dateFrom === sevenDaysAgo && dateTo === today) return '7days';
    if (nicknameStatus === 'all' && !dateFrom && !dateTo) return 'all';
    return null;
  }, [dateFrom, dateTo, nicknameStatus]);

  const refetchNickname = async (lineUserId: string) => {
    setRefreshingIds((prev) => new Set(prev).add(lineUserId));
    setRefreshErrors((prev) => { const next = { ...prev }; delete next[lineUserId]; return next; });
    try {
      const profile = await callLineProfileFunction(lineUserId);
      if (profile.displayName) {
        await supabase.from('user_states').update({ nickname: profile.displayName, avatar_url: profile.pictureUrl || null }).eq('line_user_id', lineUserId);
        setContacts((prev) => prev.map((c) => (c.line_user_id === lineUserId ? { ...c, nickname: profile.displayName, avatar_url: profile.pictureUrl || null } : c)));
      } else {
        setRefreshErrors((prev) => ({ ...prev, [lineUserId]: '目前仍抓不到暱稱' }));
      }
    } catch (e: any) {
      setRefreshErrors((prev) => ({ ...prev, [lineUserId]: e.message || '同步失敗' }));
    } finally {
      setRefreshingIds((prev) => { const next = new Set(prev); next.delete(lineUserId); return next; });
    }
  };

  const selectContact = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetailError('');
    const [{ data: bookings, error: bErr }, { data: conversations, error: cErr }] = await Promise.all([
      supabase.from('bookings').select('*').eq('line_user_id', id).order('created_at', { ascending: false }),
      supabase.from('conversations').select('*').eq('line_user_id', id).order('created_at', { ascending: false }).limit(5),
    ]);
    if (bErr || cErr) setDetailError(`載入詳細資料失敗：${(bErr || cErr)?.message}`);
    setDetailBookings(bookings || []);
    setDetailConversations(conversations || []);
    setDetailLoading(false);
  };

  const openFullConvo = async () => {
    if (!selectedId) return;
    setShowFullConvo(true);
    setFullConvoLoading(true);
    const { data } = await supabase.from('conversations').select('*').eq('line_user_id', selectedId).order('created_at', { ascending: false }).limit(100);
    setFullConvoList(data || []);
    setFullConvoLoading(false);
  };

  const copyId = (id: string) => navigator.clipboard.writeText(id);

  const quickFilterChips: { key: 'all' | 'today' | '7days' | 'missing'; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'today', label: '今日互動' },
    { key: '7days', label: '近 7 天' },
    { key: 'missing', label: '未取得暱稱' },
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader icon={<Users className="w-6 h-6 text-green-600" />} title="客戶資料" description="所有跟 LINE 官方帳號互動過的聯絡人，可查看基本資料、訂單紀錄與對話紀錄。" />

      {queryError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl flex items-center justify-between gap-3">
          <span className="flex items-center gap-2"><AlertCircle className="w-4 h-4 shrink-0" />{queryError}</span>
          <Button variant="secondary" onClick={() => runQuery(page)} icon={<RotateCcw className="w-4 h-4" />}>重新載入</Button>
        </div>
      )}

      <div className="bg-white p-4 rounded-xl shadow-sm border space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-gray-500 mb-1">關鍵字搜尋</label>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runQuery(0)}
              placeholder="搜尋 LINE 暱稱、User ID"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">最近互動時間區間</label>
            <div className="flex items-center gap-1">
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
              <span className="text-gray-400">~</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="px-3 py-2 border rounded-lg text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">暱稱狀態</label>
            <select value={nicknameStatus} onChange={(e) => setNicknameStatus(e.target.value as any)} className="px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="all">全部</option>
              <option value="has">已取得</option>
              <option value="missing">未取得</option>
            </select>
          </div>
          <Button onClick={() => runQuery(0)} loading={loading} icon={<Search className="w-4 h-4" />}>查詢</Button>
          <Button variant="secondary" onClick={clearFilters} icon={<RotateCcw className="w-4 h-4" />}>清除條件</Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-400">快速篩選：</span>
          {quickFilterChips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => applyQuickFilter(chip.key)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                activeQuickFilter === chip.key ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
        <div className="lg:col-span-3 bg-white rounded-xl shadow-sm border overflow-hidden">
          <div className="flex justify-between items-center px-4 py-3 border-b">
            <h3 className="font-bold text-gray-800">LINE 客戶清單</h3>
            <div className="flex items-center gap-1 text-xs text-gray-500">
              每頁顯示
              <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} className="border rounded px-1.5 py-1 bg-white">
                {PAGE_SIZE_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 border-b">
                <tr className="text-gray-600">
                  <th className="py-3 px-4">LINE 暱稱</th>
                  <th className="py-3 px-4">LINE User ID</th>
                  <th className="py-3 px-4">最近互動時間</th>
                  <th className="py-3 px-4">狀態</th>
                  <th className="py-3 px-4"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={5} className="py-10 text-center text-gray-400">載入中...</td></tr>
                ) : contacts.length === 0 ? (
                  <tr><td colSpan={5}><EmptyState icon={<Users className="w-12 h-12 text-gray-200" />} message="查無聯絡人" /></td></tr>
                ) : (
                  contacts.map((c) => (
                    <tr
                      key={c.line_user_id}
                      onClick={() => selectContact(c.line_user_id)}
                      className={`cursor-pointer transition-colors ${selectedId === c.line_user_id ? 'bg-green-50' : 'hover:bg-green-50'}`}
                    >
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <Avatar url={c.avatar_url} />
                          <div>
                            <div className="font-medium text-gray-800">{c.nickname || '未取得'}</div>
                            {!c.nickname && (
                              <button
                                onClick={(e) => { e.stopPropagation(); refetchNickname(c.line_user_id); }}
                                disabled={refreshingIds.has(c.line_user_id)}
                                className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 disabled:opacity-50"
                              >
                                <RefreshCcw className={`w-3 h-3 ${refreshingIds.has(c.line_user_id) ? 'animate-spin' : ''}`} />
                                {refreshingIds.has(c.line_user_id) ? '同步中' : '重新整理暱稱'}
                              </button>
                            )}
                            {refreshErrors[c.line_user_id] && <p className="text-xs text-red-500 mt-0.5">{refreshErrors[c.line_user_id]}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-4 font-mono text-xs text-gray-500">{c.line_user_id}</td>
                      <td className="py-3 px-4 text-gray-500 whitespace-nowrap">{c.last_message_at ? new Date(c.last_message_at).toLocaleString('zh-TW') : '-'}</td>
                      <td className="py-3 px-4"><ContactStatusBadge contact={c} /></td>
                      <td className="py-3 px-4 text-right text-gray-300">›</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <Pagination page={page} hasMore={hasMore} onPrev={() => runQuery(page - 1)} onNext={() => runQuery(page + 1)} />
        </div>

        <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border p-6 space-y-6 lg:sticky lg:top-6">
          {!selectedContact ? (
            <EmptyState icon={<Users className="w-12 h-12 text-gray-200" />} message="請從左側選擇一位客戶查看詳細資料" />
          ) : (
            <>
              {detailError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg flex items-center justify-between gap-2">
                  <span>{detailError}</span>
                  <button onClick={() => selectContact(selectedContact.line_user_id)} className="text-red-700 underline shrink-0">重試</button>
                </div>
              )}

              <div>
                <h4 className="font-bold text-gray-700 mb-3">客戶基本資料</h4>
                <div className="flex items-center gap-3 mb-4">
                  <Avatar url={selectedContact.avatar_url} size="w-14 h-14" />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-bold text-gray-800">{selectedContact.nickname || '未取得'}</p>
                      {!selectedContact.nickname && (
                        <button
                          onClick={() => refetchNickname(selectedContact.line_user_id)}
                          disabled={refreshingIds.has(selectedContact.line_user_id)}
                          className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 disabled:opacity-50"
                        >
                          <RefreshCcw className={`w-3 h-3 ${refreshingIds.has(selectedContact.line_user_id) ? 'animate-spin' : ''}`} />
                          {refreshingIds.has(selectedContact.line_user_id) ? '同步中' : '重新整理暱稱'}
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-gray-400">若暱稱未同步，可點擊「重新整理暱稱」重新向 LINE 取得最新資料。</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-2 text-sm">
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-gray-500">LINE User ID</span>
                    <span className="flex items-center gap-1">
                      <span className="font-mono text-xs text-gray-700 break-all">{selectedContact.line_user_id}</span>
                      <button onClick={() => copyId(selectedContact.line_user_id)} className="p-1 hover:bg-gray-100 rounded shrink-0" title="複製">
                        <Copy className="w-3.5 h-3.5 text-gray-400" />
                      </button>
                    </span>
                  </div>
                  <div className="flex justify-between"><span className="text-gray-500">最近互動時間</span><span>{selectedContact.last_message_at ? new Date(selectedContact.last_message_at).toLocaleString('zh-TW') : '-'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">第一次互動時間</span><span>{selectedContact.first_message_at ? new Date(selectedContact.first_message_at).toLocaleString('zh-TW') : '-'}</span></div>
                </div>
              </div>

              <div>
                <h4 className="font-bold text-gray-700 flex items-center gap-2 mb-2"><ClipboardList className="w-4 h-4" /> 訂單紀錄</h4>
                {detailLoading ? (
                  <p className="text-sm text-gray-400">載入中...</p>
                ) : detailBookings.length === 0 ? (
                  <p className="text-sm text-gray-400">尚無訂單紀錄</p>
                ) : (
                  <div className="space-y-2">
                    {detailBookings.map((b) => (
                      <div key={b.id} className="border rounded-lg p-3 text-sm flex justify-between items-center">
                        <div>
                          <p className="font-medium text-gray-800">{b.order_number || '（尚無編號）'}</p>
                          <p className="text-xs text-gray-500">{b.checkin_date ? String(b.checkin_date).replace(/-/g, '/') : '-'} ~ {b.checkout_date ? String(b.checkout_date).replace(/-/g, '/') : '-'}　{b.room_type_label || (b.whole_house ? '包棟' : '')}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-gray-700 mb-1">{b.total_amount != null ? `NT$ ${Number(b.total_amount).toLocaleString()}` : '-'}</p>
                          <StatusBadge status={b.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-bold text-gray-700 flex items-center gap-2"><MessageSquare className="w-4 h-4" /> 對話紀錄</h4>
                  {detailConversations.length > 0 && (
                    <button onClick={openFullConvo} className="text-xs text-green-600 hover:text-green-700">查看完整對話</button>
                  )}
                </div>
                <p className="text-xs text-gray-400 mb-2">依系統保留天數設定自動清除，可能查不到較久之前的對話。</p>
                {detailLoading ? (
                  <p className="text-sm text-gray-400">載入中...</p>
                ) : detailConversations.length === 0 ? (
                  <p className="text-sm text-gray-400">查無對話紀錄</p>
                ) : (
                  <div className="space-y-2">
                    {[...detailConversations].reverse().map((row) => (
                      <div key={row.id} className={`flex ${row.direction === 'inbound' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${row.direction === 'inbound' ? 'bg-gray-100 text-gray-800 rounded-bl-sm' : 'bg-green-600 text-white rounded-br-sm'}`}>
                          <p className="whitespace-pre-wrap break-words">{row.content}</p>
                          <p className={`text-[10px] mt-1 ${row.direction === 'inbound' ? 'text-gray-400' : 'text-green-100'}`}>{new Date(row.created_at).toLocaleString('zh-TW')}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Modal open={showFullConvo} title={`完整對話紀錄${selectedContact?.nickname ? `（${selectedContact.nickname}）` : ''}`} onClose={() => setShowFullConvo(false)} maxWidth="max-w-lg">
        {fullConvoLoading ? (
          <p className="text-sm text-gray-400">載入中...</p>
        ) : fullConvoList.length === 0 ? (
          <p className="text-sm text-gray-400">查無對話紀錄</p>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {[...fullConvoList].reverse().map((row) => (
              <div key={row.id} className={`flex ${row.direction === 'inbound' ? 'justify-start' : 'justify-end'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${row.direction === 'inbound' ? 'bg-gray-100 text-gray-800 rounded-bl-sm' : 'bg-green-600 text-white rounded-br-sm'}`}>
                  <p className="whitespace-pre-wrap break-words">{row.content}</p>
                  <p className={`text-[10px] mt-1 ${row.direction === 'inbound' ? 'text-gray-400' : 'text-green-100'}`}>{new Date(row.created_at).toLocaleString('zh-TW')}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

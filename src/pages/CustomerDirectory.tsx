import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Users, Search, MessageSquare, ClipboardList, BadgeInfo, Copy, RefreshCcw } from 'lucide-react';
import { PageHeader, Button, Modal, StatusBadge, EmptyState } from '../components/ui';

const STATUS_LABEL: Record<string, string> = {
  inquiring: '待報價',
  pending_confirmation: '待確認',
  confirmed: '已確認',
  cancelled: '已取消',
  pending_manual_conflict: '待人工確認',
};

interface Contact {
  line_user_id: string;
  nickname: string;
  pictureUrl: string;
  statusMessage: string;
  bookingCount: number;
  latestStatus: string | null;
  totalSpend: number;
}

type LookupType = 'basic' | 'live' | 'summary';

const LOOKUP_TYPE_OPTIONS: { value: LookupType; label: string }[] = [
  { value: 'basic', label: '基本資訊（LINE 暱稱＋LINE User ID）' },
  { value: 'live', label: '即時大頭貼與狀態消息（重新呼叫 LINE API）' },
  { value: 'summary', label: '互動與訂單摘要' },
];

async function callFunction(name: string, body: any) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '查詢失敗');
  return result;
}

export default function CustomerDirectory() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [queryError, setQueryError] = useState('');
  const [contactsMeta, setContactsMeta] = useState<{ totalFollowers: number; truncated: boolean } | null>(null);

  const [selected, setSelected] = useState<Contact | null>(null);
  const [selectedBookings, setSelectedBookings] = useState<any[]>([]);
  const [selectedConversations, setSelectedConversations] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [lookupUserId, setLookupUserId] = useState('');
  const [lookupType, setLookupType] = useState<LookupType>('basic');
  const [lookupResult, setLookupResult] = useState<any>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchContacts();
  }, []);

  // 直接打 LINE API 取得聯絡人清單：先抓所有加官方帳號好友的 userId，
  // 再逐一查暱稱/大頭貼，不依賴本地資料庫是否已同步過這些使用者。
  const fetchContacts = async () => {
    setLoading(true);
    setQueryError('');
    try {
      const result = await callFunction('line-contacts', {});
      const lineContacts: { userId: string; displayName: string; pictureUrl: string; statusMessage: string }[] = result.contacts || [];
      setContactsMeta({ totalFollowers: result.totalFollowers ?? lineContacts.length, truncated: !!result.truncated });

      const userIds = lineContacts.map((c) => c.userId);
      let bookingsByUser: Record<string, any[]> = {};
      if (userIds.length) {
        const { data: bookings, error: bookingsError } = await supabase.from('bookings').select('*').in('line_user_id', userIds).order('created_at', { ascending: false });
        if (bookingsError) setQueryError(`查詢訂單統計失敗：${bookingsError.message}`);
        for (const b of bookings || []) {
          if (!bookingsByUser[b.line_user_id]) bookingsByUser[b.line_user_id] = [];
          bookingsByUser[b.line_user_id].push(b);
        }
      }

      const merged: Contact[] = lineContacts.map((c) => {
        const bookings = bookingsByUser[c.userId] || [];
        const totalSpend = bookings.filter((b) => b.status === 'confirmed').reduce((sum, b) => sum + (b.total_amount || 0), 0);
        return {
          line_user_id: c.userId,
          nickname: c.displayName || '未取得暱稱',
          pictureUrl: c.pictureUrl,
          statusMessage: c.statusMessage,
          bookingCount: bookings.length,
          latestStatus: bookings[0]?.status ?? null,
          totalSpend,
        };
      });
      setContacts(merged);
    } catch (e: any) {
      setQueryError(`查詢聯絡人失敗：${e.message}`);
      setContacts([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredContacts = useMemo(() => {
    if (!search.trim()) return contacts;
    const kw = search.trim().toLowerCase();
    return contacts.filter((c) => c.nickname.toLowerCase().includes(kw));
  }, [contacts, search]);

  const runLookup = async () => {
    if (!lookupUserId) {
      setLookupError('請先選擇一位聯絡人');
      return;
    }
    const contact = contacts.find((c) => c.line_user_id === lookupUserId);
    if (!contact) return;

    setLookupLoading(true);
    setLookupError('');
    setLookupResult(null);
    setCopied(false);
    try {
      if (lookupType === 'basic') {
        setLookupResult({ type: 'basic', nickname: contact.nickname, lineUserId: contact.line_user_id });
      } else if (lookupType === 'summary') {
        setLookupResult({ type: 'summary', ...contact });
      } else {
        const profile = await callFunction('line-profile', { lineUserId: lookupUserId });
        setLookupResult({ type: 'live', ...profile });
      }
    } catch (e: any) {
      setLookupError(e.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const copyLookupId = () => {
    const id = lookupResult?.lineUserId || lookupResult?.userId || lookupUserId;
    if (!id) return;
    navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const openDetail = async (contact: Contact) => {
    setSelected(contact);
    setDetailLoading(true);
    const [{ data: bookings }, { data: conversations }] = await Promise.all([
      supabase.from('bookings').select('*').eq('line_user_id', contact.line_user_id).order('created_at', { ascending: false }),
      supabase.from('conversations').select('*').eq('line_user_id', contact.line_user_id).order('created_at', { ascending: false }).limit(30),
    ]);
    setSelectedBookings(bookings || []);
    setSelectedConversations(conversations || []);
    setDetailLoading(false);
  };

  const closeDetail = () => {
    setSelected(null);
    setSelectedBookings([]);
    setSelectedConversations([]);
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        icon={<Users className="w-6 h-6 text-green-600" />}
        title="客戶資料"
        description="直接向 LINE 讀取目前加官方帳號好友的聯絡人，點列查看訂單與對話紀錄。"
        action={
          <button onClick={fetchContacts} className="p-2 hover:bg-gray-100 rounded-lg" title="重新從 LINE 讀取聯絡人清單">
            <RefreshCcw className="w-5 h-5 text-gray-400" />
          </button>
        }
      />

      {queryError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">{queryError}</div>
      )}
      {contactsMeta?.truncated && (
        <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-xl">
          目前官方帳號好友數（{contactsMeta.totalFollowers}）超過單次查詢上限，僅顯示前 500 位。
        </div>
      )}

      <div className="bg-white p-6 rounded-xl shadow-sm border space-y-3">
        <h3 className="font-bold text-gray-800 flex items-center gap-2"><BadgeInfo className="w-5 h-5 text-green-600" />LINE 資訊查詢</h3>
        <p className="text-xs text-gray-400">
          LINE 官方 API 不支援用名字搜尋任何用戶，只能查已經加過官方帳號好友的聯絡人。從下面選一位聯絡人，再選要查的資訊類型。
        </p>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[220px]">
            <label className="block text-xs text-gray-500 mb-1">選擇聯絡人</label>
            <select value={lookupUserId} onChange={(e) => setLookupUserId(e.target.value)} className="w-full px-3 py-2 border rounded-lg bg-white text-sm">
              <option value="">請選擇...</option>
              {contacts.map((c) => (
                <option key={c.line_user_id} value={c.line_user_id}>
                  {c.nickname}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[260px]">
            <label className="block text-xs text-gray-500 mb-1">查詢類型</label>
            <select value={lookupType} onChange={(e) => setLookupType(e.target.value as LookupType)} className="w-full px-3 py-2 border rounded-lg bg-white text-sm">
              {LOOKUP_TYPE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <Button onClick={runLookup} loading={lookupLoading} icon={<Search className="w-4 h-4" />}>查詢</Button>
        </div>

        {lookupError && <p className="text-sm text-red-600">{lookupError}</p>}

        {lookupResult && (
          <div className="border rounded-lg p-4 bg-gray-50 text-sm space-y-2">
            {lookupResult.type === 'basic' && (
              <>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">LINE 暱稱</span>
                  <span className="font-medium text-gray-800">{lookupResult.nickname || '未取得'}</span>
                </div>
                <div className="flex justify-between items-center gap-2">
                  <span className="text-gray-500">LINE User ID</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-gray-700">{lookupResult.lineUserId}</span>
                    <button onClick={copyLookupId} className="p-1 hover:bg-gray-200 rounded" title="複製">
                      <Copy className="w-3.5 h-3.5 text-gray-500" />
                    </button>
                    {copied && <span className="text-xs text-green-600">已複製</span>}
                  </span>
                </div>
              </>
            )}
            {lookupResult.type === 'summary' && (
              <>
                <div className="flex justify-between"><span className="text-gray-500">LINE 暱稱</span><span className="font-medium text-gray-800">{lookupResult.nickname || '未取得'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">狀態消息</span><span>{lookupResult.statusMessage || '-'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">累積訂單數</span><span>{lookupResult.bookingCount}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">最近訂單狀態</span><span>{lookupResult.latestStatus ? STATUS_LABEL[lookupResult.latestStatus] || lookupResult.latestStatus : '-'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">累積消費（已確認）</span><span>{lookupResult.totalSpend > 0 ? `NT$ ${lookupResult.totalSpend.toLocaleString()}` : '-'}</span></div>
              </>
            )}
            {lookupResult.type === 'live' && (
              <>
                <div className="flex items-center gap-3">
                  {lookupResult.pictureUrl ? (
                    <img src={lookupResult.pictureUrl} alt="" className="w-12 h-12 rounded-full object-cover" />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-gray-200" />
                  )}
                  <div>
                    <p className="font-medium text-gray-800">{lookupResult.displayName}</p>
                    <p className="text-xs text-gray-500">{lookupResult.statusMessage || '（未設定狀態消息）'}</p>
                  </div>
                </div>
                <div className="flex justify-between items-center gap-2 pt-2 border-t">
                  <span className="text-gray-500">LINE User ID</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs text-gray-700">{lookupResult.userId}</span>
                    <button onClick={copyLookupId} className="p-1 hover:bg-gray-200 rounded" title="複製">
                      <Copy className="w-3.5 h-3.5 text-gray-500" />
                    </button>
                    {copied && <span className="text-xs text-green-600">已複製</span>}
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="bg-white p-4 rounded-xl shadow-sm border flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="在目前清單中搜尋 LINE 暱稱"
          className="flex-1 px-4 py-2 border rounded-lg"
        />
        <Button onClick={fetchContacts} loading={loading} icon={<RefreshCcw className="w-4 h-4" />}>重新讀取</Button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">LINE 暱稱</th>
                <th className="py-3 px-4">狀態消息</th>
                <th className="py-3 px-4">訂單數</th>
                <th className="py-3 px-4">最近訂單狀態</th>
                <th className="py-3 px-4">累積消費（已確認）</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="py-10 text-center text-gray-400">向 LINE 讀取聯絡人中...</td></tr>
              ) : filteredContacts.length === 0 ? (
                <tr><td colSpan={5}><EmptyState icon={<Users className="w-12 h-12 text-gray-200" />} message="查無聯絡人" /></td></tr>
              ) : (
                filteredContacts.map((c) => (
                  <tr key={c.line_user_id} onClick={() => openDetail(c)} className="hover:bg-green-50 transition-colors cursor-pointer">
                    <td className="py-3 px-4 font-medium text-gray-800 flex items-center gap-2">
                      {c.pictureUrl ? (
                        <img src={c.pictureUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-gray-200" />
                      )}
                      {c.nickname}
                    </td>
                    <td className="py-3 px-4 text-gray-500">{c.statusMessage || '-'}</td>
                    <td className="py-3 px-4">{c.bookingCount}</td>
                    <td className="py-3 px-4">{c.latestStatus ? <StatusBadge status={c.latestStatus} /> : <span className="text-gray-400">-</span>}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{c.totalSpend > 0 ? `NT$ ${c.totalSpend.toLocaleString()}` : '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={!!selected}
        title={selected?.nickname || '未取得'}
        onClose={closeDetail}
        maxWidth="max-w-2xl"
      >
        {selected && (
          <>
            <p className="text-xs text-gray-400 font-mono -mt-4">{selected.line_user_id}</p>

            <div>
              <h4 className="font-bold text-gray-700 flex items-center gap-2 mb-2"><ClipboardList className="w-4 h-4" /> 訂單紀錄</h4>
              {detailLoading ? (
                <p className="text-sm text-gray-400">載入中...</p>
              ) : selectedBookings.length === 0 ? (
                <p className="text-sm text-gray-400">尚無訂單紀錄</p>
              ) : (
                <div className="space-y-2">
                  {selectedBookings.map((b) => (
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
              <h4 className="font-bold text-gray-700 flex items-center gap-2 mb-2"><MessageSquare className="w-4 h-4" /> 最近對話紀錄</h4>
              <p className="text-xs text-gray-400 mb-2">依系統保留天數設定自動清除，可能查不到較久之前的對話。</p>
              {detailLoading ? (
                <p className="text-sm text-gray-400">載入中...</p>
              ) : selectedConversations.length === 0 ? (
                <p className="text-sm text-gray-400">查無對話紀錄</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {selectedConversations.map((row) => (
                    <div key={row.id} className={`text-sm p-2 rounded-lg ${row.direction === 'inbound' ? 'bg-blue-50' : 'bg-gray-50'}`}>
                      <div className="flex justify-between text-xs text-gray-400 mb-0.5">
                        <span>{row.direction === 'inbound' ? '收到' : '回覆'}</span>
                        <span>{new Date(row.created_at).toLocaleString('zh-TW')}</span>
                      </div>
                      <p className="text-gray-700 whitespace-pre-wrap break-words">{row.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

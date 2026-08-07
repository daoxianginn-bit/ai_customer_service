import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Users, Search, X, MessageSquare, ClipboardList } from 'lucide-react';

const STATUS_LABEL: Record<string, string> = {
  inquiring: '待報價',
  pending_confirmation: '待確認',
  confirmed: '已確認',
  cancelled: '已取消',
  pending_manual_conflict: '待人工確認',
};

const MAX_CONTACTS = 200;

interface Contact {
  line_user_id: string;
  nickname: string | null;
  last_message_at: string | null;
  bookingCount: number;
  latestStatus: string | null;
  totalSpend: number;
}

export default function CustomerDirectory() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [selected, setSelected] = useState<Contact | null>(null);
  const [selectedBookings, setSelectedBookings] = useState<any[]>([]);
  const [selectedConversations, setSelectedConversations] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    runQuery();
  }, []);

  const runQuery = async () => {
    setLoading(true);
    let query = supabase
      .from('user_states')
      .select('line_user_id, nickname, last_message_at')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(MAX_CONTACTS);
    if (search.trim()) query = query.ilike('nickname', `%${search.trim()}%`);

    const { data: states } = await query;
    const userIds = (states || []).map((s: any) => s.line_user_id);

    let bookingsByUser: Record<string, any[]> = {};
    if (userIds.length) {
      const { data: bookings } = await supabase.from('bookings').select('*').in('line_user_id', userIds).order('created_at', { ascending: false });
      for (const b of bookings || []) {
        if (!bookingsByUser[b.line_user_id]) bookingsByUser[b.line_user_id] = [];
        bookingsByUser[b.line_user_id].push(b);
      }
    }

    const merged: Contact[] = (states || []).map((s: any) => {
      const bookings = bookingsByUser[s.line_user_id] || [];
      const totalSpend = bookings.filter((b) => b.status === 'confirmed').reduce((sum, b) => sum + (b.total_amount || 0), 0);
      return {
        line_user_id: s.line_user_id,
        nickname: s.nickname,
        last_message_at: s.last_message_at,
        bookingCount: bookings.length,
        latestStatus: bookings[0]?.status ?? null,
        totalSpend,
      };
    });
    setContacts(merged);
    setLoading(false);
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
      <div className="bg-white p-6 rounded-xl shadow-sm border">
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          <Users className="w-6 h-6 text-blue-600" />
          客戶資料
        </h2>
        <p className="text-gray-500 mt-1">所有跟 LINE 官方帳號互動過的聯絡人，點列查看訂單與對話紀錄。</p>
      </div>

      <div className="bg-white p-4 rounded-xl shadow-sm border flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runQuery()}
          placeholder="搜尋 LINE 暱稱"
          className="flex-1 px-4 py-2 border rounded-lg"
        />
        <button onClick={runQuery} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700">
          <Search className="w-4 h-4" /> 搜尋
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4">LINE 暱稱</th>
                <th className="py-3 px-4">最近互動時間</th>
                <th className="py-3 px-4">訂單數</th>
                <th className="py-3 px-4">最近訂單狀態</th>
                <th className="py-3 px-4">累積消費（已確認）</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : contacts.length === 0 ? (
                <tr><td colSpan={5} className="py-16 text-center text-gray-400">查無聯絡人</td></tr>
              ) : (
                contacts.map((c) => (
                  <tr key={c.line_user_id} onClick={() => openDetail(c)} className="hover:bg-blue-50 transition-colors cursor-pointer">
                    <td className="py-3 px-4 font-medium text-gray-800">{c.nickname || '未取得'}</td>
                    <td className="py-3 px-4 text-gray-500">{c.last_message_at ? new Date(c.last_message_at).toLocaleString('zh-TW') : '-'}</td>
                    <td className="py-3 px-4">{c.bookingCount}</td>
                    <td className="py-3 px-4">{c.latestStatus ? STATUS_LABEL[c.latestStatus] || c.latestStatus : '-'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{c.totalSpend > 0 ? `NT$ ${c.totalSpend.toLocaleString()}` : '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-6 border-b">
              <div>
                <h3 className="text-lg font-bold text-gray-800">{selected.nickname || '未取得'}</h3>
                <p className="text-xs text-gray-400 font-mono">{selected.line_user_id}</p>
              </div>
              <button onClick={closeDetail} className="p-1 text-gray-400 hover:text-gray-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="p-6 space-y-6">
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
                          <p className="text-gray-700">{b.total_amount != null ? `NT$ ${Number(b.total_amount).toLocaleString()}` : '-'}</p>
                          <p className="text-xs text-gray-400">{STATUS_LABEL[b.status] || b.status}</p>
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

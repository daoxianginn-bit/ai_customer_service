import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { UserPlus, Trash2, Users } from 'lucide-react';
import { PageHeader, Button, EmptyState, ConfirmDialog } from '../components/ui';

type Admin = {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  invited: boolean;
};

async function callFn(path: string, options: RequestInit = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`/.netlify/functions/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${session?.access_token}`,
    },
  });
  const text = await res.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!res.ok) throw new Error(body.message || text || '操作失敗');
  return body;
}

export default function AdminAccounts() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Admin | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchAdmins();
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id || null));
  }, []);

  const fetchAdmins = async () => {
    setLoading(true);
    try {
      const { admins } = await callFn('list-admins', { method: 'GET' });
      setAdmins(admins || []);
    } catch (err: any) {
      console.error('Failed to load admins:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleInvite = async () => {
    if (!email.trim()) {
      alert('請輸入 Email');
      return;
    }
    setInviting(true);
    try {
      await callFn('invite-admin', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
      alert('邀請信已寄出！');
      setEmail('');
      fetchAdmins();
    } catch (err: any) {
      alert(`邀請失敗：${err.message}`);
    } finally {
      setInviting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await callFn('delete-admin', { method: 'POST', body: JSON.stringify({ userId: deleteTarget.id }) });
      setDeleteTarget(null);
      fetchAdmins();
    } catch (err: any) {
      alert(`移除失敗：${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <PageHeader icon={<Users className="w-6 h-6 text-green-600" />} title="帳號管理" description="邀請其他管理員登入後台，或移除不再需要的帳號" />

      <div className="bg-white p-6 rounded-xl shadow-sm border space-y-3">
        <h3 className="font-bold text-gray-800">邀請新管理員</h3>
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            className="flex-1 px-4 py-2 border rounded-lg"
          />
          <Button onClick={handleInvite} loading={inviting} icon={<UserPlus className="w-4 h-4" />}>
            {inviting ? '寄送中...' : '寄送邀請'}
          </Button>
        </div>
        <p className="text-xs text-gray-400">對方會收到 Supabase 寄出的邀請信，點擊連結設定密碼後即可登入。</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50 border-b">
              <tr className="text-sm font-semibold text-gray-600">
                <th className="py-4 px-6">Email</th>
                <th className="py-4 px-6">狀態</th>
                <th className="py-4 px-6">最後登入</th>
                <th className="py-4 px-6">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={4} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : admins.length === 0 ? (
                <tr><td colSpan={4}><EmptyState icon={<Users className="w-12 h-12 text-gray-200" />} message="尚無管理員帳號" /></td></tr>
              ) : (
                admins.map((admin) => (
                  <tr key={admin.id} className="hover:bg-gray-50 transition-colors">
                    <td className="py-4 px-6 font-medium text-gray-800">
                      {admin.email}
                      {admin.id === currentUserId && <span className="ml-2 text-xs text-green-600">(你)</span>}
                    </td>
                    <td className="py-4 px-6">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${admin.invited ? 'bg-yellow-100 text-yellow-700' : 'bg-green-100 text-green-700'}`}>
                        {admin.invited ? '邀請中' : '已啟用'}
                      </span>
                    </td>
                    <td className="py-4 px-6 text-sm text-gray-500">{admin.last_sign_in_at ? new Date(admin.last_sign_in_at).toLocaleString('zh-TW') : '尚未登入'}</td>
                    <td className="py-4 px-6">
                      <button
                        onClick={() => setDeleteTarget(admin)}
                        disabled={admin.id === currentUserId}
                        className="p-2 hover:bg-red-50 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
                        title="移除"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="移除管理員"
        message={`確定要移除 ${deleteTarget?.email} 的登入權限嗎？`}
        confirmLabel="移除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

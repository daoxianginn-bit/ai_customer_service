import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { UserPlus, Trash2, Users } from 'lucide-react';
import { PageHeader, Button, EmptyState, ConfirmDialog, Modal } from '../components/ui';

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
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [primaryAdminId, setPrimaryAdminId] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [showInvite, setShowInvite] = useState(false);

  useEffect(() => {
    fetchAdmins();
    fetchPrimaryAdmin();
    supabase.auth.getUser().then(({ data }) => setCurrentUserId(data.user?.id || null));
  }, []);

  const fetchPrimaryAdmin = async () => {
    const { data } = await supabase.from('settings').select('id, primary_admin_id').single();
    setSettingsId(data?.id || null);
    setPrimaryAdminId(data?.primary_admin_id || null);
  };

  // 還沒有人設定主帳號時，任何一個登入的管理員都可以先搶認（bootstrap）；
  // 已經有主帳號之後，這裡不提供「轉讓」功能，避免其他人隨便把主帳號換成自己。
  const claimPrimary = async () => {
    if (!settingsId || !currentUserId) return;
    setClaiming(true);
    try {
      await supabase.from('settings').update({ primary_admin_id: currentUserId }).eq('id', settingsId).is('primary_admin_id', null);
      await fetchPrimaryAdmin();
    } finally {
      setClaiming(false);
    }
  };

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
      setShowInvite(false);
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
      <PageHeader
        icon={<Users className="w-6 h-6 text-green-600" />}
        title="帳號管理"
        description="邀請其他管理員登入後台，或移除不再需要的帳號"
        action={<Button onClick={() => setShowInvite(true)} icon={<UserPlus className="w-4 h-4" />}>邀請新管理員</Button>}
      />

      {!primaryAdminId && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm px-4 py-3 rounded-xl flex items-center justify-between gap-3">
          <span>目前還沒有設定「主帳號」，任何管理員都能移除其他人的帳號。建議由老闆／管理者本人設定主帳號，之後這個帳號就不能被其他人移除。</span>
          <Button onClick={claimPrimary} loading={claiming}>{claiming ? '設定中...' : '將我設為主帳號'}</Button>
        </div>
      )}

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
                      {admin.id === primaryAdminId && <span className="ml-2 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">主帳號</span>}
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
                        disabled={admin.id === currentUserId || admin.id === primaryAdminId}
                        className="p-2 hover:bg-red-50 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed"
                        title={admin.id === primaryAdminId ? '主帳號不能被移除' : '移除'}
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

      <Modal
        open={showInvite}
        title="邀請新管理員"
        onClose={() => setShowInvite(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowInvite(false)}>取消</Button>
            <Button onClick={handleInvite} loading={inviting} icon={<UserPlus className="w-4 h-4" />}>{inviting ? '寄送中...' : '寄送邀請'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@example.com"
            className="w-full px-4 py-2 border rounded-lg"
          />
        </div>
        <p className="text-xs text-gray-400">對方會收到 Supabase 寄出的邀請信，點擊連結設定密碼後即可登入。</p>
      </Modal>
    </div>
  );
}

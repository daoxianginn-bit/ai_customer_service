import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Settings, Lock, CheckCircle2 } from 'lucide-react';

// ========================================================================
// 邀請信／重設密碼信點進來的落地頁。
//
// 為什麼需要獨立一頁：被邀請的人點開信件連結時，Supabase 會直接給他一個有效 session，
// 但他其實還沒有密碼。如果直接把他丟進後台首頁，他這次進得去、下次卻永遠登入不了
// （不知道密碼、也沒設過）。所以要在這裡強制先設定密碼再進系統。
//
// 這一頁刻意放在登入守衛之外：此時使用者已經有 session，但我們不希望他在設好密碼前
// 就被導進後台。
// ========================================================================

const MIN_LENGTH = 8;

export default function SetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [checking, setChecking] = useState(true);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    // supabase-js 會自動解析網址上的 #access_token=... 建立 session，但那是非同步的，
    // 所以這裡等 onAuthStateChange 或直接查一次，不能只在第一個 render 判斷。
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setHasSession(!!data.session);
      setChecking(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (cancelled) return;
      setHasSession(!!session);
      setChecking(false);
    });

    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_LENGTH) {
      setError(`密碼至少需要 ${MIN_LENGTH} 個字元`);
      return;
    }
    if (password !== confirm) {
      setError('兩次輸入的密碼不一致');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
      // 密碼設定成功後 session 仍然有效，直接進後台不用再登入一次
      setTimeout(() => navigate('/', { replace: true }), 1500);
    } catch (err: any) {
      setError(err.message || '設定密碼失敗，請稍後再試。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-100 p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="bg-green-600 p-3 rounded-xl shadow-lg shadow-green-200 mb-4">
            <Settings className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">設定您的密碼</h1>
          <p className="text-gray-500 text-sm mt-1 text-center">
            設定完成後就能登入 AI 客服後台
          </p>
        </div>

        {checking ? (
          <p className="text-center text-gray-400 text-sm py-8">驗證邀請連結中...</p>
        ) : done ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="w-12 h-12 text-green-600" />
            <p className="text-gray-700 font-medium">密碼設定完成，正在進入後台...</p>
          </div>
        ) : !hasSession ? (
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm leading-relaxed">
              這個邀請連結已經失效或已經使用過了。邀請連結有時效性，請聯繫管理員重新寄一次。
            </div>
            <button
              onClick={() => navigate('/login', { replace: true })}
              className="w-full bg-green-600 text-white py-3 rounded-xl font-bold hover:bg-green-700 transition-all"
            >
              回到登入頁
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">新密碼</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="password"
                  required
                  autoFocus
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:bg-white outline-none transition-all"
                  placeholder={`至少 ${MIN_LENGTH} 個字元`}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1.5">再輸入一次</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="password"
                  required
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:bg-white outline-none transition-all"
                  placeholder="再輸入一次相同的密碼"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg text-red-600 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={saving}
              className="w-full bg-green-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-green-100 hover:bg-green-700 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
            >
              {saving ? '設定中...' : '設定密碼並進入後台'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

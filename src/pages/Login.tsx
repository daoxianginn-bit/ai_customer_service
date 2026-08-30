import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import { Settings, Lock, Mail, ChevronDown } from 'lucide-react';

// Google 官方品牌配色的 G 標誌。用 inline SVG 而不是外部圖檔，避免登入頁多一個網路請求
// （登入頁載不出圖等於使用者看不到可以按的東西）。
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="w-5 h-5" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function Login() {
  const { blockedReason, clearBlockedReason } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPasswordLogin, setShowPasswordLogin] = useState(false);

  const handleGoogleLogin = async () => {
    setGoogleLoading(true);
    setError(null);
    clearBlockedReason();
    try {
      // 導到 Google 授權頁，授權完成後 Supabase 會帶著 session 導回本站首頁。
      // 核准與否的判斷不在這裡做——導回來之後由 AuthContext 統一檢查（見該檔說明）。
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
    } catch (err: any) {
      setError(err.message || 'Google 登入失敗，請稍後再試。');
      setGoogleLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    clearBlockedReason();

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    } catch (err: any) {
      setError(err.message || '登入失敗，請檢查帳號密碼。');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f8fafc] p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-100 p-8">
        <div className="flex flex-col items-center mb-8">
          <div className="bg-green-600 p-3 rounded-xl shadow-lg shadow-green-200 mb-4">
            <Settings className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">AI 客服後台</h1>
          <p className="text-gray-500 text-sm mt-1">請登入以繼續</p>
        </div>

        {/* 被擋下來的原因（待審核／已停用）要跟一般登入錯誤分開呈現：
            這不是「你打錯了」，而是「帳號建立成功、但還不能用」，用不同顏色避免使用者反覆重試密碼。 */}
        {blockedReason && (
          <div className="mb-5 p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
            {blockedReason}
          </div>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={googleLoading}
          className="w-full flex items-center justify-center gap-3 border border-gray-300 bg-white text-gray-700 py-3 rounded-xl font-semibold hover:bg-gray-50 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
        >
          <GoogleIcon />
          {googleLoading ? '前往 Google 驗證中...' : '使用 Google 登入'}
        </button>

        <p className="text-xs text-gray-400 text-center mt-3 leading-relaxed">
          第一次使用請直接用 Google 登入建立帳號，<br />建立後需由管理員核准才能進入後台。
        </p>

        {error && (
          <div className="mt-5 p-3 bg-red-50 border border-red-100 rounded-lg text-red-600 text-sm">
            {error}
          </div>
        )}

        {/* Email 密碼登入保留為備援：萬一 Google OAuth 設定失效（金鑰過期、網域改動），
            Google 這條路會整個不能用。若沒有第二條路，連老闆自己都會被鎖在系統外面、
            也沒有人能進去修設定。平常不需要用到，所以收在這個折疊區裡不干擾主流程。 */}
        <div className="mt-6 pt-5 border-t border-gray-100">
          <button
            onClick={() => setShowPasswordLogin((v) => !v)}
            className="w-full flex items-center justify-center gap-1 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            使用 Email 密碼登入（備援）
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showPasswordLogin ? 'rotate-180' : ''}`} />
          </button>

          {showPasswordLogin && (
            <form onSubmit={handleLogin} className="space-y-4 mt-5">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">電子郵件</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="email"
                    required
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:bg-white outline-none transition-all"
                    placeholder="admin@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1.5">密碼</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="password"
                    required
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-green-500 focus:bg-white outline-none transition-all"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-green-600 text-white py-3 rounded-xl font-bold shadow-lg shadow-green-100 hover:bg-green-700 active:scale-[0.98] transition-all disabled:opacity-50 disabled:pointer-events-none"
              >
                {loading ? '驗證中...' : '立即登入'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

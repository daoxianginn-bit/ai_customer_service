import { useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/AuthContext';
import IsolatedLayout from '../components/IsolatedLayout';

// Google 官方品牌配色的 G 標誌。用 inline SVG 而不是外部圖檔，
// 避免登入頁多一個網路請求（圖載不出來等於使用者看不到可以按的東西）。
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export default function Login() {
  const { blockedReason, clearBlockedReason } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setLoading(true);
    setError(null);
    clearBlockedReason();
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + '/login' },
      });
      if (error) throw error;
    } catch (err: any) {
      setError(err.message || 'Google 登入失敗，請稍後再試。');
      setLoading(false);
    }
  };

  return (
    <IsolatedLayout title="AI 客服後台" subtitle="請使用管理員為您建立的 Google 帳號登入">
      <Stack spacing={2.5}>
        {/* 被擋下來的原因（未受邀請／已停權）跟一般登入錯誤分開呈現：
            這不是「你操作錯了」，而是「帳號本身還不能用」，避免使用者反覆重試。 */}
        {blockedReason && <Alert severity="warning">{blockedReason}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}

        <Button
          variant="outlined"
          size="large"
          fullWidth
          startIcon={<GoogleIcon />}
          onClick={handleGoogleLogin}
          disabled={loading}
          sx={{ py: 1.4, color: 'text.primary', borderColor: 'divider' }}
        >
          {loading ? '前往 Google 驗證中...' : '使用 Google 登入'}
        </Button>

        <Typography variant="caption" color="text.secondary" textAlign="center" sx={{ lineHeight: 1.8 }}>
          本系統不開放自行註冊。<br />
          需要帳號請聯繫管理員，收到邀請信後即可登入。
        </Typography>
      </Stack>
    </IsolatedLayout>
  );
}

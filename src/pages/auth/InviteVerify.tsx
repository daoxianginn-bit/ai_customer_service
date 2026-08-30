import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Button, Chip, CircularProgress, Stack, Typography } from '@mui/material';
import { supabase } from '../../lib/supabase';
import IsolatedLayout from '../../components/IsolatedLayout';

// ========================================================================
// 邀請確認頁（/auth/invite-verify?token=...）。
//
// 使用者點開邀請信會先到這裡。這一頁的職責只有兩件事：
//   1. 用邀請碼向後端確認「這張邀請是有效的」，並顯示邀請內容讓對方確認是給自己的
//   2. 引導他用 Google 登入完成身分驗證
//
// 【為什麼要先登出】
// Supabase 的邀請信連結點開後會自動建立一個「email 類型」的 session。
// 那只證明「這個人收得到這封信」，不是規格要求的 Google 身分核對。
// 留著它會讓使用者以為已經登入完成，所以進到這頁就先清掉，
// 強制走 Google OAuth。（收信這一步仍有價值：它讓 Supabase 標記 email 已驗證，
// 之後的 Google 身分連結才會走在官方支援的路徑上。）
// ========================================================================

interface InviteInfo {
  valid: boolean;
  maskedEmail?: string;
  roleLabel?: string;
  reason?: string;
}

export default function InviteVerify() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // 清掉信件連結帶進來的 email session（見檔頭說明）
      await supabase.auth.signOut();

      if (!token) {
        if (!cancelled) { setInfo({ valid: false, reason: '這個連結缺少邀請碼。' }); setLoading(false); }
        return;
      }

      try {
        const res = await fetch(`/.netlify/functions/invite-verify?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo({ valid: false, reason: '無法確認邀請狀態，請稍後再試。' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [token]);

  const handleGoogleLogin = async () => {
    setSigningIn(true);
    setError(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        // 導回登入頁：AuthContext 會在那裡自動比對邀請名單、建立權限，
        // 再依狀態把人帶去 2FA 綁定頁。不需要在網址上再帶邀請碼。
        options: { redirectTo: `${window.location.origin}/login` },
      });
      if (error) throw error;
    } catch (e: any) {
      setError(e.message || 'Google 登入失敗，請稍後再試。');
      setSigningIn(false);
    }
  };

  if (loading) {
    return (
      <IsolatedLayout title="確認邀請中">
        <Stack alignItems="center" spacing={2} sx={{ py: 3 }}>
          <CircularProgress size={28} />
        </Stack>
      </IsolatedLayout>
    );
  }

  if (!info?.valid) {
    return (
      <IsolatedLayout title="邀請無法使用">
        <Stack spacing={2}>
          <Alert severity="warning">{info?.reason || '這個邀請連結無效或已經失效。'}</Alert>
          <Button variant="outlined" href="/login">回到登入頁</Button>
        </Stack>
      </IsolatedLayout>
    );
  }

  return (
    <IsolatedLayout
      title="您受邀加入後台"
      subtitle="請用受邀的 Google 帳號登入以完成身分驗證"
    >
      <Stack spacing={2.5}>
        <Stack
          spacing={1.5}
          sx={{ bgcolor: 'action.hover', borderRadius: 2, p: 2 }}
        >
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">受邀帳號</Typography>
            <Typography variant="body2" fontWeight={600}>{info.maskedEmail}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="body2" color="text.secondary">您的角色</Typography>
            <Chip label={info.roleLabel} size="small" color="primary" />
          </Stack>
        </Stack>

        <Alert severity="info" sx={{ fontSize: 13 }}>
          必須使用<strong>與邀請相同的 Google 帳號</strong>登入。
          登入後還需要綁定 Google Authenticator 才能開始使用。
        </Alert>

        {error && <Alert severity="error">{error}</Alert>}

        <Button variant="contained" size="large" onClick={handleGoogleLogin} disabled={signingIn}>
          {signingIn ? '前往 Google 驗證中...' : '使用 Google 登入'}
        </Button>
      </Stack>
    </IsolatedLayout>
  );
}

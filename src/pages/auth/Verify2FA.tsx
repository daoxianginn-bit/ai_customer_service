import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, CircularProgress, Link, Stack, Typography } from '@mui/material';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/AuthContext';
import IsolatedLayout from '../../components/IsolatedLayout';
import OtpInput from '../../components/OtpInput';

// ========================================================================
// 日常登入的 2FA 驗證頁（/auth/verify-2fa）。
//
// 使用者已經通過 Google 登入（aal1），也已經綁定過驗證器，
// 這一頁負責把 session 升級到 aal2——在那之前 RLS 一張表都不會放行。
// ========================================================================

async function callMfa(action: string, extra: Record<string, any> = {}) {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/.netlify/functions/mfa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
}

function formatRemaining(lockedUntil: string): string {
  const ms = new Date(lockedUntil).getTime() - Date.now();
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes} 分鐘`;
}

export default function Verify2FA() {
  const navigate = useNavigate();
  const { profile, refresh, signOut } = useAuth();

  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);

  // 進頁面先問後端目前有沒有被鎖，避免使用者連續打了半天才被告知已鎖定
  const checkLock = useCallback(async () => {
    const state = await callMfa('check-lock');
    if (state?.locked) setLockedUntil(state.lockedUntil);
    else setLockedUntil(null);
  }, []);

  useEffect(() => { checkLock(); }, [checkLock]);

  const handleVerify = async (code: string) => {
    if (lockedUntil) return;
    setVerifying(true);
    setError(null);
    try {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const totp = (factors?.totp || []).find((f) => f.status === 'verified');
      if (!totp) throw new Error('找不到已綁定的驗證器，請聯繫管理員為您重置雙因素驗證。');

      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: totp.id });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: totp.id,
        challengeId: challenge.id,
        code,
      });

      if (verifyError) {
        // 記一次失敗；達門檻後端會回傳鎖定狀態
        const state = await callMfa('record-failure');
        if (state?.locked) {
          setLockedUntil(state.lockedUntil);
          setError(null);
        } else {
          setRemainingAttempts(typeof state?.remainingAttempts === 'number' ? state.remainingAttempts : null);
          setError('驗證碼不正確，請確認驗證器上顯示的號碼後再試一次。');
        }
        setResetSignal((n) => n + 1);
        return;
      }

      await refresh();
      navigate('/', { replace: true });
    } catch (e: any) {
      setError(e.message || '驗證失敗，請稍後再試。');
      setResetSignal((n) => n + 1);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <IsolatedLayout
      title="輸入驗證碼"
      subtitle="請輸入 Google Authenticator 上顯示的 6 位數字"
      footer={
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" color="text.secondary">{profile?.email}</Typography>
          <Link component="button" variant="caption" onClick={() => signOut()} underline="hover">
            改用其他帳號登入
          </Link>
        </Stack>
      }
    >
      <Stack spacing={2.5}>
        {lockedUntil ? (
          <>
            <Alert severity="error">
              連續驗證失敗次數過多，此帳號已暫時鎖定，請於 <strong>{formatRemaining(lockedUntil)}</strong> 後再試。
            </Alert>
            <Button variant="outlined" onClick={checkLock}>重新檢查</Button>
          </>
        ) : (
          <>
            <OtpInput
              onComplete={handleVerify}
              disabled={verifying}
              resetSignal={resetSignal}
              error={!!error}
            />

            {verifying && (
              <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
                <CircularProgress size={16} />
                <Typography variant="body2" color="text.secondary">驗證中...</Typography>
              </Stack>
            )}

            {error && (
              <Alert severity="error">
                {error}
                {remainingAttempts !== null && remainingAttempts > 0 && (
                  <> 還可以嘗試 {remainingAttempts} 次。</>
                )}
              </Alert>
            )}

            <Typography variant="caption" color="text.secondary" textAlign="center">
              遺失驗證器？請聯繫管理員為您重置雙因素驗證。
            </Typography>
          </>
        )}
      </Stack>
    </IsolatedLayout>
  );
}

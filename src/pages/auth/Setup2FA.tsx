import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert, Box, Button, CircularProgress, Link, Stack, Step, StepLabel, Stepper, Typography,
} from '@mui/material';
import { Copy, Check, ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/AuthContext';
import IsolatedLayout from '../../components/IsolatedLayout';
import OtpInput from '../../components/OtpInput';

// ========================================================================
// 強制 TOTP 綁定頁（/auth/setup-2fa）。
//
// 使用者此時的 session 是 aal1：通過了 Google 驗證，但還沒有第二因素，
// 因此資料庫的 RLS 一張表都不會放行。這一頁是離開這個狀態的唯一出口。
//
// 流程：enroll 取得金鑰與 QR → 使用者用 Google Authenticator 掃描 →
//       輸入 6 碼 → challenge + verify → session 升級成 aal2 →
//       後端把帳號狀態推進到 active。
// ========================================================================

const STEPS = ['掃描 QR Code', '輸入驗證碼'];

export default function Setup2FA() {
  const navigate = useNavigate();
  const { profile, refresh, signOut } = useAuth();

  const [step, setStep] = useState(0);
  const [factorId, setFactorId] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [secret, setSecret] = useState('');
  const [enrolling, setEnrolling] = useState(true);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [copied, setCopied] = useState(false);

  // React 18 的 StrictMode 在開發模式會把 effect 跑兩次，
  // 沒有這道防護會產生兩個 factor，第二次 enroll 還會失敗。
  const enrollStarted = useRef(false);

  const startEnroll = useCallback(async () => {
    setEnrolling(true);
    setEnrollError(null);
    try {
      // 先清掉先前沒完成驗證的 factor：使用者中途離開再回來時，
      // 舊的未驗證 factor 會讓 enroll 直接失敗（名稱/數量衝突）。
      const { data: existing } = await supabase.auth.mfa.listFactors();
      const stale = (existing?.all || []).filter((f) => f.status !== 'verified');
      for (const f of stale) {
        await supabase.auth.mfa.unenroll({ factorId: f.id });
      }

      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (error) throw error;
      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
    } catch (e: any) {
      setEnrollError(e.message || '產生驗證器金鑰失敗，請重新整理再試一次。');
    } finally {
      setEnrolling(false);
    }
  }, []);

  useEffect(() => {
    if (enrollStarted.current) return;
    enrollStarted.current = true;
    startEnroll();
  }, [startEnroll]);

  const copySecret = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleVerify = async (code: string) => {
    setVerifying(true);
    setVerifyError(null);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError) throw challengeError;

      const { error: verifyErr } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      });
      if (verifyErr) throw verifyErr;

      // 驗證成功後 session 已升級為 aal2，用新的權杖請後端把帳號狀態推進到 active。
      // 這一步刻意放後端：前端說「我綁好了」不算數，後端會檢查權杖的 aal 等級。
      const { data: sessionData } = await supabase.auth.getSession();
      const res = await fetch('/.netlify/functions/mfa', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionData.session?.access_token}`,
        },
        body: JSON.stringify({ action: 'complete-setup' }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch { /* 用原始文字 */ }
        throw new Error(msg);
      }

      await refresh();
      navigate('/', { replace: true });
    } catch (e: any) {
      setVerifyError(e.message || '驗證碼不正確，請確認驗證器上顯示的號碼後再試一次。');
      setResetSignal((n) => n + 1);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <IsolatedLayout
      title="設定雙因素驗證"
      subtitle="本系統規定每次登入都要通過驗證器，請先完成綁定"
      footer={
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="caption" color="text.secondary">
            {profile?.email}
          </Typography>
          <Link component="button" variant="caption" onClick={() => signOut()} underline="hover">
            改用其他帳號登入
          </Link>
        </Stack>
      }
    >
      <Stepper activeStep={step} sx={{ mb: 3 }}>
        {STEPS.map((label) => <Step key={label}><StepLabel>{label}</StepLabel></Step>)}
      </Stepper>

      {enrolling ? (
        <Stack alignItems="center" spacing={2} sx={{ py: 4 }}>
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">產生驗證器金鑰中...</Typography>
        </Stack>
      ) : enrollError ? (
        <Stack spacing={2}>
          <Alert severity="error">{enrollError}</Alert>
          <Button variant="outlined" onClick={startEnroll}>重試</Button>
        </Stack>
      ) : step === 0 ? (
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary">
            用手機開啟 <strong>Google Authenticator</strong>（或 Authy、Microsoft Authenticator），
            掃描下方 QR Code 加入這個帳號。
          </Typography>

          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <Box
              component="img"
              src={qrCode}
              alt="雙因素驗證 QR Code"
              sx={{ width: 200, height: 200, border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1, bgcolor: '#fff' }}
            />
          </Box>

          <Box>
            <Typography variant="caption" color="text.secondary">
              無法掃描時，可在驗證器 App 手動輸入這組金鑰：
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
              <Box
                sx={{
                  flex: 1, fontFamily: 'monospace', fontSize: 13, letterSpacing: 1,
                  bgcolor: 'action.hover', px: 1.5, py: 1, borderRadius: 1, wordBreak: 'break-all',
                }}
              >
                {secret}
              </Box>
              <Button
                size="small"
                variant="outlined"
                onClick={copySecret}
                startIcon={copied ? <Check size={14} /> : <Copy size={14} />}
              >
                {copied ? '已複製' : '複製'}
              </Button>
            </Stack>
          </Box>

          <Alert severity="warning" sx={{ fontSize: 13 }}>
            請務必完成綁定。綁定前您無法存取後台任何資料；若日後更換手機導致無法驗證，
            需要由管理員為您重置。
          </Alert>

          <Button variant="contained" size="large" onClick={() => setStep(1)}>
            我已加入驗證器，下一步
          </Button>
        </Stack>
      ) : (
        <Stack spacing={2.5}>
          <Typography variant="body2" color="text.secondary" textAlign="center">
            輸入驗證器上顯示的 6 位數字
          </Typography>

          <OtpInput
            onComplete={handleVerify}
            disabled={verifying}
            resetSignal={resetSignal}
            error={!!verifyError}
          />

          {verifying && (
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
              <CircularProgress size={16} />
              <Typography variant="body2" color="text.secondary">驗證中...</Typography>
            </Stack>
          )}

          {verifyError && <Alert severity="error">{verifyError}</Alert>}

          <Stack direction="row" spacing={1} justifyContent="center">
            <Button size="small" onClick={() => setStep(0)} disabled={verifying}>
              回上一步重新掃描
            </Button>
          </Stack>

          <Alert severity="info" icon={<ShieldCheck size={18} />} sx={{ fontSize: 13 }}>
            驗證碼每 30 秒更新一次。若一直失敗，請確認手機時間設定為「自動」。
          </Alert>
        </Stack>
      )}
    </IsolatedLayout>
  );
}

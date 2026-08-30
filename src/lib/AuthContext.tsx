import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import type { AdminRole, AccountStatus } from './permissions';

// ========================================================================
// 登入狀態、角色與 2FA 階段的單一來源。整個 App 都從這裡拿「我是誰、我到哪一步了」。
//
// 【階段機（phase）】對應規格書的流程，決定使用者現在該看到哪一頁：
//   anonymous        沒有 session → /login
//   accepting-invite 剛通過 Google 驗證，正在比對邀請名單
//   needs-mfa-setup  已通過邀請比對，但還沒綁定 TOTP → /auth/setup-2fa
//   needs-mfa-verify 已綁定 TOTP，本次登入還沒輸入驗證碼 → /auth/verify-2fa
//   ready            已通過 2FA（session 是 aal2）→ 可進後台
//   blocked          沒有邀請／已停權 → 停在 /login 並顯示原因
//
// 【為什麼用 Supabase 的 AAL 判斷而不是自己記狀態】
// aal（Authenticator Assurance Level）是寫在 JWT 裡、由 Supabase 簽章保證的：
//   currentLevel=aal2                    已通過第二因素
//   currentLevel=aal1 且 nextLevel=aal2  有綁定的驗證器，但這次還沒驗
//   nextLevel=aal1                       完全沒綁驗證器
// 前端自己記的旗標可以被竄改，JWT 裡的 aal 不行——而且資料庫的 RLS 認的也是同一個值，
// 所以前端判斷與後端防線用的是同一個事實來源，不會有兩邊不同步的破口。
// ========================================================================

export type AuthPhase =
  | 'loading'
  | 'anonymous'
  | 'accepting-invite'
  | 'needs-mfa-setup'
  | 'needs-mfa-verify'
  | 'ready'
  | 'blocked';

export interface AdminProfile {
  id: string;
  email: string | null;
  display_name: string | null;
  role: AdminRole;
  status: AccountStatus;
}

interface AuthValue {
  session: any | null;
  profile: AdminProfile | null;
  role: AdminRole | null;
  phase: AuthPhase;
  /** 被擋下來的原因（未受邀請／已停權），登入頁用來顯示訊息 */
  blockedReason: string | null;
  clearBlockedReason: () => void;
  /** 綁定或驗證 2FA 之後呼叫，重新評估目前階段 */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function callFn(path: string, token: string, body?: any) {
  const res = await fetch(`/.netlify/functions/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text }; }
  return { ok: res.ok, data: parsed };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<any | null>(null);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [phase, setPhase] = useState<AuthPhase>('loading');
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  // signOut 會再觸發一次 onAuthStateChange，用這個旗標避免重複跑評估流程
  const blockingRef = useRef(false);

  const block = useCallback(async (reason: string) => {
    blockingRef.current = true;
    setProfile(null);
    setBlockedReason(reason);
    setPhase('blocked');
    await supabase.auth.signOut();
    blockingRef.current = false;
    setSession(null);
  }, []);

  const evaluate = useCallback(async (activeSession: any | null) => {
    if (!activeSession?.access_token) {
      setProfile(null);
      setPhase('anonymous');
      return;
    }

    const token = activeSession.access_token;

    // 讀自己的 profile。RLS 的 read_own_profile 政策刻意不要求 aal2，
    // 否則會變成「要先過 2FA 才知道自己需不需要過 2FA」的死結。
    const { data: row, error } = await supabase
      .from('admin_profiles')
      .select('id, email, display_name, role, status')
      .eq('id', activeSession.user.id)
      .maybeSingle();

    if (error) {
      // 讀不到權限資料通常是設定問題（schema 還沒跑），不強制登出，
      // 直接登出會讓使用者陷入「一登入就被踢、看不到任何線索」的迴圈。
      console.error('讀取帳號權限失敗:', error);
      setBlockedReason(`讀取帳號權限失敗：${error.message}`);
      setPhase('blocked');
      return;
    }

    let current = row as AdminProfile | null;

    // 還沒被納管、或還停在「已邀請」的帳號：去後端比對邀請名單。
    // 這是「零公開註冊」的把關點——沒有有效邀請的 Google 帳號會在這裡被擋下。
    if (!current || current.status === 'invited') {
      setPhase('accepting-invite');
      const { ok, data } = await callFn('accept-invite', token, {});
      if (!ok) {
        await block(data.error || '這個帳號沒有存取權限。');
        return;
      }
      const { data: refreshed } = await supabase
        .from('admin_profiles')
        .select('id, email, display_name, role, status')
        .eq('id', activeSession.user.id)
        .maybeSingle();
      current = refreshed as AdminProfile | null;
      if (!current) {
        await block('建立帳號權限失敗，請聯繫管理員。');
        return;
      }
    }

    if (current.status === 'suspended') {
      await block('您的帳號已被停權，請聯繫管理員。');
      return;
    }

    setProfile(current);
    setBlockedReason(null);

    // 依 Supabase 的 AAL 判斷 2FA 走到哪一步
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel === 'aal2') {
      setPhase('ready');
      return;
    }
    if (aal?.nextLevel === 'aal2') {
      // 有已驗證的驗證器，但這次登入還沒輸入驗證碼
      setPhase('needs-mfa-verify');
      return;
    }
    // 完全沒有已驗證的驗證器 → 必須先綁定
    setPhase('needs-mfa-setup');
  }, [block]);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      evaluate(data.session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled || blockingRef.current) return;
      setSession(nextSession);
      setPhase('loading');
      evaluate(nextSession);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [evaluate]);

  const refresh = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    setPhase('loading');
    await evaluate(data.session);
  }, [evaluate]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
    setPhase('anonymous');
  }, []);

  const value = useMemo<AuthValue>(() => ({
    session,
    profile,
    role: phase === 'ready' ? (profile?.role ?? null) : null,
    phase,
    blockedReason,
    clearBlockedReason: () => setBlockedReason(null),
    refresh,
    signOut,
  }), [session, profile, phase, blockedReason, refresh, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必須在 <AuthProvider> 內使用');
  return ctx;
}

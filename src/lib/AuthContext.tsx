import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { supabase } from './supabase';
import type { AdminRole, AccountStatus } from './permissions';

// ========================================================================
// 登入狀態與角色的單一來源。整個 App 都從這裡拿「我是誰、我是什麼角色」。
//
// 這裡同時負責「未核准就擋下」的邏輯：Supabase 的帳密/Google 驗證通過之後，
// 我們才有辦法知道這個人是誰、有沒有被核准，所以無法在「驗證身分之前」就擋。
// 實際做法是驗證通過後立刻查 admin_profiles，狀態不是 approved 就馬上 signOut，
// 使用者不會進到後台任何一頁，效果等同於「擋下不讓登入」。
// ========================================================================

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
  /** session 與 profile 都確定之後才會變 false，避免畫面在還不知道角色時就先渲染出不該看到的選單 */
  loading: boolean;
  /** 被擋下來的原因（待審核／已停用／查詢失敗），登入頁用來顯示訊息 */
  blockedReason: string | null;
  clearBlockedReason: () => void;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<any | null>(null);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  // signOut 會再觸發一次 onAuthStateChange，用這個旗標避免重複跑「擋下」流程
  const blockingRef = useRef(false);

  const loadProfile = useCallback(async (activeSession: any | null) => {
    if (!activeSession?.user?.id) {
      setProfile(null);
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from('admin_profiles')
      .select('id, email, display_name, role, status')
      .eq('id', activeSession.user.id)
      .maybeSingle();

    if (error) {
      // 查不到權限就不放行，但也不強制登出——這通常是網路或設定問題（例如 schema 還沒跑），
      // 直接登出會讓使用者陷入「一登入就被踢出、看不到任何線索」的迴圈。
      console.error('讀取帳號權限失敗:', error);
      setProfile(null);
      setBlockedReason(`讀取帳號權限失敗：${error.message}`);
      setLoading(false);
      return;
    }

    // 沒有 profile：代表資料庫還沒建立這個帳號的權限資料（schema 尚未執行，或觸發器沒生效）
    if (!data) {
      blockingRef.current = true;
      setProfile(null);
      setBlockedReason('您的帳號尚未開通，請聯繫管理員。');
      await supabase.auth.signOut();
      blockingRef.current = false;
      setLoading(false);
      return;
    }

    if (data.status !== 'approved') {
      blockingRef.current = true;
      setProfile(null);
      setBlockedReason(
        data.status === 'disabled'
          ? '您的帳號已被停用，請聯繫管理員。'
          : '您的帳號正在等待管理員核准，核准後即可登入。'
      );
      await supabase.auth.signOut();
      blockingRef.current = false;
      setLoading(false);
      return;
    }

    setProfile(data as AdminProfile);
    setBlockedReason(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      loadProfile(data.session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled || blockingRef.current) return;
      setSession(nextSession);
      setLoading(true);
      loadProfile(nextSession);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [loadProfile]);

  const refreshProfile = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await loadProfile(data.session);
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    session,
    profile,
    role: profile?.role ?? null,
    loading,
    blockedReason,
    clearBlockedReason: () => setBlockedReason(null),
    refreshProfile,
    signOut,
  }), [session, profile, loading, blockedReason, refreshProfile, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必須在 <AuthProvider> 內使用');
  return ctx;
}

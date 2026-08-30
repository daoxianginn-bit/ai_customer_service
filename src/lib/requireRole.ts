import type { SupabaseClient } from '@supabase/supabase-js';

// ========================================================================
// Netlify function 專用的權限守衛。
//
// 這些 function 都是用 SERVICE_ROLE_KEY 建立 client，會完全繞過 RLS——資料庫層的角色權限
// 對它們沒有任何約束力。所以凡是會改動帳號或機密資料的 function，都必須自己在程式碼裡
// 明確檢查呼叫者的角色，不能只驗「有沒有帶有效 token」（那只證明他是登入使用者，
// 不代表他是管理員）。
//
// 用法：
//   const guard = await requireRole(supabaseAdmin, event, ['admin']);
//   if ('error' in guard) return guard.error;
//   // 這行之後 guard.user / guard.role 可安全使用
// ========================================================================

export type AdminRole = 'admin' | 'staff' | 'viewer';

/**
 * 從 Supabase 的 access token 取出 aal（Authenticator Assurance Level）宣告。
 * aal1＝只通過密碼/OAuth，aal2＝另外通過了 TOTP。
 * 呼叫端必須先用 getUser() 驗過簽章再用這個函式，否則等於相信未驗證的輸入。
 */
export function getAalFromToken(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // 用 atob 而不是 Buffer：這個檔案位於 src/ 之下會被前端的 tsconfig 一起檢查，
    // 那裡沒有 Node 的型別。atob 在 Node 16+ 與瀏覽器都是全域可用的。
    const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    // JWT 內容可能含非 ASCII 字元（例如中文姓名），atob 出來是 binary string，
    // 要先轉回 UTF-8 才能安全 JSON.parse，否則有中文的權杖會解析失敗而被誤判成無效。
    const json = decodeURIComponent(
      binary.split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json).aal ?? null;
  } catch {
    return null;
  }
}

interface GuardOk {
  user: { id: string; email?: string | null };
  role: AdminRole;
}

interface GuardFail {
  error: { statusCode: number; body: string };
}

export async function requireRole(
  supabaseAdmin: SupabaseClient,
  event: { headers: Record<string, string | undefined> },
  allowed: AdminRole[]
): Promise<GuardOk | GuardFail> {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { error: { statusCode: 401, body: '未登入' } };

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return { error: { statusCode: 401, body: '登入已過期，請重新登入' } };

  // 必須是已通過第二因素驗證的 session（aal2）。
  // getUser() 只驗證權杖有效、不會回報 aal，所以直接讀 JWT 裡的 aal 宣告——
  // 上一行已經驗過簽章，這裡解出來的內容可以信任。
  // 少了這道檢查，只過了 Google 但還沒輸入 TOTP 的 session（aal1）就能呼叫這些
  // 繞過 RLS 的高權限函式，等於留了一條跳過 2FA 的後門。
  if (getAalFromToken(token) !== 'aal2') {
    return { error: { statusCode: 403, body: '需要完成雙因素驗證才能執行這個操作' } };
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('admin_profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) return { error: { statusCode: 500, body: `讀取帳號權限失敗：${profileError.message}` } };
  // 沒有 profile 代表這個帳號還沒被權限系統納管，一律當作未開通處理，不給任何權限。
  if (!profile) return { error: { statusCode: 403, body: '您的帳號尚未開通，請聯繫管理員' } };
  if (profile.status === 'pending_mfa') {
    return { error: { statusCode: 403, body: '請先完成雙因素驗證綁定' } };
  }
  if (profile.status !== 'active') return { error: { statusCode: 403, body: '您的帳號尚未開通或已被停權，請聯繫管理員' } };
  if (!allowed.includes(profile.role as AdminRole)) {
    return { error: { statusCode: 403, body: '權限不足，這個操作僅限管理員' } };
  }

  return { user: { id: user.id, email: user.email }, role: profile.role as AdminRole };
}

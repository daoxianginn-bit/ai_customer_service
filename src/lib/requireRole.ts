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

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('admin_profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) return { error: { statusCode: 500, body: `讀取帳號權限失敗：${profileError.message}` } };
  // 沒有 profile 代表這個帳號還沒被權限系統納管，一律當作未核准處理，不給任何權限。
  if (!profile) return { error: { statusCode: 403, body: '您的帳號尚未開通，請聯繫管理員' } };
  if (profile.status !== 'approved') return { error: { statusCode: 403, body: '您的帳號尚未開通或已被停用，請聯繫管理員' } };
  if (!allowed.includes(profile.role as AdminRole)) {
    return { error: { statusCode: 403, body: '權限不足，這個操作僅限管理員' } };
  }

  return { user: { id: user.id, email: user.email }, role: profile.role as AdminRole };
}

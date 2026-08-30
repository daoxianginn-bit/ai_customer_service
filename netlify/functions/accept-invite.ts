import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ========================================================================
// POST /.netlify/functions/accept-invite
//
// 「零公開註冊」的真正把關點。使用者用 Google 登入回來之後呼叫這支：
// 拿他 Google 帳號的 email 去比對邀請名單，對不上就一律拒絕並登出。
//
// 為什麼用 email 比對而不是只認邀請 Token：
// 收信人可能沒收到信、信被歸類到垃圾郵件、或連結在別的裝置上。只要他能證明自己
// 控制那個被邀請的 Gmail（Google OAuth 已經證明了），就應該放行。Token 的作用是
// 讓邀請頁能顯示「你被邀請以什麼身分加入」，不是唯一憑據。
//
// 這支刻意不使用 requireRole()：呼叫它的人此時正是「還沒有任何權限」的狀態
// （aal1、status 還是 invited），requireRole 會直接擋下來。
// ========================================================================

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user?.email) {
    return { statusCode: 401, body: JSON.stringify({ error: '登入狀態無效，請重新登入' }) };
  }

  const email = user.email.toLowerCase();

  const { data: profile } = await supabaseAdmin
    .from('admin_profiles')
    .select('role, status')
    .eq('id', user.id)
    .maybeSingle();

  // 已經完成上線的帳號直接放行，不用再檢查邀請——日常登入也會走到這支。
  if (profile && (profile.status === 'pending_mfa' || profile.status === 'active')) {
    return { statusCode: 200, body: JSON.stringify({ status: profile.status, role: profile.role }) };
  }

  if (profile?.status === 'suspended') {
    return { statusCode: 403, body: JSON.stringify({ error: '您的帳號已被停權，請聯繫管理員。' }) };
  }

  // 找一筆屬於這個 email、仍然有效的邀請
  const { data: invitation, error: invitationError } = await supabaseAdmin
    .from('admin_invitations')
    .select('id, role, expires_at, accepted_at, revoked_at')
    .ilike('email', email)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (invitationError) {
    return { statusCode: 500, body: JSON.stringify({ error: `驗證邀請失敗：${invitationError.message}` }) };
  }

  if (!invitation) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: '這個 Google 帳號沒有有效的邀請。本系統不開放自行註冊，請聯繫管理員為您建立邀請。' }),
    };
  }

  const nowIso = new Date().toISOString();

  // 依邀請內容賦予角色，並推進到「待綁定 2FA」。
  // 注意這裡不是 active：還要綁完 TOTP 才算數，在那之前 RLS 一張表都不會放行。
  const { error: profileError } = await supabaseAdmin.from('admin_profiles').upsert({
    id: user.id,
    email: user.email,
    display_name: (user.user_metadata as any)?.full_name || (user.user_metadata as any)?.name || user.email,
    role: invitation.role,
    status: 'pending_mfa',
    approved_at: nowIso,
    approved_by: null,
    updated_at: nowIso,
  }, { onConflict: 'id' });

  if (profileError) {
    return { statusCode: 500, body: JSON.stringify({ error: `建立帳號權限失敗：${profileError.message}` }) };
  }

  await supabaseAdmin
    .from('admin_invitations')
    .update({ accepted_at: nowIso, accepted_user_id: user.id })
    .eq('id', invitation.id);

  return { statusCode: 200, body: JSON.stringify({ status: 'pending_mfa', role: invitation.role }) };
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'accept-invite', rawHandler);

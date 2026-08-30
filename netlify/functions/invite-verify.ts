import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { hashInviteToken } from './invite-admin';
import { ROLE_OPTIONS } from '../../src/lib/permissions';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ========================================================================
// GET /.netlify/functions/invite-verify?token=...
//
// 邀請確認頁用來檢查連結有效性、並顯示「你被邀請以什麼身分加入」。
// 這是公開端點（對方此時還沒登入），所以回傳內容刻意壓到最少：
// 只回 email 與角色名稱，不回傳任何系統內部資料。
//
// email 會遮罩後才回傳（abc***@gmail.com）：這頁只要讓收信人確認「是我沒錯」，
// 不需要把完整信箱攤在一個任何人拿到連結就能開的頁面上。
// ========================================================================

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}${'*'.repeat(Math.max(3, local.length - head.length))}@${domain}`;
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const token = event.queryStringParameters?.token || '';
  if (!token) return { statusCode: 400, body: JSON.stringify({ valid: false, reason: '缺少邀請碼' }) };

  const { data: invitation, error } = await supabaseAdmin
    .from('admin_invitations')
    .select('email, role, expires_at, accepted_at, revoked_at')
    .eq('token_hash', hashInviteToken(token))
    .maybeSingle();

  if (error) return { statusCode: 500, body: JSON.stringify({ valid: false, reason: '驗證邀請時發生錯誤' }) };

  // 所有失敗情形都回一致的模糊訊息，不透露「這個 token 存不存在」，
  // 避免被拿來逐一試出有效的邀請碼。
  const invalid = { statusCode: 200, body: JSON.stringify({ valid: false, reason: '這個邀請連結無效或已經失效' }) };
  if (!invitation) return invalid;
  if (invitation.revoked_at) return invalid;
  if (invitation.accepted_at) {
    return { statusCode: 200, body: JSON.stringify({ valid: false, reason: '這個邀請已經被使用過了，請直接從登入頁登入' }) };
  }
  if (new Date(invitation.expires_at).getTime() < Date.now()) {
    return { statusCode: 200, body: JSON.stringify({ valid: false, reason: '這個邀請連結已經過期，請聯繫管理員重新寄送' }) };
  }

  const roleLabel = ROLE_OPTIONS.find((r) => r.value === invitation.role)?.label || invitation.role;

  return {
    statusCode: 200,
    body: JSON.stringify({
      valid: true,
      maskedEmail: maskEmail(invitation.email),
      roleLabel,
    }),
  };
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'invite-verify', rawHandler);

import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';
import { ROLE_OPTIONS } from '../../src/lib/permissions';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const VALID_ROLES = ['admin', 'staff', 'viewer'];
const INVITE_TTL_HOURS = 24;

// 邀請信裡的連結要導回哪個網址。不指定的話 Supabase 會退回專案設定的 Site URL，
// 而那個預設值是 http://localhost:3000——信寄出去對方點了只會連到自己電腦上不存在的網站。
function resolveSiteUrl(event: any): string {
  const fromEnv = process.env.PUBLIC_SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const origin = event.headers?.origin || event.headers?.Origin;
  if (origin) return String(origin).replace(/\/$/, '');
  return '';
}

/** 邀請 Token 只把雜湊存進資料庫，原文只出現在寄出的連結裡。 */
export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // 只有管理員能發邀請。少了這道檢查，任何登入者都能自己邀一個管理員帳號進來。
  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return guard.error;

  const { email, role } = JSON.parse(event.body || '{}');
  if (!email || typeof email !== 'string') return { statusCode: 400, body: '請輸入 Email' };
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizedEmail)) return { statusCode: 400, body: 'Email 格式不正確' };
  const assignedRole = VALID_ROLES.includes(role) ? role : 'staff';

  const siteUrl = resolveSiteUrl(event);
  if (!siteUrl) {
    return {
      statusCode: 500,
      body: '無法判斷網站網址，邀請信的連結會指向錯誤位置。請在 Netlify 環境變數新增 PUBLIC_SITE_URL 後再試一次。',
    };
  }

  const roleLabel = ROLE_OPTIONS.find((r) => r.value === assignedRole)?.label || assignedRole;
  const inviteUrl = (t: string) => `${siteUrl}/auth/invite-verify?token=${encodeURIComponent(t)}`;

  // 產生高熵邀請 Token（32 bytes）。這是「零公開註冊」的憑據之一，
  // 但真正的把關是下面寫進 admin_invitations 的那筆紀錄——
  // 接受邀請時是用「Google 回來的 email 是否對得上有效邀請」來判斷，
  // 不是只看 Token。這樣即使對方沒收到信、直接去登入頁用 Google 登入也能成立，
  // 不會因為信件被擋掉就完全卡死。
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();

  // 同一個 email 若有還沒使用的舊邀請，先作廢再開新的，避免舊連結仍然有效。
  await supabaseAdmin
    .from('admin_invitations')
    .update({ revoked_at: new Date().toISOString() })
    .ilike('email', normalizedEmail)
    .is('accepted_at', null)
    .is('revoked_at', null);

  const { error: inviteError } = await supabaseAdmin.from('admin_invitations').insert({
    email: normalizedEmail,
    role: assignedRole,
    token_hash: hashInviteToken(token),
    expires_at: expiresAt,
    invited_by: guard.user.id,
  });
  if (inviteError) return { statusCode: 500, body: `建立邀請失敗：${inviteError.message}` };

  // 寄出邀請信。對方點連結時 Supabase 會先確認他的 email（這一步讓之後的 Google 身分連結
  // 走在官方支援的路徑上），再帶著我們的 Token 導到邀請確認頁。
  const { error: mailError } = await supabaseAdmin.auth.admin.inviteUserByEmail(normalizedEmail, {
    redirectTo: inviteUrl(token),
    data: {
      invited_role: assignedRole,
      invited_role_label: roleLabel,
      invited_by: guard.user.email || '',
    },
  });

  // 帳號已經存在時 inviteUserByEmail 會失敗（例如重寄邀請給曾經被邀過的人）。
  // 這不算失敗：邀請紀錄已經建立，對方直接到登入頁用 Google 登入一樣會被放行，
  // 所以回報成功但告知管理員信沒有寄出，請自行通知對方。
  const mailSent = !mailError;

  return {
    statusCode: 200,
    body: JSON.stringify({
      success: true,
      email: normalizedEmail,
      role: assignedRole,
      mailSent,
      mailError: mailError?.message || null,
      expiresAt,
      // 把連結一併回傳給管理員，讓信寄不出去或被 Supabase 的 Site URL 設定改寫時
      // 還有一條路可走（自行用 LINE 等方式傳給對方）。
      //
      // 這不是把鑰匙交出去：光有這個 Token 進不了系統。接受邀請時真正的把關是
      // 「Google 回來的 email 是否等於被邀請的 email」，攻擊者拿到連結也得先擁有
      // 那個 Gmail 帳號才有用。Token 的作用只是讓邀請頁顯示得出邀請內容。
      inviteUrl: inviteUrl(token),
    }),
  };
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'invite-admin', rawHandler);

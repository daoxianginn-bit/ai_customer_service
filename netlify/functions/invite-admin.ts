import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';
import { ROLE_OPTIONS } from '../../src/lib/permissions';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const VALID_ROLES = ['admin', 'staff', 'viewer'];

// 邀請信裡「接受邀請」按鈕要導回哪個網址。
// 不指定的話 Supabase 會退回專案設定的 Site URL，而那個預設值是 http://localhost:3000——
// 信寄出去對方點了只會連到自己電腦上不存在的網站，這就是邀請信網址錯誤的原因。
//
// 取值順序：自訂環境變數 → Netlify 自動注入的站台網址 → 發出請求的來源網域。
// 最後一項是保險：本機用 netlify dev 測試時前兩個都沒有值。
function resolveSiteUrl(event: any): string {
  const fromEnv = process.env.PUBLIC_SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const origin = event.headers?.origin || event.headers?.Origin;
  if (origin) return String(origin).replace(/\/$/, '');
  return '';
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // 只有管理員能邀請新帳號。少了這道檢查，任何登入者（含唯讀角色）都能自己邀一個
  // 新帳號進來，等於權限系統形同虛設——這是最典型的提權漏洞。
  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return guard.error;

  const { email, role } = JSON.parse(event.body || '{}');
  if (!email || typeof email !== 'string') return { statusCode: 400, body: 'Email is required' };
  const assignedRole = VALID_ROLES.includes(role) ? role : 'staff';

  const siteUrl = resolveSiteUrl(event);
  if (!siteUrl) {
    return {
      statusCode: 500,
      body: '無法判斷網站網址，邀請信的連結會指向錯誤位置。請在 Netlify 環境變數新增 PUBLIC_SITE_URL（例如 https://your-site.netlify.app）後再試一次。',
    };
  }

  const roleLabel = ROLE_OPTIONS.find((r) => r.value === assignedRole)?.label || assignedRole;

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    // 導到專門的「設定密碼」頁而不是首頁：被邀請的人此時還沒有密碼，
    // 直接丟到首頁他會登入成功卻永遠不知道密碼是什麼，下次就進不來了。
    // 用路徑（而不是網址裡的 type 參數）來表達意圖，因為 supabase-js 會在建立 session 後
    // 把網址上的 #access_token=... 整段清掉，路徑才是穩定讀得到的訊號。
    redirectTo: `${siteUrl}/set-password`,
    // 寫進使用者的 metadata，讓 Supabase 的信件樣板可以用 {{ .Data.xxx }} 取用，
    // 把「誰邀請你、你是什麼角色」寫進信裡，而不是一封每個人都一樣的空泛通知。
    data: {
      invited_role: assignedRole,
      invited_role_label: roleLabel,
      invited_by: guard.user.email || '',
    },
  });
  if (error) return { statusCode: 500, body: error.message };

  // 由管理員主動邀請的帳號視同已核准（是管理員自己指名要加的人），直接給定角色，
  // 對方設完密碼就能直接使用，不用再走一次核准流程。
  // 觸發器已經在 auth.users 建立時插好 profile，這裡只是把它更新成已核准＋指定角色。
  if (data.user?.id) {
    await supabaseAdmin.from('admin_profiles').upsert({
      id: data.user.id,
      email: data.user.email,
      role: assignedRole,
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: guard.user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
  }

  return { statusCode: 200, body: JSON.stringify({ success: true, id: data.user?.id, email: data.user?.email, role: assignedRole }) };
};

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabaseAdmin, 'invite-admin', rawHandler);

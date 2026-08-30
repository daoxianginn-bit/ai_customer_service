import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  // 帳號清單會列出所有人的 Email，屬於管理員才該看到的資料
  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return guard.error;

  const { data, error } = await supabaseAdmin.auth.admin.listUsers();
  if (error) return { statusCode: 500, body: error.message };

  // 角色與核准狀態存在 admin_profiles，登入時間等資訊只有 auth.users 有，兩邊合併後一次回傳，
  // 前端就不用自己再打一次 Supabase 查 profile。
  const { data: profiles, error: profileError } = await supabaseAdmin
    .from('admin_profiles')
    .select('id, role, status, display_name, approved_at');
  if (profileError) return { statusCode: 500, body: profileError.message };

  const profileById = new Map((profiles || []).map((p: any) => [p.id, p]));

  const admins = data.users.map((u) => {
    const p: any = profileById.get(u.id);
    return {
      id: u.id,
      email: u.email,
      display_name: p?.display_name || null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      invited: !u.last_sign_in_at,
      // 還沒有 profile 的帳號（例如權限系統上線前就存在、又還沒跑過 schema 的情況）
      // 一律視為尚未開通，寧可擋住也不要預設放行。
      role: p?.role || 'staff',
      status: p?.status || 'invited',
      approved_at: p?.approved_at || null,
    };
  });

  return { statusCode: 200, body: JSON.stringify({ admins }) };
};

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabaseAdmin, 'list-admins', rawHandler);

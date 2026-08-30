import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // 刪除帳號只有管理員能做。這支用的是 service role 金鑰、完全繞過 RLS，
  // 所以角色檢查一定要寫在這裡，否則任何登入者都能刪掉別人的帳號。
  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return guard.error;
  const user = guard.user;

  const { userId } = JSON.parse(event.body || '{}');
  if (!userId || typeof userId !== 'string') return { statusCode: 400, body: 'userId is required' };

  if (userId === user.id) return { statusCode: 400, body: '無法移除自己的帳號' };

  // 不能刪掉最後一個管理員，否則系統會變成沒有人能核准新帳號、也沒有人能改系統設定的死結。
  const { data: targetProfile } = await supabaseAdmin
    .from('admin_profiles').select('role, status').eq('id', userId).maybeSingle();
  if (targetProfile?.role === 'admin' && targetProfile?.status === 'approved') {
    const { count } = await supabaseAdmin
      .from('admin_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'admin')
      .eq('status', 'approved');
    if ((count ?? 0) <= 1) return { statusCode: 400, body: '這是系統唯一的管理員，不能移除' };
  }

  // 主帳號不能被其他管理員刪除——前端會擋，但刪除動作用的是 service role 金鑰，
  // 真正的防線一定要在後端做，不能只靠前端 UI 不給按。
  const { data: settings } = await supabaseAdmin.from('settings').select('primary_admin_id').single();
  if (settings?.primary_admin_id && userId === settings.primary_admin_id) {
    return { statusCode: 400, body: '這是主帳號，不能被移除' };
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) return { statusCode: 500, body: error.message };

  return { statusCode: 200, body: JSON.stringify({ success: true }) };
};

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabaseAdmin, 'delete-admin', rawHandler);

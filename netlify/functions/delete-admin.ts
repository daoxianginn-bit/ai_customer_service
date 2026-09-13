import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { assertAdminRemains } from '../../src/lib/rbacService';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // 刪除帳號只有管理員能做。這支用的是 service role 金鑰、完全繞過 RLS，
  // 所以角色檢查一定要寫在這裡，否則任何登入者都能刪掉別人的帳號。
  const guard = await requirePermission(supabaseAdmin, event as any, 'account.delete');
  if ('error' in guard) return guard.error;
  const user = guard.user;

  const { userId } = JSON.parse(event.body || '{}');
  if (!userId || typeof userId !== 'string') return { statusCode: 400, body: 'userId is required' };

  if (userId === user.id) return { statusCode: 400, body: '無法移除自己的帳號' };

  // 不能刪掉最後一個能管角色與帳號的管理員（權限管理 V2 §39），否則沒有人能發邀請、也沒有人能改權限。
  // 以前這裡比對的是 status === 'approved'（舊狀態名），等於從來沒擋過；改用權限模型的模擬檢查。
  try {
    await assertAdminRemains(supabaseAdmin, { excludeUserId: userId });
  } catch (e: any) {
    return { statusCode: 400, body: e?.message || '這是系統唯一的管理員，不能移除' };
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

import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return { statusCode: 401, body: 'Missing auth token' };

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, body: 'Invalid session' };

  const { userId } = JSON.parse(event.body || '{}');
  if (!userId || typeof userId !== 'string') return { statusCode: 400, body: 'userId is required' };

  if (userId === user.id) return { statusCode: 400, body: '無法移除自己的帳號' };

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

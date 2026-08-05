import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return { statusCode: 401, body: 'Missing auth token' };

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, body: 'Invalid session' };

  const { data, error } = await supabaseAdmin.auth.admin.listUsers();
  if (error) return { statusCode: 500, body: error.message };

  const admins = data.users.map((u) => ({
    id: u.id,
    email: u.email,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
    invited: !u.last_sign_in_at,
  }));

  return { statusCode: 200, body: JSON.stringify({ admins }) };
};

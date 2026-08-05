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

  const { email } = JSON.parse(event.body || '{}');
  if (!email || typeof email !== 'string') return { statusCode: 400, body: 'Email is required' };

  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
  if (error) return { statusCode: 500, body: error.message };

  return { statusCode: 200, body: JSON.stringify({ success: true, id: data.user?.id, email: data.user?.email }) };
};

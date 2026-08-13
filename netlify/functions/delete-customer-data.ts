import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';

// ========================================================================
// 清除單一客人在系統裡的所有個資（個資法「刪除請求」用）：訂單、對話紀錄、
// 轉真人紀錄、聯絡人資料一次清掉。只有「主帳號」（settings.primary_admin_id）
// 能執行，且是不可逆動作，前端要再跳一次確認對話框，這裡後端也不能只靠前端擋。
// ========================================================================

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, body: JSON.stringify({ error: '登入已過期，請重新整理頁面' }) };

  const { data: settings } = await supabaseAdmin.from('settings').select('primary_admin_id').single();
  if (!settings?.primary_admin_id || user.id !== settings.primary_admin_id) {
    return { statusCode: 403, body: JSON.stringify({ error: '只有主帳號能清除客戶資料' }) };
  }

  const { lineUserId } = JSON.parse(event.body || '{}');
  if (!lineUserId || typeof lineUserId !== 'string') return { statusCode: 400, body: JSON.stringify({ error: 'lineUserId is required' }) };

  try {
    // 先刪訂單底下的關聯資料，再刪訂單本身，避免外鍵擋住；user_states 是這位客人的
    // 「身分」紀錄，放最後刪。任何一步找不到資料表/資料都不當成錯誤，盡量清乾淨。
    const { data: bookings } = await supabaseAdmin.from('bookings').select('id').eq('line_user_id', lineUserId);
    const bookingIds = (bookings || []).map((b: any) => b.id);
    if (bookingIds.length) {
      await supabaseAdmin.from('booking_rooms').delete().in('booking_id', bookingIds);
      await supabaseAdmin.from('booking_room_nights').delete().in('booking_id', bookingIds);
      await supabaseAdmin.from('booking_linen_usage').delete().in('booking_id', bookingIds);
    }
    await supabaseAdmin.from('bookings').delete().eq('line_user_id', lineUserId);
    await supabaseAdmin.from('conversations').delete().eq('line_user_id', lineUserId);
    await supabaseAdmin.from('handover_logs').delete().eq('line_user_id', lineUserId);
    const { error: stateError } = await supabaseAdmin.from('user_states').delete().eq('line_user_id', lineUserId);
    if (stateError) throw stateError;

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || '清除失敗' }) };
  }
};

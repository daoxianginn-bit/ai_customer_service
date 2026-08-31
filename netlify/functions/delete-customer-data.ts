import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';

// ========================================================================
// 清除單一客人在系統裡的所有個資（個資法「刪除請求」用）：訂單、對話紀錄、
// 轉真人紀錄、聯絡人資料一次清掉。只有「主帳號」（settings.primary_admin_id）
// 能執行，且是不可逆動作，前端要再跳一次確認對話框，這裡後端也不能只靠前端擋。
// ========================================================================

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // 一律走 requireRole()，不要自己拼認證流程：這支原本只驗「權杖有效 + 是主帳號」，
  // 少了 aal2（2FA）與帳號狀態檢查，等於只過了 Google、還沒輸入 TOTP 的 session
  // 就能呼叫這個全系統破壞力最大的端點——2FA 在最需要它的地方失效。
  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };

  // 管理員還不夠，這個動作限主帳號本人。跟資料庫的 is_owner() 政策一致。
  const { data: settings } = await supabaseAdmin.from('settings').select('primary_admin_id').single();
  if (!settings?.primary_admin_id || guard.user.id !== settings.primary_admin_id) {
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

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabaseAdmin, 'delete-customer-data', rawHandler);

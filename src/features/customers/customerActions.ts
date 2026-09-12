import { supabase } from '../../lib/supabase';

// ========================================================================
// 客戶資料的動作：重新抓 LINE 暱稱／大頭貼、行銷拒收、清除客戶資料（只有主帳號）。
// ========================================================================

async function callFn(path: string, body: unknown) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch(`/.netlify/functions/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let result: any = null;
  try { result = raw ? JSON.parse(raw) : null; } catch { result = null; }
  if (!res.ok) throw new Error(result?.error || `HTTP ${res.status}`);
  return result;
}

/**
 * 重新向 LINE 抓暱稱與大頭貼。channelId 一定要一起帶：LINE 的 profile API 只查得到自己官方帳號
 * 底下的好友，用別的帳號的 token 去查一律回錯誤。回傳 null 代表 LINE 那邊仍抓不到。
 */
export async function refreshLineProfile(lineUserId: string, channelId: string): Promise<{ displayName: string; pictureUrl: string | null } | null> {
  const profile = await callFn('line-profile', { lineUserId, channelId });
  if (!profile?.displayName) return null;
  await supabase.from('user_states')
    .update({ nickname: profile.displayName, avatar_url: profile.pictureUrl || null })
    .eq('channel_id', channelId).eq('line_user_id', lineUserId);
  return { displayName: profile.displayName, pictureUrl: profile.pictureUrl || null };
}

export async function setMarketingOptOut(lineUserId: string, channelId: string, optOut: boolean) {
  const { error } = await supabase.from('user_states').update({ marketing_opt_out: optOut }).eq('channel_id', channelId).eq('line_user_id', lineUserId);
  if (error) throw error;
}

/** 清除客戶的身分與對話足跡（user_states／conversations／handover_logs）。後端會再檢查是不是主帳號。 */
export async function purgeCustomerData(lineUserId: string) {
  await callFn('delete-customer-data', { lineUserId });
}

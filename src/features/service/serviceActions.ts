import { supabase } from '../../lib/supabase';

// ========================================================================
// 客服工作台的動作（V2 §32）。真人模式（is_human_mode）是唯一的「AI 暫停」開關：
//   接手對話   → is_human_mode=true，AI 不回；客人持續互動會延長，逾時自動切回（webhook 那邊）
//   轉回 AI    → is_human_mode=false，並把這位客人所有 open 的轉接紀錄關掉
//   標記已處理 → 只關掉轉接紀錄（客人喊了找真人、已經在 LINE 上回過了，但不需要靜音 AI）
//   回覆       → 走 custom-messages function（要用官方帳號的 token 推播），後端同時寫對話紀錄並開真人模式
// ========================================================================

async function currentEmail(): Promise<string> {
  const { data } = await supabase.auth.getUser();
  return data.user?.email || 'admin';
}

export async function takeOverConversation(lineUserId: string, channelId: string | null) {
  const now = new Date().toISOString();
  let q = supabase.from('user_states').update({ is_human_mode: true, last_human_interaction: now }).eq('line_user_id', lineUserId);
  if (channelId) q = q.eq('channel_id', channelId);
  const { error } = await q;
  if (error) throw error;
  // 留一筆轉接紀錄，轉接歷史才看得到「這次是客服主動接手」而不是客人喊的
  const { data: existing } = await supabase.from('handover_logs').select('id').eq('line_user_id', lineUserId).eq('status', 'open').limit(1);
  if (!existing?.length) {
    await supabase.from('handover_logs').insert({ channel_id: channelId, line_user_id: lineUserId, triggered_keyword: '客服主動接手', started_at: now, status: 'open' });
  }
}

export async function releaseToAi(lineUserId: string) {
  const { error } = await supabase
    .from('user_states')
    .update({ is_human_mode: false, last_ai_reset_at: new Date().toISOString() })
    .eq('line_user_id', lineUserId);
  if (error) throw error;
  await supabase
    .from('handover_logs')
    .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: await currentEmail() })
    .eq('line_user_id', lineUserId)
    .eq('status', 'open');
}

export async function resolveHandover(logId: string) {
  const { error } = await supabase
    .from('handover_logs')
    .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: await currentEmail() })
    .eq('id', logId);
  if (error) throw error;
}

export async function sendReply(lineUserId: string, channelId: string | null, text: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch('/.netlify/functions/custom-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'reply', lineUserId, channelId, text }),
  });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!res.ok) throw new Error(parsed?.error || `HTTP ${res.status}`);
}

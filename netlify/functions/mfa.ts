import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole, getAalFromToken } from '../../src/lib/requireRole';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ========================================================================
// 雙因素驗證相關的後端動作。用單一端點 + action 參數，避免為了幾行邏輯開四支函式。
//
//   complete-setup  綁定 TOTP 成功後把帳號推進到 active（需要 aal2）
//   record-failure  記一次驗證失敗，達門檻就上鎖
//   check-lock      查詢目前是否被鎖、還要等多久
//   reset           管理員重置別人的 2FA（需要 admin + aal2）
//
// 【速率限制的實際效力，先講清楚】
// 規格書要求「連續錯 5 次鎖 15 分鐘」，原本設計是放在 Redis。本專案沒有 Redis，
// 改用資料表達成。但更重要的限制是：TOTP 的驗證是前端直接打 Supabase 的 MFA API，
// 我們的後端不在那條路徑上，所以這裡擋的是「透過本系統介面」的連續嘗試。
// 真正對抗暴力破解的最後防線是 Supabase 自己對 MFA 驗證的內建速率限制，
// 那一層前端繞不過去。這裡的鎖定是額外的一層，不是唯一的一層。
// ========================================================================

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

async function getLockState(userId: string) {
  const { data } = await supabaseAdmin
    .from('mfa_login_attempts')
    .select('failed_count, locked_until')
    .eq('user_id', userId)
    .maybeSingle();

  const lockedUntil = data?.locked_until ? new Date(data.locked_until) : null;
  const locked = !!lockedUntil && lockedUntil.getTime() > Date.now();
  return {
    locked,
    lockedUntil: locked ? lockedUntil!.toISOString() : null,
    failedCount: data?.failed_count ?? 0,
    remainingAttempts: Math.max(0, MAX_FAILURES - (data?.failed_count ?? 0)),
  };
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };

  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return { statusCode: 401, body: JSON.stringify({ error: '登入狀態無效，請重新登入' }) };

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }
  const action = body.action;

  // ---- 綁定完成：把帳號推進到 active ----
  // 只認 aal2：代表這個 session 確實已經通過 TOTP 驗證。
  // 前端說「我綁好了」不算數，要看權杖本身的等級。
  if (action === 'complete-setup') {
    if (getAalFromToken(token) !== 'aal2') {
      return { statusCode: 403, body: JSON.stringify({ error: '尚未完成雙因素驗證，無法啟用帳號' }) };
    }

    const { data: profile } = await supabaseAdmin
      .from('admin_profiles').select('status').eq('id', user.id).maybeSingle();
    if (!profile) return { statusCode: 403, body: JSON.stringify({ error: '找不到帳號權限資料' }) };
    if (profile.status === 'suspended') {
      return { statusCode: 403, body: JSON.stringify({ error: '您的帳號已被停權，請聯繫管理員。' }) };
    }

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin.from('admin_profiles')
      .update({ status: 'active', mfa_enrolled_at: nowIso, updated_at: nowIso })
      .eq('id', user.id);
    if (error) return { statusCode: 500, body: JSON.stringify({ error: `啟用帳號失敗：${error.message}` }) };

    // 綁定成功等於這個人證明了身分，把先前的失敗計數清掉
    await supabaseAdmin.from('mfa_login_attempts').delete().eq('user_id', user.id);

    return { statusCode: 200, body: JSON.stringify({ status: 'active' }) };
  }

  // ---- 記一次失敗 ----
  if (action === 'record-failure') {
    const current = await getLockState(user.id);
    if (current.locked) return { statusCode: 200, body: JSON.stringify(current) };

    const nextCount = current.failedCount + 1;
    const shouldLock = nextCount >= MAX_FAILURES;
    const nowIso = new Date().toISOString();

    await supabaseAdmin.from('mfa_login_attempts').upsert({
      user_id: user.id,
      failed_count: shouldLock ? 0 : nextCount, // 上鎖時歸零，鎖到期後重新累計
      locked_until: shouldLock ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString() : null,
      last_failed_at: nowIso,
      updated_at: nowIso,
    }, { onConflict: 'user_id' });

    return { statusCode: 200, body: JSON.stringify(await getLockState(user.id)) };
  }

  // ---- 查詢鎖定狀態 ----
  if (action === 'check-lock') {
    return { statusCode: 200, body: JSON.stringify(await getLockState(user.id)) };
  }

  // ---- 管理員重置他人的 2FA ----
  if (action === 'reset') {
    const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
    if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };

    const targetUserId: string = body.userId;
    if (!targetUserId) return { statusCode: 400, body: JSON.stringify({ error: '缺少 userId' }) };
    if (targetUserId === user.id) {
      return { statusCode: 400, body: JSON.stringify({ error: '不能重置自己的 2FA。若您自己遺失驗證器，請參考 SUPABASE_AUTH_SETUP.md 的緊急解除指令。' }) };
    }

    // 把該帳號已綁定的所有 TOTP factor 移除，並退回待綁定狀態。
    // 下次登入時前端會偵測到沒有 factor，強制重新走一次綁定流程。
    const { data: factorsData, error: listError } = await supabaseAdmin.auth.admin.mfa.listFactors({ userId: targetUserId });
    if (listError) return { statusCode: 500, body: JSON.stringify({ error: `讀取驗證器失敗：${listError.message}` }) };

    for (const factor of factorsData?.factors || []) {
      const { error: delError } = await supabaseAdmin.auth.admin.mfa.deleteFactor({ userId: targetUserId, id: factor.id });
      if (delError) return { statusCode: 500, body: JSON.stringify({ error: `移除驗證器失敗：${delError.message}` }) };
    }

    const nowIso = new Date().toISOString();
    await supabaseAdmin.from('admin_profiles')
      .update({ status: 'pending_mfa', mfa_enrolled_at: null, updated_at: nowIso })
      .eq('id', targetUserId);
    await supabaseAdmin.from('mfa_login_attempts').delete().eq('user_id', targetUserId);

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, body: JSON.stringify({ error: `未知的 action: ${action}` }) };
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'mfa', rawHandler);

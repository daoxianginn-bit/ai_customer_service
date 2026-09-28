import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { LOG_FEATURES, withErrorLogging, writeOperationLog } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';

const supabaseAdmin = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// 後台帳號的 LINE 綁定，以及排程通知「依角色／個別帳號」挑收件人用的清單。
//
// 排程通知要能發給「所有會計」這種對象，系統得知道每個後台帳號的 LINE 是哪一個。LINE 的 user ID
// 只能從官方帳號的聯絡人（加了好友、傳過訊息的人）拿到，而且跟著官方帳號走，所以綁定＝挑一個
// 官方帳號底下的聯絡人，連同官方帳號一起存。不開放手打 LINE ID：那個 ID 推播不出去。
//
// action：
//   contacts  { channelId? }                     需 account.edit
//       官方帳號清單＋指定帳號底下的聯絡人（最近互動的 300 位）。聯絡人表與官方帳號表的 RLS
//       不一定開給管帳號的人讀，所以走這裡。
//   bind      { userId, channelId, lineUserId }  需 account.edit
//   unbind    { userId }                         需 account.edit
//   options   {}                                 需 automation.manage 或 account.view
//       排程設定頁挑收件人用：角色（含成員數、已綁 LINE 的人數）與帳號（有沒有綁 LINE）。
// ========================================================================

const json = (statusCode: number, body: unknown) => ({ statusCode, body: JSON.stringify(body) });

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: '請求格式錯誤' }); }

  const needed = body.action === 'options' ? ['automation.manage', 'account.view'] : 'account.edit';
  const guard = await requirePermission(supabaseAdmin, event as any, needed);
  if ('error' in guard) return json(guard.error.statusCode, { error: guard.error.body });
  const actorName = guard.user.email || guard.user.id;

  if (body.action === 'contacts') {
    const { data: channels } = await supabaseAdmin.from('line_channels').select('id, name, role, is_active').eq('is_active', true).order('display_order');
    const channelId = String(body.channelId || '');
    let contacts: any[] = [];
    if (channelId) {
      const { data } = await supabaseAdmin.from('user_states').select('line_user_id, nickname, last_message_at')
        .eq('channel_id', channelId).order('last_message_at', { ascending: false, nullsFirst: false }).limit(300);
      contacts = data || [];
    }
    return json(200, { channels: channels || [], contacts });
  }

  if (body.action === 'bind' || body.action === 'unbind') {
    const userId = String(body.userId || '');
    const { data: profile } = await supabaseAdmin.from('admin_profiles').select('id, email, display_name, line_display_name').eq('id', userId).maybeSingle();
    if (!profile) return json(404, { error: '找不到這個帳號' });
    const who = profile.display_name || profile.email || userId;

    if (body.action === 'unbind') {
      const { error } = await supabaseAdmin.from('admin_profiles').update({ line_channel_id: null, line_user_id: null, line_display_name: null, updated_at: new Date().toISOString() }).eq('id', userId);
      if (error) return json(500, { error: error.message });
      await writeOperationLog(supabaseAdmin, { feature: LOG_FEATURES.permission, action: '解除 LINE 綁定', target: who, actorType: 'user', actorName, before: { LINE: profile.line_display_name || '（已綁定）' }, after: null });
      return json(200, { ok: true });
    }

    const channelId = String(body.channelId || '');
    const lineUserId = String(body.lineUserId || '');
    // 只能綁「這個官方帳號真的有的聯絡人」：擋掉手打或跨帳號的 ID（推播一定失敗）
    const { data: contact } = await supabaseAdmin.from('user_states').select('line_user_id, nickname')
      .eq('channel_id', channelId).eq('line_user_id', lineUserId).maybeSingle();
    if (!contact) return json(400, { error: '這個官方帳號底下找不到這位聯絡人，請對方先加好友並傳一句話' });
    const { data: channel } = await supabaseAdmin.from('line_channels').select('name').eq('id', channelId).maybeSingle();
    const { error } = await supabaseAdmin.from('admin_profiles').update({
      line_channel_id: channelId, line_user_id: lineUserId, line_display_name: contact.nickname || null, updated_at: new Date().toISOString(),
    }).eq('id', userId);
    if (error) return json(500, { error: error.message });
    await writeOperationLog(supabaseAdmin, {
      feature: LOG_FEATURES.permission, action: '綁定 LINE', target: who, actorType: 'user', actorName,
      before: profile.line_display_name ? { LINE: profile.line_display_name } : null,
      after: { LINE: `${contact.nickname || '（未取得暱稱）'}（${channel?.name || '官方帳號'}）` },
    });
    return json(200, { ok: true, line_display_name: contact.nickname || null, channel_name: channel?.name || null });
  }

  if (body.action === 'options') {
    const [{ data: roles }, { data: userRoles }, { data: profiles }, { data: users }] = await Promise.all([
      supabaseAdmin.from('roles').select('id, name, is_active, sort_order').order('sort_order').order('name'),
      supabaseAdmin.from('user_roles').select('user_id, role_id'),
      supabaseAdmin.from('admin_profiles').select('id, email, display_name, status, line_user_id'),
      supabaseAdmin.auth.admin.listUsers(),
    ]);
    const emailById = new Map((users?.users || []).map((u) => [u.id, u.email]));
    const accounts = (profiles || [])
      .filter((p: any) => p.status === 'active')
      .map((p: any) => ({
        id: p.id,
        name: p.display_name || p.email || emailById.get(p.id) || p.id,
        has_line: !!p.line_user_id,
        role_ids: (userRoles || []).filter((r: any) => r.user_id === p.id).map((r: any) => r.role_id),
      }));
    const roleOptions = (roles || []).filter((r: any) => r.is_active !== false).map((r: any) => {
      const members = accounts.filter((a) => a.role_ids.includes(r.id));
      return { id: r.id, name: r.name, member_count: members.length, line_count: members.filter((m) => m.has_line).length };
    });
    return json(200, { roles: roleOptions, accounts });
  }

  return json(400, { error: `未知的 action: ${body.action}` });
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'staff-line', rawHandler);

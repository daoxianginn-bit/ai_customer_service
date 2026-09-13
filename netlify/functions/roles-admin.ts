import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { RbacError, assignUserRoles, deleteRole, loadUserPermissions, saveRole, setRoleActive } from '../../src/lib/rbacService';

const supabaseAdmin = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// 角色與權限的寫入 API（權限管理 V2）。讀取（角色清單、權限目錄、使用者角色）前端直接查表（RLS 允許），
// 所有寫入集中在這裡：檢查相依、防止權限提升、系統角色與最後管理者保護、樂觀鎖、稽核，全在 rbacService。
//
// action：
//   save_role        { id?, name, description, permission_codes[], expected_version? }   需 role.manage
//   set_role_active  { id, is_active }                                                    需 role.manage
//   delete_role      { id }                                                               需 role.manage
//   assign_user      { user_id, role_ids[] }                                              需 role.assign
//   my_grantable     {}  → 呼叫者可授予的權限 code（角色編輯器把其餘的鎖起來）                需 role.view
// ========================================================================
const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }

  const needed = body.action === 'assign_user' ? 'role.assign' : body.action === 'my_grantable' ? 'role.view' : 'role.manage';
  const guard = await requirePermission(supabaseAdmin, event as any, needed);
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };
  const actor = { id: guard.user.id, email: guard.user.email || guard.user.id, isOwner: guard.isOwner };

  try {
    switch (body.action) {
      case 'save_role': {
        const result = await saveRole(supabaseAdmin, actor, {
          id: body.id || null, name: body.name, description: body.description,
          permission_codes: Array.isArray(body.permission_codes) ? body.permission_codes : [],
          expected_version: body.expected_version ?? null,
        });
        return { statusCode: 200, body: JSON.stringify(result) };
      }
      case 'set_role_active':
        await setRoleActive(supabaseAdmin, actor, String(body.id || ''), !!body.is_active);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      case 'delete_role':
        await deleteRole(supabaseAdmin, actor, String(body.id || ''));
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      case 'assign_user': {
        const result = await assignUserRoles(supabaseAdmin, actor, String(body.user_id || ''), Array.isArray(body.role_ids) ? body.role_ids.map(String) : []);
        return { statusCode: 200, body: JSON.stringify(result) };
      }
      case 'my_grantable': {
        const mine = actor.isOwner ? null : [...(await loadUserPermissions(supabaseAdmin, actor.id))];
        return { statusCode: 200, body: JSON.stringify({ is_owner: actor.isOwner, grantable: mine }) };
      }
      default:
        return { statusCode: 400, body: JSON.stringify({ error: `未知的 action: ${body.action}` }) };
    }
  } catch (e: any) {
    if (e instanceof RbacError) return { statusCode: e.statusCode, body: JSON.stringify({ error: e.message }) };
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || '未知錯誤' }) };
  }
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'roles-admin', rawHandler);

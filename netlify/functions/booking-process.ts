import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import { buildMergeFields, computeTodayTomorrowFields, type MessageVariable } from '../../src/lib/messageVariables';
import { LOG_FEATURES, withErrorLogging, writeOperationLog } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { resendLaundrySheet } from './scheduled-tasks-run';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// 訂單處理（人工關卡工作台）的後端：
//   context              { bookingId }                                 需 booking.view
//       回這筆訂單的合併欄位（含 [入住密碼]）、有沒有 LINE 帳號、官方帳號剩餘額度，給通知對話框做即時預覽。
//   notify               { bookingId, stage, template, templateTitle }  需 booking.notify
//       用範本推播給這筆訂單的客人：變數在這裡代入（跟預覽同一份欄位）、寫進對話紀錄（客服工作台看得到）、
//       記到 booking_stage_actions（列上顯示「已通知」）、寫操作紀錄。不切換真人模式——這是通知，不是對話。
//   set_stage_templates  { stageTemplates }                             需 booking.edit
//       各關卡預設範本（settings.stage_templates）。settings 的 RLS 只讓系統管理權限改，訂單處理的人不一定有，所以走這裡。
//   resend_laundry       { date }                                       需 housekeeping.manage
//       用排程的洗滌單設定，把當天入住訂單的布巾數量重新加總再發一次（開頭加【更新】）。
// ========================================================================

const STAGES = ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund', 'checkin'];

function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) result = result.split(`[${key}]`).join(value ?? '');
  return result;
}

async function loadBookingContext(bookingId: string) {
  const [{ data: booking }, { data: settings }, { data: variables }] = await Promise.all([
    supabase.from('bookings').select('*').eq('id', bookingId).maybeSingle(),
    supabase.from('settings').select('*').limit(1).maybeSingle(),
    supabase.from('message_variables').select('variable_name, source, field_key').order('display_order'),
  ]);
  if (!booking) return null;
  const { data: state } = booking.line_user_id
    ? await supabase.from('user_states').select('channel_id, nickname').eq('line_user_id', booking.line_user_id).order('last_message_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    : { data: null };
  const fields: Record<string, string> = {
    ...buildMergeFields((variables || []) as MessageVariable[], { booking, customer: state ? { ...state, line_user_id: booking.line_user_id } : { nickname: booking.nickname, line_user_id: booking.line_user_id }, settings }),
    ...computeTodayTomorrowFields(),
    // [入住密碼] 是特殊變數（不在一般欄位白名單裡），只有這種「發給客人本人」的通知才代入
    入住密碼: booking.check_in_password || '（尚未設定）',
  };
  const channelId = booking.channel_id || state?.channel_id || null;
  return { booking, settings, fields, channelId, nickname: state?.nickname || booking.nickname || null };
}

async function fetchChannel(channelId: string | null) {
  if (channelId) {
    const { data } = await supabase.from('line_channels').select('id, name, channel_access_token, channel_secret').eq('id', channelId).maybeSingle();
    if (data?.channel_access_token) return data;
  }
  // 沒記錄所屬帳號的舊訂單：退回啟用中的客戶用帳號
  const { data } = await supabase.from('line_channels').select('id, name, channel_access_token, channel_secret').eq('role', 'customer').eq('is_active', true).order('created_at').limit(1).maybeSingle();
  return data || null;
}

async function lineQuota(token: string): Promise<{ limit: number | null; used: number; remaining: number | null } | null> {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const [q, c] = await Promise.all([fetch('https://api.line.me/v2/bot/message/quota', { headers }), fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers })]);
    const quota: any = await q.json(); const consumption: any = await c.json();
    if (!q.ok) return null;
    const limit = quota.type === 'limited' ? quota.value : null;
    const used = consumption.totalUsage || 0;
    return { limit, used, remaining: limit == null ? null : Math.max(0, limit - used) };
  } catch { return null; }
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }

  const needed = body.action === 'notify' ? 'booking.notify'
    : body.action === 'set_stage_templates' ? 'booking.edit'
      : body.action === 'resend_laundry' ? 'housekeeping.manage'
        : 'booking.view';
  const guard = await requirePermission(supabase, event as any, needed);
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };
  const actorName = guard.user.email || guard.user.id;

  try {
    if (body.action === 'context') {
      const ctx = await loadBookingContext(String(body.bookingId || ''));
      if (!ctx) return { statusCode: 404, body: JSON.stringify({ error: '找不到這筆訂單' }) };
      const channel = ctx.booking.line_user_id ? await fetchChannel(ctx.channelId) : null;
      const quota = channel?.channel_access_token ? await lineQuota(channel.channel_access_token) : null;
      return {
        statusCode: 200,
        body: JSON.stringify({
          fields: ctx.fields,
          hasLine: !!ctx.booking.line_user_id && !!channel,
          channelName: channel?.name || null,
          nickname: ctx.nickname,
          quota,
        }),
      };
    }

    if (body.action === 'notify') {
      const stage = String(body.stage || '');
      if (!STAGES.includes(stage)) return { statusCode: 400, body: JSON.stringify({ error: '未知的關卡' }) };
      const template = String(body.template || '').trim();
      if (!template) return { statusCode: 400, body: JSON.stringify({ error: '訊息內容是空的' }) };
      const ctx = await loadBookingContext(String(body.bookingId || ''));
      if (!ctx) return { statusCode: 404, body: JSON.stringify({ error: '找不到這筆訂單' }) };
      if (!ctx.booking.line_user_id) return { statusCode: 400, body: JSON.stringify({ error: '這筆訂單沒有 LINE 帳號（第三方平台或手動建立的訂單），無法推播' }) };
      const channel = await fetchChannel(ctx.channelId);
      if (!channel?.channel_access_token) return { statusCode: 500, body: JSON.stringify({ error: '找不到客戶用官方帳號的憑證，請至串接管理確認' }) };

      const text = mergeTemplate(template, ctx.fields);
      const client = new Client({ channelAccessToken: channel.channel_access_token, channelSecret: channel.channel_secret });
      await client.pushMessage(ctx.booking.line_user_id, { type: 'text', text });

      const now = new Date().toISOString();
      const templateTitle = String(body.templateTitle || '').trim() || null;
      await supabase.from('conversations').insert({
        channel_id: channel.id, line_user_id: ctx.booking.line_user_id, nickname: ctx.nickname, direction: 'outbound', content: text, source: 'human_agent',
      });
      await supabase.from('booking_stage_actions').upsert(
        { booking_id: ctx.booking.id, stage, notified_at: now, notified_by: actorName, template_title: templateTitle, message: text, updated_at: now },
        { onConflict: 'booking_id,stage' },
      );
      await writeOperationLog(supabase, {
        feature: LOG_FEATURES.order, action: '發送通知', target: ctx.booking.order_number || ctx.booking.id, actorType: 'user', actorName,
        before: null, after: { 關卡: stage, 範本: templateTitle || '（自訂內容）', 內容: text.length > 120 ? `${text.slice(0, 120)}…` : text },
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, sentAt: now, text }) };
    }

    if (body.action === 'set_stage_templates') {
      const map = body.stageTemplates && typeof body.stageTemplates === 'object' ? body.stageTemplates : {};
      const clean: Record<string, string> = {};
      for (const k of STAGES) if (map[k]) clean[k] = String(map[k]);
      const { data: settings } = await supabase.from('settings').select('id').limit(1).maybeSingle();
      if (!settings) return { statusCode: 500, body: JSON.stringify({ error: '讀取系統設定失敗' }) };
      const { error } = await supabase.from('settings').update({ stage_templates: clean }).eq('id', settings.id);
      if (error) return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
      await writeOperationLog(supabase, { feature: LOG_FEATURES.order, action: '設定關卡預設範本', target: '訂單處理', actorType: 'user', actorName, before: null, after: clean });
      return { statusCode: 200, body: JSON.stringify({ ok: true, stageTemplates: clean }) };
    }

    if (body.action === 'resend_laundry') {
      const date = String(body.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { statusCode: 400, body: JSON.stringify({ error: '日期格式錯誤' }) };
      const result = await resendLaundrySheet(date);
      await writeOperationLog(supabase, { feature: LOG_FEATURES.scheduledTask, action: result.ok ? '重發洗滌單' : '重發洗滌單失敗', target: date, actorType: 'user', actorName, before: null, after: { 結果: result.summary } });
      return { statusCode: result.ok ? 200 : 400, body: JSON.stringify(result.ok ? { ok: true, summary: result.summary } : { error: result.summary }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `未知的 action: ${body.action}` }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || '未知錯誤' }) };
  }
};

export const handler: Handler = withErrorLogging(supabase, 'booking-process', rawHandler);

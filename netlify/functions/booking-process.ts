import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import { buildMergeFields, buildStandardFields, computeTodayTomorrowFields, type MessageVariable } from '../../src/lib/messageVariables';
import { LOG_FEATURES, withErrorLogging, writeOperationLog } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { notifyPaymentStaff, resendLaundrySheet } from './scheduled-tasks-run';
import { BALANCE_PAID_STATUSES } from '../../src/lib/bookingStatus';
import {
  extraChargeCode, isBlankExtraChargeInput, nextExtraChargeLetters, remainingExtraChargeSlots, validateExtraChargeInput, type ExtraChargeInput,
} from '../../src/lib/extraCharges';

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
//   extra_add            { bookingId, items: [{ title, amount, internal_note?, paid? }] }  需 booking.edit 或 booking.payment.verify
//       新增追加款（可多筆，全部成功或全部失敗）。字母由這裡配發；paid=true 只有款項核對權限能帶。
//       訂單已經過了尾款關卡（尾款已收）還有新的未付項目時，通知會計。
//   extra_update         { id, title, amount, internal_note }            需 booking.edit 或 booking.payment.verify（已付、已作廢的不能改）
//   extra_void           { id }                                          同上
//   extra_set_paid       { bookingId, ids?, paid }                       需 booking.payment.verify；不帶 ids＝這筆訂單所有未付的
// 追加款只能由後台人員透過這裡新增；LINE 機器人沒有任何寫入追加款的程式碼。
// ========================================================================

const STAGES = ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund', 'linen', 'checkin_password', 'room_check'];

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
  const ctx = { booking, customer: state ? { ...state, line_user_id: booking.line_user_id } : { nickname: booking.nickname, line_user_id: booking.line_user_id }, settings };
  const fields: Record<string, string> = {
    // 標準欄位先鋪底（管理員沒建對照也能用），管理員自訂的同名變數蓋過去
    ...buildStandardFields(ctx),
    ...buildMergeFields((variables || []) as MessageVariable[], ctx),
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

// ------------------------------------------------------------------------
// 追加款
// ------------------------------------------------------------------------
type ActionResult = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string): ActionResult => ({ status, body: { error } });
const money = (n: number) => `NT$${Number(n).toLocaleString()}`;
// 已取消／退款中的訂單不再加收
const EXTRA_CLOSED_STATUSES = ['cancelled', 'awaiting_refund', 'refunded'];

async function addExtraCharges(bookingId: string, rawItems: ExtraChargeInput[], actorName: string, canMarkPaid: boolean): Promise<ActionResult> {
  const { data: booking } = await supabase.from('bookings').select('id, order_number, status, name, nickname, checkin_date, checkout_date').eq('id', bookingId).maybeSingle();
  if (!booking) return fail(404, '找不到這筆訂單');
  if (EXTRA_CLOSED_STATUSES.includes(booking.status)) return fail(400, '已取消的訂單不能再新增追加款');

  // 整列空白的略過；其餘每一列都要合格，任何一列不合格就整批不存（跟對話框的檢查同一套規則）
  const items = rawItems.filter((it) => !isBlankExtraChargeInput(it));
  if (!items.length) return fail(400, '沒有要新增的項目');
  for (let i = 0; i < items.length; i++) {
    const err = validateExtraChargeInput(items[i]);
    if (err) return fail(400, `第 ${i + 1} 列：${err.title || err.amount}`);
  }
  if (items.some((it) => it.paid) && !canMarkPaid) return fail(403, '只有會計（款項核對權限）可以在新增時直接勾選已付');

  // 字母在這裡配發。兩個人同時新增會撞同一個字母，資料庫的 UNIQUE(booking_id, seq) 會擋下其中一個，
  // 被擋的重新讀一次已用字母再試；整批一次 insert，所以不會存一半。
  let inserted: any[] | null = null;
  for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
    const { data: existing, error: readError } = await supabase.from('booking_extra_charges').select('seq').eq('booking_id', bookingId);
    if (readError) return fail(500, readError.message);
    const used = (existing || []).map((r: any) => String(r.seq));
    const letters = nextExtraChargeLetters(used, items.length);
    if (!letters) {
      const left = remainingExtraChargeSlots(used);
      return fail(400, left > 0 ? `這筆訂單最多只能再新增 ${left} 項（編號到 Z 為止）` : '這筆訂單的追加款已達上限（Z），不能再新增');
    }
    const now = new Date().toISOString();
    const rows = items.map((it, i) => ({
      booking_id: bookingId,
      seq: letters[i],
      title: String(it.title).trim(),
      amount: Number(it.amount),
      internal_note: String(it.internal_note ?? '').trim() || null,
      is_paid: !!it.paid,
      paid_at: it.paid ? now : null,
      paid_by: it.paid ? actorName : null,
      created_by: actorName,
    }));
    const { data, error } = await supabase.from('booking_extra_charges').insert(rows).select('*');
    if (!error) { inserted = data || []; break; }
    if (error.code !== '23505') return fail(500, error.message);
  }
  if (!inserted) return fail(409, '同時有其他人在新增追加款，請重新整理後再試一次');

  const summary = inserted.map((r) => `${extraChargeCode(booking.order_number, r.seq)} ${r.title} ${money(r.amount)}${r.is_paid ? '（已付）' : ''}`);
  await writeOperationLog(supabase, {
    feature: LOG_FEATURES.order, action: '新增追加款', target: booking.order_number || booking.id, actorType: 'user', actorName,
    before: null, after: { 追加款: summary.join('、') },
  });

  // 尾款已經收過了（過了尾款關卡），新的未付項目沒有下一關會自動收，要讓會計當下就知道
  const unpaid = inserted.filter((r) => !r.is_paid);
  let notice: string | null = null;
  if (unpaid.length && BALANCE_PAID_STATUSES.includes(booking.status)) {
    const lines = unpaid.map((r) => `・${extraChargeCode(booking.order_number, r.seq)} ${r.title} ${money(r.amount)}`);
    const total = unpaid.reduce((s, r) => s + Number(r.amount), 0);
    notice = await notifyPaymentStaff(
      `💰 新增追加款（尾款已收，這筆要另外收）\n訂單 ${booking.order_number || '—'}・${booking.name || booking.nickname || '未取得'}・${booking.checkin_date || ''}~${booking.checkout_date || ''}\n${lines.join('\n')}\n合計 ${money(total)}\n新增者：${actorName}`
    );
  }
  return { status: 200, body: { ok: true, rows: inserted, notice } };
}

async function editExtraCharge(mode: 'update' | 'void', id: string, body: any, actorName: string): Promise<ActionResult> {
  const { data: row } = await supabase.from('booking_extra_charges').select('*, bookings(order_number, status)').eq('id', id).maybeSingle();
  if (!row) return fail(404, '找不到這筆追加款');
  if (row.voided_at) return fail(400, '這筆追加款已經作廢');
  // 已付的鎖住：金額改了會跟實際收到的錢對不上。真的要改，會計先取消勾選再改
  if (row.is_paid) return fail(400, '已付的追加款不能修改或作廢，請先請會計取消「已付」');
  const code = extraChargeCode(row.bookings?.order_number, row.seq);
  const now = new Date().toISOString();

  if (mode === 'void') {
    const { error } = await supabase.from('booking_extra_charges').update({ voided_at: now, voided_by: actorName, updated_at: now }).eq('id', id);
    if (error) return fail(500, error.message);
    await writeOperationLog(supabase, {
      feature: LOG_FEATURES.order, action: '作廢追加款', target: row.bookings?.order_number || row.booking_id, actorType: 'user', actorName,
      before: { 追加款: `${code} ${row.title} ${money(row.amount)}` }, after: { 追加款: `${code} 已作廢` },
    });
    return { status: 200, body: { ok: true } };
  }

  const err = validateExtraChargeInput(body);
  if (err) return fail(400, err.title || err.amount || '資料不正確');
  const patch = { title: String(body.title).trim(), amount: Number(body.amount), internal_note: String(body.internal_note ?? '').trim() || null, updated_at: now };
  const { error } = await supabase.from('booking_extra_charges').update(patch).eq('id', id);
  if (error) return fail(500, error.message);
  await writeOperationLog(supabase, {
    feature: LOG_FEATURES.order, action: '修改追加款', target: row.bookings?.order_number || row.booking_id, actorType: 'user', actorName,
    before: { 追加款: `${code} ${row.title} ${money(row.amount)}` }, after: { 追加款: `${code} ${patch.title} ${money(patch.amount)}` },
  });
  return { status: 200, body: { ok: true } };
}

async function setExtraChargesPaid(bookingId: string, ids: string[] | null, paid: boolean, actorName: string): Promise<ActionResult> {
  const { data: booking } = await supabase.from('bookings').select('id, order_number').eq('id', bookingId).maybeSingle();
  if (!booking) return fail(404, '找不到這筆訂單');
  let query = supabase.from('booking_extra_charges').select('id, seq, title, amount, is_paid').eq('booking_id', bookingId).is('voided_at', null).eq('is_paid', !paid);
  if (ids) {
    if (!ids.length) return { status: 200, body: { ok: true, changed: 0 } };
    query = query.in('id', ids);
  }
  const { data: rows, error: readError } = await query;
  if (readError) return fail(500, readError.message);
  if (!rows?.length) return { status: 200, body: { ok: true, changed: 0 } };

  const now = new Date().toISOString();
  const { error } = await supabase.from('booking_extra_charges')
    .update(paid ? { is_paid: true, paid_at: now, paid_by: actorName, updated_at: now } : { is_paid: false, paid_at: null, paid_by: null, updated_at: now })
    .in('id', rows.map((r: any) => r.id));
  if (error) return fail(500, error.message);
  await writeOperationLog(supabase, {
    feature: LOG_FEATURES.order, action: paid ? '追加款已收' : '追加款取消已付', target: booking.order_number || booking.id, actorType: 'user', actorName,
    before: null, after: { 追加款: rows.map((r: any) => `${extraChargeCode(booking.order_number, r.seq)} ${r.title} ${money(r.amount)}`).join('、') },
  });
  return { status: 200, body: { ok: true, changed: rows.length } };
}

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }

  const EXTRA_EDIT = ['booking.edit', 'booking.payment.verify'];
  const needed: string | string[] = body.action === 'notify' ? 'booking.notify'
    : body.action === 'set_stage_templates' ? 'booking.edit'
      : body.action === 'resend_laundry' ? 'housekeeping.manage'
        : ['extra_add', 'extra_update', 'extra_void'].includes(body.action) ? EXTRA_EDIT
          : body.action === 'extra_set_paid' ? 'booking.payment.verify'
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

    if (body.action === 'extra_add') {
      const canMarkPaid = await guard.permissions.has('booking.payment.verify');
      const r = await addExtraCharges(String(body.bookingId || ''), Array.isArray(body.items) ? body.items : [], actorName, canMarkPaid);
      return { statusCode: r.status, body: JSON.stringify(r.body) };
    }
    if (body.action === 'extra_update' || body.action === 'extra_void') {
      const r = await editExtraCharge(body.action === 'extra_void' ? 'void' : 'update', String(body.id || ''), body, actorName);
      return { statusCode: r.status, body: JSON.stringify(r.body) };
    }
    if (body.action === 'extra_set_paid') {
      const r = await setExtraChargesPaid(String(body.bookingId || ''), Array.isArray(body.ids) ? body.ids.map(String) : null, body.paid !== false, actorName);
      return { statusCode: r.status, body: JSON.stringify(r.body) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `未知的 action: ${body.action}` }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || '未知錯誤' }) };
  }
};

export const handler: Handler = withErrorLogging(supabase, 'booking-process', rawHandler);

/** 測試用：追加款的規則（字母配發、權限、已取消不能加、尾款已收要通知會計）不經過登入驗證直接驗 */
export const __extraChargeTesting = { addExtraCharges, setExtraChargesPaid };

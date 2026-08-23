import { Handler } from '@netlify/functions';
import { Client } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { buildMergeFields, MessageVariable, computeTodayTomorrowFields } from '../../src/lib/messageVariables';
import { LineChannel } from '../../src/lib/lineChannels';
import { withErrorLogging } from '../../src/lib/operationLog';

// ========================================================================
// 客製訊息發送（客製訊息發送頁）專用 function：
// - list：依關鍵字/入住日期區間/訂單狀態/房型查詢訂單清單
// - quota：查詢 LINE 官方帳號本月訊息額度（用/剩），發送前讓後台先看到還剩多少
// - send：把合併好欄位的訊息，用 push message 實際發送給勾選的客人
//
// 跟 line-webhook.ts 用同一份 LINE 頻道金鑰，但這是「後台主動發起」的動作，
// 所以額外要求呼叫者帶有效的 Supabase 登入 token，避免被匿名呼叫濫用（會消耗 LINE 免費額度）。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// 單次發送人數上限：同步逐一 push，人太多容易超過 Netlify function 執行時間上限被砍掉，
// 前端跟後端都用這個常數擋，超過就請對方分批送。
const MAX_BATCH_SEND = 50;

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  const token = authHeader?.replace(/^Bearer\s+/i, '');
  if (!token) return { statusCode: 401, body: JSON.stringify({ error: '未登入' }) };
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) return { statusCode: 401, body: JSON.stringify({ error: '登入已過期，請重新整理頁面' }) };

  let body: any;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) };
  }

  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').single();
  if (settingsError || !settings) return { statusCode: 500, body: JSON.stringify({ error: '讀取系統設定失敗' }) };

  try {
    if (body.action === 'quota') {
      // 額度是「每個官方帳號各自的」，跟著使用者在頁面上選的發送帳號查，不是永遠查客戶用帳號。
      const channel = await fetchChannelById(body.channelId);
      if (!channel?.channel_access_token) return { statusCode: 400, body: JSON.stringify({ error: '找不到這個官方帳號的憑證' }) };
      const quota = await getLineQuota(channel.channel_access_token);
      return { statusCode: 200, body: JSON.stringify(quota) };
    }

    if (body.action === 'list') {
      // 訂單資料一律來自客戶用帳號（訂房只會發生在那個帳號底下），跟「要用哪個帳號發送」無關——
      // 這就是「跨官方帳號取得資訊」：即使等一下要用團隊內部帳號發送，這裡仍然看得到客戶的訂單資訊，
      // 可以拿來當發送內容的參考／合併欄位來源。
      const { variables, rows } = await listOrders(settings, {
        keyword: body.keyword,
        startDate: body.startDate,
        endDate: body.endDate,
        status: body.status,
        roomType: body.roomType,
        roomId: body.roomId,
      });
      return { statusCode: 200, body: JSON.stringify({ variables, rows }) };
    }

    if (body.action === 'customers') {
      // 「客戶名單」模式：查客戶用帳號底下互動過的人，一人一列（不像 list 那樣一筆訂單一列，
      // 同一人訂過兩次房會出現兩列，勾兩列發送就會重複發送給同一人）。用於單純想發廣播訊息、
      // 不需要依訂單條件篩選的情境。
      const { variables, rows } = await listCustomers(settings, body.keyword);
      return { statusCode: 200, body: JSON.stringify({ variables, rows }) };
    }

    if (body.action === 'channels') {
      // 給前端的官方帳號下拉選單，以及選定帳號後可以套用的通知名單（不用打開後台另一頁去查）。
      const { data: channels } = await supabase.from('line_channels').select('id, name, role').eq('is_active', true).order('display_order');
      return { statusCode: 200, body: JSON.stringify({ channels: channels || [] }) };
    }

    if (body.action === 'contacts') {
      // 發送帳號不是客戶用帳號時，收件人不能從訂單清單挑（那些 line_user_id 屬於客戶用帳號，
      // 在別的官方帳號底下完全是無效的 ID，push 一定失敗）。改成列出「這個帳號自己的聯絡人」，
      // 外加它底下已經存好的通知名單，讓管理員可以一鍵套用不用整批手動勾選。
      //
      // LINE 群組（機器人被邀進去的群組，例如內部推播通知用的群組）也併進同一份清單一起回傳，
      // 用 is_group 標示——LINE 的 push message「to」欄位不分 userId／groupId，同一套發送邏輯
      // 直接就能送給群組，不需要另外做一套發送流程，前端只要能分辨顯示、不用改送出的程式碼。
      const channelId: string = body.channelId || '';
      if (!channelId) return { statusCode: 400, body: JSON.stringify({ error: '缺少 channelId' }) };
      const [{ data: contacts }, { data: groups }, { data: lineGroups }] = await Promise.all([
        supabase.from('user_states').select('line_user_id, nickname').eq('channel_id', channelId).order('last_message_at', { ascending: false, nullsFirst: false }),
        supabase.from('notification_recipient_groups').select('id, name, line_user_ids').eq('channel_id', channelId).order('created_at', { ascending: false }),
        supabase.from('line_groups').select('group_id, name').eq('channel_id', channelId).eq('is_active', true).order('last_message_at', { ascending: false, nullsFirst: false }),
      ]);
      const contactList = [
        ...(contacts || []).map((c: any) => ({ line_user_id: c.line_user_id, nickname: c.nickname, is_group: false })),
        ...(lineGroups || []).map((g: any) => ({ line_user_id: g.group_id, nickname: g.name || '（未取得群組名稱）', is_group: true })),
      ];
      return { statusCode: 200, body: JSON.stringify({ contacts: contactList, groups: groups || [] }) };
    }

    if (body.action === 'send') {
      const recipients: { lineUserId: string; fields: Record<string, string>; bookingId?: string }[] = Array.isArray(body.recipients) ? body.recipients : [];
      const template: string = body.template || '';
      if (!recipients.length) return { statusCode: 400, body: JSON.stringify({ error: '沒有選擇收件人' }) };
      if (!template.trim()) return { statusCode: 400, body: JSON.stringify({ error: '訊息內容是空的' }) };
      if (recipients.length > MAX_BATCH_SEND) {
        return { statusCode: 400, body: JSON.stringify({ error: `一次最多發送 ${MAX_BATCH_SEND} 位，請分批發送（這次選了 ${recipients.length} 位）` }) };
      }

      // 用哪個官方帳號發送由前端指定（預設客戶用，可切換成廠商用／團隊內部用），
      // 收件人的 line_user_id 一定要屬於同一個帳號，混用會整批發送失敗。
      const channel = await fetchChannelById(body.channelId);
      if (!channel?.channel_access_token) {
        return { statusCode: 500, body: JSON.stringify({ error: '找不到指定官方帳號的憑證，請至系統設定 → LINE 串接設定確認' }) };
      }

      const lineClient = new Client({
        channelAccessToken: channel.channel_access_token,
        channelSecret: channel.channel_secret,
      });

      // 發訊息跟改訂單狀態是兩件事，故意不放在同一個動作裡——要改狀態一律回訂單管理頁做。
      const results: { lineUserId: string; ok: boolean; error?: string }[] = [];
      for (const r of recipients) {
        const message = mergeTemplate(template, r.fields || {});
        try {
          await lineClient.pushMessage(r.lineUserId, { type: 'text', text: message });
          results.push({ lineUserId: r.lineUserId, ok: true });
        } catch (e: any) {
          results.push({ lineUserId: r.lineUserId, ok: false, error: e.message });
        }
      }
      return { statusCode: 200, body: JSON.stringify({ results }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: `未知的 action: ${body.action}` }) };
  } catch (e: any) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || '未知錯誤' }) };
  }
};

function mergeTemplate(template: string, fields: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(fields)) {
    result = result.split(`[${key}]`).join(value ?? '');
  }
  return result;
}

// ========================================================================
// 訂單清單查詢：以 `bookings` 為主要來源，供「客製訊息發送」共用的查詢邏輯。
// 每一列同時回傳：
// - 固定的顯示/識別欄位（id/line_user_id/name/checkin_date/...）：table 欄位跟發送對象一定要靠這些穩定
//   的 key 才找得到，不會因為管理員在「訊息變數資料維護」改名/刪除變數而跟著壞掉。
// - fields：依「訊息變數資料維護」目前設定的變數清單，動態算出來的合併欄位（給範本 [變數名稱] 套用）。
// ========================================================================

const MAX_ORDERS = 200; // 避免一次查太多筆，之後若要看更多可以再加分頁

interface OrderFilters {
  keyword?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
  roomType?: string; // 房間名稱；booking_rooms 還沒建立時的舊比對方式，以及「包棟」這個特殊值
  roomId?: string;   // room_types.id，正式的房間關聯
}

/**
 * 這個房間對應到哪些訂單。
 * booking_rooms 才是「這張訂單開了哪幾間房」的正式關聯；bookings.room_type_label 只是
 * 給人看的文字（訂單管理可以手打），拿來比對會因為打錯字或改名就篩不到。
 * 資料表還不存在（schema 尚未執行）時回傳 null，呼叫端會退回舊的文字比對，頁面不會壞掉。
 */
async function bookingIdsForRoom(roomId: string): Promise<string[] | null> {
  const { data, error } = await supabase.from('booking_rooms').select('booking_id').eq('room_type_id', roomId);
  if (error) return null;
  return Array.from(new Set((data || []).map((r: any) => r.booking_id)));
}

/** 每張訂單實際連結到的房間名稱，供列表的「房型」欄顯示。 */
async function roomLabelsByBooking(bookingIds: string[]): Promise<Record<string, string[]>> {
  if (!bookingIds.length) return {};
  const { data, error } = await supabase.from('booking_rooms').select('booking_id, room_type_id').in('booking_id', bookingIds);
  if (error || !data?.length) return {};
  const roomIds = Array.from(new Set(data.map((r: any) => r.room_type_id)));
  const { data: rooms } = await supabase.from('room_types').select('id, name').in('id', roomIds);
  const nameById = new Map((rooms || []).map((r: any) => [r.id, r.name]));
  const map: Record<string, string[]> = {};
  for (const link of data) {
    const name = nameById.get(link.room_type_id);
    if (!name) continue;
    if (!map[link.booking_id]) map[link.booking_id] = [];
    map[link.booking_id].push(name);
  }
  return map;
}

// 依 id 查一個官方帳號的憑證；不給 id 時退回客戶用帳號（頁面預設值，也是舊版行為的 fallback）。
async function fetchChannelById(channelId?: string): Promise<LineChannel | null> {
  let query = supabase.from('line_channels').select('*').eq('is_active', true);
  query = channelId ? query.eq('id', channelId) : query.eq('role', 'customer');
  const { data } = await query.order('display_order').limit(1).maybeSingle();
  return (data as LineChannel) || null;
}

async function fetchMessageVariables(): Promise<MessageVariable[]> {
  const { data } = await supabase.from('message_variables').select('variable_name, source, field_key').order('display_order');
  return (data as MessageVariable[]) || [];
}

async function listOrders(settings: any, filters: OrderFilters): Promise<{ variables: string[]; rows: any[] }> {
  let query = supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(MAX_ORDERS);

  if (filters.startDate) query = query.gte('checkin_date', filters.startDate);
  if (filters.endDate) query = query.lte('checkin_date', filters.endDate);
  // 沒有指定狀態時排除已取消，跟「訂單管理」的預設清單同一條規則——同一批訂單在兩個畫面
  // 應該長得一樣，不然這裡會一直看到訂單管理已經不顯示的舊資料。
  if (filters.status) query = query.eq('status', filters.status);
  else query = query.neq('status', 'cancelled');
  if (filters.roomType === '包棟') {
    query = query.eq('whole_house', true);
  } else if (filters.roomId) {
    const ids = await bookingIdsForRoom(filters.roomId);
    if (ids === null) {
      // booking_rooms 還沒建立，退回舊的文字比對，功能照舊
      if (filters.roomType) query = query.ilike('room_type_label', `%${filters.roomType}%`);
    } else if (ids.length === 0) {
      // 這個房型沒有任何訂單：訂單清單是空的，但「可用變數」跟查到幾筆訂單無關，
      // 仍要照常回傳，否則前端的變數清單會被清空（範本裡的變數全變成未知警告）。
      return { variables: (await fetchMessageVariables()).map((v) => v.variable_name), rows: [] };
    } else {
      query = query.in('id', ids);
    }
  } else if (filters.roomType) {
    query = query.ilike('room_type_label', `%${filters.roomType}%`);
  }
  if (filters.keyword && filters.keyword.trim()) {
    const kw = filters.keyword.trim().replace(/[%,()]/g, '');
    query = query.or(`name.ilike.%${kw}%,nickname.ilike.%${kw}%,phone.ilike.%${kw}%,order_number.ilike.%${kw}%`);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message || '查詢訂單清單失敗');

  const bookings = data || [];
  const variables = await fetchMessageVariables();
  const linkedRooms = await roomLabelsByBooking(bookings.map((b: any) => b.id));

  const userIds = Array.from(new Set(bookings.map((b: any) => b.line_user_id).filter(Boolean)));
  let customerByUser: Record<string, any> = {};
  if (userIds.length) {
    const { data: states } = await supabase.from('user_states').select('line_user_id, nickname, last_message_at, first_message_at, marketing_opt_out').in('line_user_id', userIds);
    for (const s of states || []) customerByUser[s.line_user_id] = s;
  }

  // 標記「不接收行銷訊息」的客人，客製訊息發送名單一律排除，不能只靠客人自己封鎖官方帳號才退得掉。
  const bookingsForBroadcast = bookings.filter((b: any) => !customerByUser[b.line_user_id]?.marketing_opt_out);

  const rows = bookingsForBroadcast.map((b: any) => {
    const balanceDue = b.total_amount != null ? b.total_amount - (b.deposit ?? 0) : null;
    const fields = {
      ...buildMergeFields(variables, {
        booking: b,
        customer: customerByUser[b.line_user_id] || { nickname: b.nickname, line_user_id: b.line_user_id },
        settings,
      }),
      ...computeTodayTomorrowFields(),
    };
    return {
      id: b.id,
      line_user_id: b.line_user_id || '',
      order_number: b.order_number || '',
      name: b.name || b.nickname || '',
      checkin_date: b.checkin_date ? String(b.checkin_date).replace(/-/g, '/') : '',
      checkout_date: b.checkout_date ? String(b.checkout_date).replace(/-/g, '/') : '',
      headcount: b.headcount != null ? String(b.headcount) : '',
      // 有連結房間就顯示實際房間名稱；還沒連結的舊訂單才退回手打的文字
      room_type_label: linkedRooms[b.id]?.join('、') || b.room_type_label || (b.whole_house ? '包棟' : ''),
      status: b.status,
      // 前端用它判斷這列能不能勾選：第三方平台匯進來的訂單沒有 LINE 身分，發不出訊息。
      booking_source: b.booking_source || 'direct',
      total_amount: b.total_amount != null ? String(b.total_amount) : '',
      deposit: b.deposit != null ? String(b.deposit) : '',
      balance_due: balanceDue != null ? String(balanceDue) : '',
      fields,
    };
  });

  return { variables: variables.map((v) => v.variable_name), rows };
}

// ========================================================================
// 客戶名單查詢：以 user_states 為主要來源（客戶用帳號底下互動過的人，一人一列），
// 供「客製訊息發送」的「客戶名單」模式使用——跟上面 listOrders() 的差異是不依訂單條件篩選，
// 單純針對「人」，同一人不會因為訂過好幾次房就出現好幾列、選了就重複發送。
// ========================================================================

async function listCustomers(settings: any, keyword?: string): Promise<{ variables: string[]; rows: any[] }> {
  const customerChannel = await fetchChannelById(); // 不帶 id 時退回客戶用帳號，「客戶名單」概念本來就只對客戶用帳號有意義
  const variables = await fetchMessageVariables();
  if (!customerChannel) return { variables: variables.map((v) => v.variable_name), rows: [] };

  let query = supabase
    .from('user_states')
    .select('line_user_id, nickname, last_message_at, first_message_at, marketing_opt_out')
    .eq('channel_id', customerChannel.id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(MAX_ORDERS);

  if (keyword && keyword.trim()) {
    const kw = keyword.trim().replace(/[%,()]/g, '');
    query = query.ilike('nickname', `%${kw}%`); // user_states 沒有電話/訂單編號欄位，只能搜暱稱
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message || '查詢客戶名單失敗');

  // 不接收行銷訊息的客人一律排除，不能只靠客人自己封鎖官方帳號才退得掉——跟 listOrders() 同一套規則。
  // marketing_opt_out 舊資料可能是 NULL（欄位加入前就存在的客戶），NULL 要當「沒有退訂」處理，
  // 所以用 JS 過濾（!c.marketing_opt_out）而不是資料庫層級的 .eq('marketing_opt_out', false)——
  // 後者在 PostgREST 裡不會比對到 NULL，會把這批老客戶整批誤刪掉。
  const customers = (data || []).filter((c: any) => !c.marketing_opt_out);

  // 訂單數量純粹是後台顯示用的參考資訊（幫管理員判斷這個人是不是熟客），不影響發送邏輯。
  const userIds = customers.map((c: any) => c.line_user_id);
  const bookingCountByUser: Record<string, number> = {};
  if (userIds.length) {
    const { data: bookingRows } = await supabase.from('bookings').select('line_user_id').in('line_user_id', userIds);
    for (const b of bookingRows || []) bookingCountByUser[b.line_user_id] = (bookingCountByUser[b.line_user_id] || 0) + 1;
  }

  const rows = customers.map((c: any) => ({
    line_user_id: c.line_user_id,
    nickname: c.nickname || '',
    last_message_at: c.last_message_at,
    booking_count: bookingCountByUser[c.line_user_id] || 0,
    fields: { ...buildMergeFields(variables, { customer: c, settings }), ...computeTodayTomorrowFields() },
  }));

  return { variables: variables.map((v) => v.variable_name), rows };
}

// ========================================================================
// LINE 訊息額度查詢
// ========================================================================

async function getLineQuota(channelAccessToken: string): Promise<{ limit: number | null; used: number; remaining: number | null }> {
  const headers = { Authorization: `Bearer ${channelAccessToken}` };
  const [quotaRes, consumptionRes] = await Promise.all([
    fetch('https://api.line.me/v2/bot/message/quota', { headers }),
    fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers }),
  ]);
  const quota: any = await quotaRes.json();
  const consumption: any = await consumptionRes.json();
  if (!quotaRes.ok) throw new Error(quota.message || '查詢 LINE 訊息額度失敗');
  const limit = quota.type === 'limited' ? quota.value : null; // null＝無上限（付費方案）
  const used = consumption.totalUsage || 0;
  const remaining = limit == null ? null : Math.max(0, limit - used);
  return { limit, used, remaining };
}

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabase, 'custom-messages', rawHandler);

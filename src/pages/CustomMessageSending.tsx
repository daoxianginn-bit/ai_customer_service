import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Search, Send, Plus, Trash2, Pencil, Gauge, RotateCcw, Save, Eye, Eraser, User, Radio, Users } from 'lucide-react';
import MessageTemplateEditor from '../components/MessageTemplateEditor';
import { PageHeader, Button, Modal, ConfirmDialog, StatusBadge } from '../components/ui';
import { BOOKING_STATUS_OPTIONS } from '../lib/bookingStatus';
import { channelRoleLabel } from '../lib/lineChannels';

interface ChannelOption {
  id: string;
  name: string;
  role: string;
}

// 這一列能不能發訊息：第三方平台匯進來的訂單沒有 LINE 身分，勾了也送不出去。
// 以「有沒有 line_user_id」為準而不是只看來源——後台人工建的單也可能沒有 LINE 帳號。
function canSendToOrder(r: { line_user_id?: string }): boolean {
  return !!(r.line_user_id && r.line_user_id.trim());
}

interface Contact {
  line_user_id: string; // LINE 群組時，這欄位存的是 group_id——push message 的 to 欄位不分兩者，可以共用同一套發送邏輯
  nickname: string | null;
  is_group?: boolean;
}

interface RecipientGroup {
  id: string;
  name: string;
  line_user_ids: string[];
}

interface Template {
  id: string;
  title: string;
  body: string;
}

interface OrderRow {
  id: string;
  line_user_id: string;
  order_number: string;
  name: string;
  checkin_date: string;
  checkout_date: string;
  headcount: string;
  room_type_label: string;
  status: string;
  total_amount: string;
  deposit: string;
  balance_due: string;
  fields: Record<string, string>;
}

// 「客戶名單」模式專用：一人一列，不像 OrderRow 那樣一筆訂單一列（同一人訂兩次房會出現兩列）。
interface CustomerRow {
  line_user_id: string;
  nickname: string;
  last_message_at: string | null;
  booking_count: number;
  fields: Record<string, string>;
}

// 'groups'＝發送給「機器人被邀進去的 LINE 群組」。群組跟個別聯絡人共用同一套 push 發送邏輯
// （LINE 的 to 欄位不分 userId／groupId），所以只是換一份收件人來源，不需要另一套發送流程。
type ListMode = 'orders' | 'customers' | 'groups';

const MAX_BATCH_SEND = 50;
const PAGE_SIZE = 10;

const STATUS_OPTIONS = [{ value: '', label: '全部狀態' }, ...BOOKING_STATUS_OPTIONS.map((s) => ({ value: s.value, label: s.label }))];

const QUICK_FILTER_CHIPS = STATUS_OPTIONS.filter((s) => s.value);

interface QuotaInfo {
  limit: number | null;
  used: number;
  remaining: number | null;
}

async function callCustomMessagesFunction(action: string, payload: Record<string, any> = {}) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch('/.netlify/functions/custom-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '請求失敗');
  return result;
}

export default function CustomMessageSending() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [draftBody, setDraftBody] = useState('');

  // 發送帳號：決定用哪個官方帳號的憑證發送、收件人要從哪個池子挑。
  // 客戶用帳號＝原本的行為（從訂單清單勾選）；其餘帳號＝從該帳號自己的聯絡人挑（見下方 contacts 區塊）。
  // 「查詢客戶名單」那個面板永遠顯示、不受這個選擇影響——即使等一下要用團隊內部帳號發送，
  // 這裡仍然看得到客戶的訂單資訊，可以拿來當發送內容的參考，這就是「跨官方帳號取得資訊」。
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelId, setChannelId] = useState('');
  const customerChannelId = channels.find((c) => c.role === 'customer')?.id || '';
  const isCustomerChannel = !channelId || channelId === customerChannelId;

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactGroups, setContactGroups] = useState<RecipientGroup[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  const [contactFilter, setContactFilter] = useState('');

  const [keyword, setKeyword] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [status, setStatus] = useState('');
  // 下拉選的是「房型與空間維護」裡的房間，值存 room_types.id；
  // 送查詢時連名稱一起帶，好讓後端在 booking_rooms 還沒建立時退回舊的文字比對。
  const [roomType, setRoomType] = useState('');
  const [roomTypeOptions, setRoomTypeOptions] = useState<{ id: string; name: string }[]>([]);

  const [querying, setQuerying] = useState(false);
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

  // 「依訂單篩選」（一筆訂單一列）跟「客戶名單」（一人一列，去重）兩種查詢模式切換，
  // 只有客戶用帳號才有意義（其他帳號本來就是用下方「發送對象」挑該帳號自己的聯絡人）。
  const [listMode, setListMode] = useState<ListMode>('orders');
  const [customerRows, setCustomerRows] = useState<CustomerRow[]>([]);
  const [selectedCustomerKeys, setSelectedCustomerKeys] = useState<Set<string>>(new Set());
  const [customerPage, setCustomerPage] = useState(0);

  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<{ id?: string; title: string; body: string } | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deleteTemplateTarget, setDeleteTemplateTarget] = useState<Template | null>(null);

  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: number; fail: number } | null>(null);

  useEffect(() => {
    fetchTemplates();
    fetchRoomTypeOptions();
    fetchVariables();
    fetchChannels();
    runQuery();
  }, []);

  // 頻道清單載入完成、或使用者切換發送帳號時：查那個帳號的額度；不是客戶用帳號的話還要
  // 順便查它自己的聯絡人清單／通知名單（客戶用帳號沿用左側訂單清單的勾選，不需要這份）。
  useEffect(() => {
    if (!channelId) return;
    fetchQuota(channelId);
    // 每個帳號都要載入自己的聯絡人與群組，客戶用帳號也不例外。
    // 以前只有非客戶用帳號才載入，於是「機器人被邀進去的 LINE 群組」如果掛在客戶用帳號底下，
    // 在這個畫面永遠看不到、也就永遠發不了訊息給那個群組。
    fetchContacts(channelId);
    setSelectedContactIds(new Set());
    if (channelId !== customerChannelId) {
      // 「客戶名單」模式的切換鈕只在客戶用帳號才顯示，離開客戶用帳號時如果還停在那個模式，
      // 使用者會被卡住（看得到客戶名單面板，卻沒有按鈕能切回訂單模式）。離開時強制切回訂單模式。
      setListMode('orders');
      setSelectedCustomerKeys(new Set());
    }
  }, [channelId, customerChannelId]);

  const fetchChannels = async () => {
    try {
      const result = await callCustomMessagesFunction('channels');
      const list: ChannelOption[] = result.channels || [];
      setChannels(list);
      setChannelId((prev) => prev || list.find((c) => c.role === 'customer')?.id || list[0]?.id || '');
    } catch (e: any) {
      console.error('查詢官方帳號失敗', e.message);
    }
  };

  const fetchContacts = async (id: string) => {
    setContactsLoading(true);
    setSelectedContactIds(new Set());
    try {
      const result = await callCustomMessagesFunction('contacts', { channelId: id });
      setContacts(result.contacts || []);
      setContactGroups(result.groups || []);
    } catch (e: any) {
      console.error('查詢聯絡人失敗', e.message);
    } finally {
      setContactsLoading(false);
    }
  };

  const toggleContact = (id: string) => {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const applyRecipientGroup = (group: RecipientGroup) => {
    setSelectedContactIds(new Set(group.line_user_ids));
  };

  const visibleContacts = contacts.filter((c) => {
    if (listMode === 'groups' && !c.is_group) return false;
    if (!contactFilter.trim()) return true;
    const kw = contactFilter.trim().toLowerCase();
    return (c.nickname || '').toLowerCase().includes(kw) || c.line_user_id.toLowerCase().includes(kw);
  });

  // 可用變數清單獨立於訂單查詢自己抓一次。
  // 原本只在 runQuery() 成功時才會被填入（來自 custom-messages function 的回傳），
  // 造成兩個問題：訂單查詢查不到資料時 variables 會被清成空陣列，範本裡原本正常的
  // [變數] 全部變成「不在清單裡」的黃色警告、下方快捷插入鈕也整排消失。
  // 變數清單跟查到幾筆訂單本來就沒有關係，改成跟「訊息變數資料維護」同一個來源直接查。
  const fetchVariables = async () => {
    const { data } = await supabase.from('message_variables').select('variable_name').order('display_order');
    setVariables((data || []).map((v: any) => v.variable_name));
  };

  const fetchTemplates = async () => {
    const { data } = await supabase.from('custom_message_templates').select('*').order('created_at');
    setTemplates(data || []);
  };

  const fetchRoomTypeOptions = async () => {
    const { data } = await supabase.from('room_types').select('id, name').eq('type', '房間').order('display_order');
    setRoomTypeOptions((data || []).map((r: any) => ({ id: r.id, name: r.name })));
  };

  const fetchQuota = async (id: string) => {
    try {
      const result = await callCustomMessagesFunction('quota', { channelId: id });
      setQuota(result);
    } catch (e: any) {
      console.error('查詢額度失敗', e.message);
    }
  };

  const rowKey = (row: OrderRow, index: number) => row.id || row.line_user_id || `row-${index}`;
  const displayName = (row: OrderRow) => row.name || '（未知）';

  const runOrderQuery = async (overrideStatus?: string) => {
    setQuerying(true);
    setSelectedKeys(new Set());
    setPage(0);
    try {
      const result = await callCustomMessagesFunction('list', {
        keyword,
        startDate,
        endDate,
        status: overrideStatus !== undefined ? overrideStatus : status,
        roomId: roomType === '包棟' ? '' : roomType,
        roomType: roomType === '包棟' ? '包棟' : roomTypeOptions.find((r) => r.id === roomType)?.name || '',
      });
      setRows(result.rows || []);
      // 只有真的拿到清單才覆蓋；查無訂單時 function 會回空陣列，不能拿它把變數清單洗掉
      if (result.variables?.length) setVariables(result.variables);
    } catch (e: any) {
      alert(`查詢失敗：${e.message}`);
    } finally {
      setQuerying(false);
    }
  };

  // 「客戶名單」模式：一人一列，不吃訂單篩選條件（入住日期/訂單狀態/房型），只吃關鍵字搜尋暱稱。
  const runCustomerQuery = async () => {
    setQuerying(true);
    setSelectedCustomerKeys(new Set());
    setCustomerPage(0);
    try {
      const result = await callCustomMessagesFunction('customers', { keyword });
      setCustomerRows(result.rows || []);
      if (result.variables?.length) setVariables(result.variables);
    } catch (e: any) {
      alert(`查詢失敗：${e.message}`);
    } finally {
      setQuerying(false);
    }
  };

  // 「查詢」鈕／Enter／快速篩選都是使用者互動當下觸發，讀取當下的 listMode 不會有 stale closure 問題，
  // 直接依目前模式分派給對應的查詢函式即可。
  const runQuery = (overrideStatus?: string) => (listMode === 'customers' ? runCustomerQuery() : runOrderQuery(overrideStatus));

  // 切換模式跟「查詢」鈕不同：這裡是先 setListMode 再馬上要用新模式查詢，如果沿用 runQuery()
  // 讀 state 會撞到 React 還沒 re-render、listMode 讀到舊值的 stale closure 問題，
  // 所以直接依「要切換過去的模式」分派，不透過 state 判斷。
  const switchListMode = (mode: ListMode) => {
    if (mode === listMode) return;
    setListMode(mode);
    // 群組模式的收件人來自 contacts（切換帳號時已經載入），不需要再查訂單或客戶名單。
    if (mode === 'groups') return;
    if (mode === 'customers') runCustomerQuery(); else runOrderQuery();
  };

  const clearFilters = () => {
    setKeyword('');
    setStartDate('');
    setEndDate('');
    setStatus('');
    setRoomType('');
    setTimeout(() => runQuery(''), 0);
  };

  const toggleQuickFilter = (value: string) => {
    const next = status === value ? '' : value;
    setStatus(next);
    runOrderQuery(next);
  };

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pagedRows = useMemo(() => rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE), [rows, page]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));

  // 這一頁裡「勾得動」的列。全選與表頭的勾選狀態都只看它，否則全選會把鎖住的
  // 第三方訂單也一起勾起來，而且表頭永遠不會呈現全選（那些列勾不起來）。
  const sendableKeysOnPage = useMemo(
    () =>
      pagedRows
        .map((r, i) => ({ r, k: rowKey(r, page * PAGE_SIZE + i) }))
        .filter(({ r }) => canSendToOrder(r))
        .map(({ k }) => k),
    [pagedRows, page]
  );

  const toggleSelectAllOnPage = () => {
    const allSelected = sendableKeysOnPage.length > 0 && sendableKeysOnPage.every((k) => selectedKeys.has(k));
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) sendableKeysOnPage.forEach((k) => next.delete(k));
      else sendableKeysOnPage.forEach((k) => next.add(k));
      return next;
    });
  };

  const selectedOrderRows = rows.filter((r, i) => selectedKeys.has(rowKey(r, i)));
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || null;

  const pagedCustomerRows = useMemo(() => customerRows.slice(customerPage * PAGE_SIZE, customerPage * PAGE_SIZE + PAGE_SIZE), [customerRows, customerPage]);
  const totalCustomerPages = Math.max(1, Math.ceil(customerRows.length / PAGE_SIZE));

  const toggleCustomerSelected = (id: string) => {
    setSelectedCustomerKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAllCustomersOnPage = () => {
    const pageKeys = pagedCustomerRows.map((r) => r.line_user_id);
    const allSelected = pageKeys.every((k) => selectedCustomerKeys.has(k));
    setSelectedCustomerKeys((prev) => {
      const next = new Set(prev);
      if (allSelected) pageKeys.forEach((k) => next.delete(k));
      else pageKeys.forEach((k) => next.add(k));
      return next;
    });
  };

  const selectedCustomerRows = customerRows.filter((r) => selectedCustomerKeys.has(r.line_user_id));

  // 參考資料：客戶用帳號時就是「這次要發的那位客人／那幾位客人」；其他帳號時是選填的
  // 「這則通知是關於哪張訂單」，借用它的合併欄位（例如通知內部某張訂單待確認），
  // 沒選就照原樣發送、不做欄位替換。客戶名單模式下沒有「訂單」可以參考，用客戶本身的
  // 合併欄位（例如 [LINE暱稱]）。
  const referenceOrder = listMode === 'customers' ? (selectedCustomerRows[0] || null) : (selectedOrderRows[0] || null);
  const previewCustomer = referenceOrder;

  // 人看得懂的「資料來源」描述，給跨帳號發送時的狀態列／確認視窗用——原本只顯示「已選 N 筆」，
  // 使用者反應看不出來「勾的到底是哪個客人/訂單」，尤其切到廠商帳號發送時完全看不出這筆資料
  // 最後會套到哪批收件人身上。這裡把「誰」講清楚，不要只顯示數字。
  const referenceLabel = !referenceOrder
    ? null
    : listMode === 'customers'
      ? (referenceOrder as CustomerRow).nickname || '（未取得暱稱）'
      : `${displayName(referenceOrder as OrderRow)}${(referenceOrder as OrderRow).order_number ? `（訂單 ${(referenceOrder as OrderRow).order_number}）` : ''}`;

  // 實際收件人數量：客戶用帳號＝依目前模式（訂單清單或客戶名單）勾選人數；其他帳號＝聯絡人清單勾選人數。
  const recipientCount = !isCustomerChannel || listMode === 'groups'
    ? selectedContactIds.size
    : listMode === 'customers'
      ? selectedCustomerRows.length
      : selectedOrderRows.length;

  const mergeTemplateLocal = (template: string, fields: Record<string, string>): string => {
    let result = template;
    for (const [key, value] of Object.entries(fields)) {
      result = result.split(`[${key}]`).join(value ?? '');
    }
    return result;
  };

  const previewMessage = previewCustomer ? mergeTemplateLocal(draftBody, previewCustomer.fields) : draftBody;

  const openNewTemplate = () => {
    setEditingTemplate({ title: '', body: '' });
    setShowTemplateModal(true);
  };

  const openEditTemplate = (t: Template) => {
    setEditingTemplate({ id: t.id, title: t.title, body: t.body });
    setShowTemplateModal(true);
  };

  const saveTemplate = async () => {
    if (!editingTemplate || !editingTemplate.title.trim()) {
      alert('請填寫範本標題');
      return;
    }
    setSavingTemplate(true);
    try {
      if (editingTemplate.id) {
        await supabase.from('custom_message_templates').update({ title: editingTemplate.title, body: editingTemplate.body }).eq('id', editingTemplate.id);
      } else {
        await supabase.from('custom_message_templates').insert({ title: editingTemplate.title, body: editingTemplate.body });
      }
      await fetchTemplates();
      setShowTemplateModal(false);
      setEditingTemplate(null);
    } catch (e: any) {
      alert(`儲存範本失敗：${e.message}`);
    } finally {
      setSavingTemplate(false);
    }
  };

  const confirmDeleteTemplate = async () => {
    if (!deleteTemplateTarget) return;
    await supabase.from('custom_message_templates').delete().eq('id', deleteTemplateTarget.id);
    if (selectedTemplateId === deleteTemplateTarget.id) {
      setSelectedTemplateId('');
      setDraftBody('');
    }
    setDeleteTemplateTarget(null);
    await fetchTemplates();
  };

  const applyTemplateSelection = (id: string) => {
    setSelectedTemplateId(id);
    const t = templates.find((tp) => tp.id === id);
    setDraftBody(t?.body || '');
  };

  const saveDraftAsTemplate = () => {
    if (selectedTemplate) {
      openEditTemplate({ ...selectedTemplate, body: draftBody });
    } else {
      setEditingTemplate({ title: '', body: draftBody });
      setShowTemplateModal(true);
    }
  };

  const handleSendClick = () => {
    if (!recipientCount) {
      alert(isCustomerChannel ? '請先勾選要發送的名單' : '請先勾選要發送的聯絡人');
      return;
    }
    if (recipientCount > MAX_BATCH_SEND) {
      alert(`一次最多發送 ${MAX_BATCH_SEND} 位，請分批發送（目前勾選 ${recipientCount} 位）`);
      return;
    }
    if (!draftBody.trim()) {
      alert('請先選擇或輸入訊息內容');
      return;
    }
    setSendResult(null);
    setShowConfirm(true);
  };

  const confirmSend = async () => {
    setSending(true);
    try {
      // 客戶用帳號：依目前模式，訂單清單模式是每位客人各自的訂單欄位（原本的行為）；
      // 客戶名單模式是每位客人各自的客戶欄位（一人一列，不會因為訂過好幾次房而重複發送）。
      // 其他帳號：收件人是該帳號的聯絡人，line_user_id 池子完全不同；合併欄位借用左側「有沒有
      // 選到參考訂單」——選了就整批通知都套用那張訂單的資訊（例如「請確認訂單 A001」），沒選就照原文發送。
      const recipients = isCustomerChannel && listMode !== 'groups'
        ? listMode === 'customers'
          ? selectedCustomerRows.map((r) => ({ lineUserId: r.line_user_id, fields: r.fields }))
          : selectedOrderRows.filter((r) => r.line_user_id).map((r) => ({ lineUserId: r.line_user_id, fields: r.fields, bookingId: r.id }))
        : [...selectedContactIds].map((id) => ({ lineUserId: id, fields: referenceOrder?.fields || {} }));

      const result = await callCustomMessagesFunction('send', { recipients, template: draftBody, channelId });
      const rows: any[] = result.results || [];
      const ok = rows.filter((r) => r.ok).length;
      const fail = rows.length - ok;
      setSendResult({ ok, fail });
      setShowConfirm(false);
      await fetchQuota(channelId);
    } catch (e: any) {
      alert(`發送失敗：${e.message}`);
    } finally {
      setSending(false);
    }
  };

  const recipientDisplayNames = isCustomerChannel
    ? listMode === 'customers'
      ? selectedCustomerRows.map((r) => `${r.nickname || '（未取得暱稱）'}${r.booking_count ? `（累計 ${r.booking_count} 筆訂單）` : ''}`)
      : selectedOrderRows.map((r) => `${displayName(r)}${r.checkin_date ? `（入住 ${r.checkin_date}）` : ''}`)
    : [...selectedContactIds].map((id) => contacts.find((c) => c.line_user_id === id)?.nickname || id);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Send className="w-6 h-6 text-green-600" />}
        title="客製訊息發送"
        description="查詢客戶名單、套用訊息範本、帶入報價欄位並批次發送 LINE 訊息。"
        action={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 bg-gray-50 border rounded-lg px-3 py-2 text-sm text-gray-700">
              <Radio className="w-4 h-4 text-gray-400" />
              <select
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                className="bg-transparent text-sm focus:outline-none"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}（{channelRoleLabel(c.role)}）</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2 bg-gray-50 border rounded-lg px-4 py-2 text-sm text-gray-700">
              <Gauge className="w-4 h-4 text-gray-400" />
              {quota == null ? (
                <span className="text-gray-400">額度查詢中...</span>
              ) : quota.limit == null ? (
                <span>本月已用 {quota.used.toLocaleString()} 則（無上限方案）</span>
              ) : (
                <span>
                  本月剩餘 <strong className={quota.remaining !== null && quota.remaining < 50 ? 'text-red-600' : 'text-gray-800'}>{quota.remaining?.toLocaleString()}</strong>
                  {' '}/ {quota.limit.toLocaleString()} 則
                </span>
              )}
            </div>
          </div>
        }
      />

      {!isCustomerChannel && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-2">
          <p className="text-xs text-amber-700">
            目前發送帳號是「<strong>{channels.find((c) => c.id === channelId)?.name}</strong>」（{channelRoleLabel(channels.find((c) => c.id === channelId)?.role)}）。
            收件人請到下方「發送對象」勾選這個帳號自己的聯絡人或群組，不是左側的訂單清單。
          </p>
          {/* 明確畫出「資料來源 → 發送對象」這條線——原本只顯示「已選 N 筆」數字，
              使用者反應看不出來到底是哪個客人的資料，最後會套到哪批收件人身上。 */}
          <div className="flex flex-wrap items-center gap-2 text-xs bg-white rounded-lg border border-amber-200 px-3 py-2">
            <span className="text-gray-400 shrink-0">📋 資料來源</span>
            <span className={`font-medium ${referenceLabel ? 'text-gray-800' : 'text-gray-400'}`}>
              {referenceLabel || '未選擇（訊息將原文發送，不套用合併欄位）'}
            </span>
            <span className="text-amber-400 shrink-0">→</span>
            <span className="text-gray-400 shrink-0">📤 發送給</span>
            <span className={`font-medium ${recipientCount ? 'text-gray-800' : 'text-gray-400'}`}>
              {channels.find((c) => c.id === channelId)?.name || ''}
              {recipientCount > 0 ? `　${recipientCount} 位聯絡人/群組` : '（尚未勾選發送對象）'}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* 第一欄：查詢客戶名單 */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
            <div className="p-4 border-b space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-bold text-gray-800 text-sm">1. 查詢客戶名單</h3>
                {isCustomerChannel && (
                  <div className="flex gap-0.5 p-0.5 bg-gray-100 rounded-lg">
                    <button
                      onClick={() => switchListMode('orders')}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${listMode === 'orders' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      依訂單篩選
                    </button>
                    <button
                      onClick={() => switchListMode('customers')}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${listMode === 'customers' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      客戶名單（去重）
                    </button>
                    <button
                      onClick={() => switchListMode('groups')}
                      className={`px-2.5 py-1 text-xs rounded-md transition-colors ${listMode === 'groups' ? 'bg-white shadow-sm text-gray-800 font-medium' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      LINE 群組
                    </button>
                  </div>
                )}
              </div>
              {listMode === 'customers' && (
                <p className="text-xs text-gray-400">
                  一位客戶一列，不管訂過幾次房都只會出現一次，避免勾到同一人的多筆訂單重複發送。
                </p>
              )}
              <input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runQuery()}
                placeholder={listMode === 'customers' ? '搜尋 LINE 暱稱...' : '搜尋姓名、電話或訂單編號...'}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              {listMode === 'orders' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">入住日期（起）</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">入住日期（迄）</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">訂單狀態</label>
                    <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm bg-white">
                      {STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">房型</label>
                    <select value={roomType} onChange={(e) => setRoomType(e.target.value)} className="w-full px-2 py-1.5 border rounded-lg text-sm bg-white">
                      <option value="">全部房型</option>
                      <option value="包棟">包棟</option>
                      {roomTypeOptions.map((r) => (
                        <option key={r.id} value={r.id}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <div className="flex gap-2">
                <Button onClick={() => runQuery()} loading={querying} icon={<Search className="w-4 h-4" />} className="flex-1">
                  {querying ? '查詢中...' : '查詢'}
                </Button>
                <Button variant="secondary" onClick={clearFilters} icon={<RotateCcw className="w-4 h-4" />}>清除條件</Button>
              </div>
              {listMode === 'orders' && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <span className="text-xs text-gray-400 self-center">快速篩選：</span>
                  {QUICK_FILTER_CHIPS.map((c) => (
                    <button
                      key={c.value}
                      onClick={() => toggleQuickFilter(c.value)}
                      className={`px-3 py-1 text-xs rounded-full border transition-colors ${status === c.value ? 'bg-green-600 text-white border-green-600' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {listMode === 'groups' ? (
              <p className="px-4 py-6 text-sm text-gray-400">
                群組發送不需要查詢訂單。請到下方「發送對象」勾選要發送的 LINE 群組。
              </p>
            ) : listMode === 'customers' ? (
              <>
                <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b sticky top-0">
                      <tr className="text-gray-600">
                        <th className="py-2 px-3">
                          <input type="checkbox" checked={pagedCustomerRows.length > 0 && pagedCustomerRows.every((r) => selectedCustomerKeys.has(r.line_user_id))} onChange={toggleSelectAllCustomersOnPage} disabled={!pagedCustomerRows.length} />
                        </th>
                        <th className="py-2 px-3">LINE 暱稱</th>
                        <th className="py-2 px-3">累計訂單數</th>
                        <th className="py-2 px-3">最近互動時間</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pagedCustomerRows.map((r) => (
                        <tr key={r.line_user_id} className={selectedCustomerKeys.has(r.line_user_id) ? 'bg-green-50' : ''}>
                          <td className="py-2 px-3">
                            <input type="checkbox" checked={selectedCustomerKeys.has(r.line_user_id)} onChange={() => toggleCustomerSelected(r.line_user_id)} />
                          </td>
                          <td className="py-2 px-3">{r.nickname || '（未取得暱稱）'}</td>
                          <td className="py-2 px-3">{r.booking_count}</td>
                          <td className="py-2 px-3 whitespace-nowrap">{r.last_message_at ? new Date(r.last_message_at).toLocaleDateString('zh-TW') : '-'}</td>
                        </tr>
                      ))}
                      {pagedCustomerRows.length === 0 && (
                        <tr>
                          <td colSpan={4} className="py-16 text-center text-gray-400">
                            {querying ? '查詢中...' : '查無符合條件的客戶'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-between items-center px-4 py-3 border-t text-xs text-gray-500">
                  <span>已選取 {selectedCustomerRows.length} 位（即發送對象）</span>
                  <div className="flex items-center gap-2">
                    <button disabled={customerPage === 0} onClick={() => setCustomerPage((p) => p - 1)} className="px-2 py-1 border rounded disabled:opacity-40">‹</button>
                    <span>{customerPage + 1} / {totalCustomerPages}</span>
                    <button disabled={customerPage >= totalCustomerPages - 1} onClick={() => setCustomerPage((p) => p + 1)} className="px-2 py-1 border rounded disabled:opacity-40">›</button>
                  </div>
                  <span>每頁顯示 {PAGE_SIZE}</span>
                </div>
              </>
            ) : (
              <>
                <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 border-b sticky top-0">
                      <tr className="text-gray-600">
                        <th className="py-2 px-3">
                          <input
                            type="checkbox"
                            checked={sendableKeysOnPage.length > 0 && sendableKeysOnPage.every((k) => selectedKeys.has(k))}
                            onChange={toggleSelectAllOnPage}
                            disabled={sendableKeysOnPage.length === 0}
                          />
                        </th>
                        <th className="py-2 px-3">姓名</th>
                        <th className="py-2 px-3">入住日期</th>
                        <th className="py-2 px-3">人數</th>
                        <th className="py-2 px-3">房型</th>
                        <th className="py-2 px-3">訂單狀態</th>
                        <th className="py-2 px-3">預估報價</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pagedRows.map((r, i) => {
                        const key = rowKey(r, page * PAGE_SIZE + i);
                        const isReference = !isCustomerChannel && referenceOrder === r;
                        return (
                          <tr key={key} className={selectedKeys.has(key) ? 'bg-green-50' : ''}>
                            <td className="py-2 px-3">
                              <input
                                type="checkbox"
                                checked={selectedKeys.has(key)}
                                onChange={() => toggleSelected(key)}
                                disabled={!canSendToOrder(r)}
                                title={canSendToOrder(r) ? '' : '這筆訂單沒有 LINE 帳號（第三方平台訂單或人工建單），無法發送訊息'}
                              />
                            </td>
                            <td className="py-2 px-3">
                              <span className="inline-flex items-center gap-1">
                                {displayName(r)}
                                {isReference && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200 shrink-0">資料來源</span>}
                              </span>
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">{r.checkin_date}</td>
                            <td className="py-2 px-3">{r.headcount}</td>
                            <td className="py-2 px-3">{r.room_type_label}</td>
                            <td className="py-2 px-3">
                              {r.status ? <StatusBadge status={r.status} /> : <span className="text-gray-400">-</span>}
                            </td>
                            <td className="py-2 px-3 whitespace-nowrap">{r.total_amount ? `NT$ ${Number(r.total_amount).toLocaleString()}` : ''}</td>
                          </tr>
                        );
                      })}
                      {pagedRows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="py-16 text-center text-gray-400">
                            {querying
                              ? '查詢中...'
                              : roomType && roomType !== '包棟'
                                ? '這間房目前沒有訂單。房型是依訂單管理裡連結的房間篩選的，舊訂單要先在訂單管理打開、勾選實際開出去的房間才會出現。'
                                : '查無符合條件的訂單'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="px-4 pt-3 pb-1 flex justify-between items-center text-xs text-gray-500 border-t">
                  <span>已選取 {selectedOrderRows.length} 筆{isCustomerChannel ? '（即發送對象，同一人選多筆訂單會重複發送）' : '（供合併欄位參考，非發送對象）'}</span>
                  <div className="flex items-center gap-2">
                    <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="px-2 py-1 border rounded disabled:opacity-40">‹</button>
                    <span>{page + 1} / {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="px-2 py-1 border rounded disabled:opacity-40">›</button>
                  </div>
                  <span>每頁顯示 {PAGE_SIZE}</span>
                </div>
                {!isCustomerChannel && selectedOrderRows.length > 1 && (
                  <p className="px-4 pb-3 text-xs text-amber-600">
                    ⚠️ 只有標示「資料來源」的第一筆會被套用，其餘 {selectedOrderRows.length - 1} 筆勾選不會影響發送內容。
                  </p>
                )}
              </>
            )}
          </div>

          {/* 發送對象：客戶用帳號以外的頻道，收件人從這裡的聯絡人清單勾選（不是上面的訂單清單，
              那些 line_user_id 屬於客戶用帳號，在別的帳號底下是無效 ID）。 */}
          {(!isCustomerChannel || listMode === 'groups') && (
            <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
              <div className="p-4 border-b space-y-3">
                <h3 className="font-bold text-gray-800 text-sm">
                  發送對象（{channels.find((c) => c.id === channelId)?.name}{listMode === 'groups' ? ' 群組' : ' 聯絡人'}）
                </h3>
                {contactGroups.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-400">套用通知名單：</span>
                    {contactGroups.map((g) => (
                      <button
                        key={g.id}
                        onClick={() => applyRecipientGroup(g)}
                        className="px-3 py-1 text-xs rounded-full border bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"
                      >
                        {g.name}（{g.line_user_ids.length}）
                      </button>
                    ))}
                  </div>
                )}
                <input
                  value={contactFilter}
                  onChange={(e) => setContactFilter(e.target.value)}
                  placeholder="搜尋暱稱或 LINE User ID"
                  className="w-full px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-100">
                {contactsLoading ? (
                  <p className="text-center text-gray-400 py-8 text-sm">載入聯絡人中...</p>
                ) : visibleContacts.length === 0 ? (
                  <p className="text-center text-gray-400 py-8 text-sm">
                    {contacts.length === 0 ? '這個官方帳號底下還沒有任何聯絡人' : '沒有符合搜尋條件的聯絡人'}
                  </p>
                ) : (
                  visibleContacts.map((c) => (
                    <label key={c.line_user_id} className={`flex items-center gap-2 px-4 py-2 text-sm cursor-pointer hover:bg-gray-50 ${selectedContactIds.has(c.line_user_id) ? 'bg-green-50' : ''}`}>
                      <input type="checkbox" checked={selectedContactIds.has(c.line_user_id)} onChange={() => toggleContact(c.line_user_id)} />
                      {c.is_group && <Users className="w-3.5 h-3.5 text-blue-400 shrink-0" />}
                      <span className="flex-1 min-w-0 truncate">{c.nickname || '（未取得暱稱）'}</span>
                      {c.is_group && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200 shrink-0">群組</span>}
                      <span className="text-xs text-gray-400 font-mono truncate max-w-[120px]">{c.line_user_id}</span>
                    </label>
                  ))
                )}
              </div>
              <div className="px-4 py-3 border-t text-xs text-gray-500">
                已選取 {selectedContactIds.size} 位聯絡人（即發送對象）
              </div>
            </div>
          )}
        </div>

        {/* 第二欄：訊息範本與內容編輯 */}
        <div className="lg:col-span-4 space-y-4">
          <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
            <h3 className="font-bold text-gray-800 text-sm">2. 訊息範本與內容編輯</h3>
            <div className="flex items-center gap-2">
              <select value={selectedTemplateId} onChange={(e) => applyTemplateSelection(e.target.value)} className="flex-1 px-2 py-1.5 border rounded-lg text-sm bg-white">
                <option value="">選擇訊息範本</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
              <button onClick={openNewTemplate} className="p-2 border rounded-lg hover:bg-gray-50" title="新增範本"><Plus className="w-4 h-4 text-gray-500" /></button>
              {selectedTemplate && (
                <>
                  <button onClick={() => openEditTemplate(selectedTemplate)} className="p-2 border rounded-lg hover:bg-gray-50" title="編輯範本"><Pencil className="w-4 h-4 text-gray-500" /></button>
                  <button onClick={() => setDeleteTemplateTarget(selectedTemplate)} className="p-2 border rounded-lg hover:bg-red-50" title="刪除範本"><Trash2 className="w-4 h-4 text-red-500" /></button>
                </>
              )}
            </div>

            <MessageTemplateEditor value={draftBody} onChange={setDraftBody} placeholders={variables} rows={14} placeholder="輸入訊息內容，或點下方快捷欄位插入合併欄位" />

            <div className="flex flex-wrap gap-2 pt-1">
              <button onClick={saveDraftAsTemplate} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                <Save className="w-3.5 h-3.5" /> 儲存範本
              </button>
              <button onClick={() => setShowConfirm(false)} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                <Eye className="w-3.5 h-3.5" /> 預覽套用
              </button>
              <button onClick={() => setDraftBody('')} className="flex items-center gap-1 px-3 py-1.5 border rounded-lg text-xs text-gray-600 hover:bg-gray-50">
                <Eraser className="w-3.5 h-3.5" /> 清空內容
              </button>
            </div>
          </div>
        </div>

        {/* 第三欄：發送預覽 */}
        <div className="lg:col-span-3 space-y-4">
          <div className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
            <h3 className="font-bold text-gray-800 text-sm">3. 發送預覽</h3>

            {previewCustomer ? (
              <div className="space-y-1">
                <p className="text-xs text-gray-400">資料來源：<span className="text-gray-700 font-medium">{referenceLabel}</span></p>
                <div className="border rounded-lg p-3 text-xs space-y-1 bg-gray-50 max-h-48 overflow-y-auto">
                  {Object.entries(previewCustomer.fields).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-2">
                      <span className="text-gray-400 shrink-0">{key}</span>
                      <span className="text-right break-all">{value || '-'}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-400">勾選左側名單中的顧客，這裡會即時預覽套版後的訊息內容。</p>
            )}

            <div className="flex items-start gap-2">
              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                <User className="w-4 h-4 text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="bg-green-50 rounded-2xl rounded-tl-sm px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap break-words">
                  {previewMessage || '（訊息內容預覽）'}
                </div>
                <p className="text-[10px] text-gray-400 mt-1">{new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</p>
              </div>
            </div>

            <p className="text-xs text-gray-500 pt-2 border-t">
              已勾選 <strong className={recipientCount > MAX_BATCH_SEND ? 'text-red-600' : ''}>{recipientCount}</strong> 位（單次上限 {MAX_BATCH_SEND} 位）
              {!isCustomerChannel && (
                <span className="block text-gray-400 mt-0.5">發送帳號：{channels.find((c) => c.id === channelId)?.name}</span>
              )}
            </p>

            <Button onClick={handleSendClick} icon={<Send className="w-4 h-4" />} fullWidth>
              {isCustomerChannel ? '發送給已勾選顧客' : '發送給已勾選聯絡人'}
            </Button>

            {sendResult && (
              <div className="text-xs bg-gray-50 border rounded-lg p-3 space-y-1">
                <p>發送完成：成功 <strong className="text-green-600">{sendResult.ok}</strong> 則，失敗 <strong className="text-red-600">{sendResult.fail}</strong> 則。</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 新增/編輯範本 Modal */}
      <Modal
        open={showTemplateModal && !!editingTemplate}
        title={editingTemplate?.id ? '編輯範本' : '新增範本'}
        onClose={() => setShowTemplateModal(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowTemplateModal(false)}>取消</Button>
            <Button onClick={saveTemplate} loading={savingTemplate}>{savingTemplate ? '儲存中...' : '確認'}</Button>
          </>
        }
      >
        {editingTemplate && (
          <>
            <div>
              <label className="block text-xs text-gray-500 mb-1">範本標題</label>
              <input
                value={editingTemplate.title}
                onChange={(e) => setEditingTemplate({ ...editingTemplate, title: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg"
                placeholder="例如：包棟報價通知"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">訊息內容</label>
              <MessageTemplateEditor
                value={editingTemplate.body}
                onChange={(v) => setEditingTemplate({ ...editingTemplate, body: v })}
                placeholders={variables}
                rows={10}
              />
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleteTemplateTarget}
        title="刪除範本"
        message={`確定要刪除「${deleteTemplateTarget?.title}」這個範本嗎？`}
        confirmLabel="刪除"
        danger
        onConfirm={confirmDeleteTemplate}
        onCancel={() => setDeleteTemplateTarget(null)}
      />

      {/* 發送確認 Modal */}
      <ConfirmDialog
        open={showConfirm}
        title="確認發送訊息"
        confirmLabel={sending ? '發送中...' : '確認發送'}
        loading={sending}
        onConfirm={confirmSend}
        onCancel={() => setShowConfirm(false)}
        message={
          <div className="space-y-3">
            <p>
              即將用「{channels.find((c) => c.id === channelId)?.name}」發送給 <strong>{recipientCount}</strong> 位
              {isCustomerChannel
                ? listMode === 'customers' ? '顧客' : '顧客，訊息內容會依各顧客的訂單資訊自動帶入'
                : '聯絡人'}。是否確認發送？
            </p>
            <div className="space-y-1.5">
              <p>✅ 已套用範本：{selectedTemplate?.title || '（自訂內容）'}</p>
              {!isCustomerChannel && <p>📋 資料來源：{referenceLabel || '無（原文發送，不套用合併欄位）'}</p>}
              <p>✅ 發送帳號：{channels.find((c) => c.id === channelId)?.name}</p>
              <p>✅ 發送對象：{recipientCount} 位{isCustomerChannel ? '顧客' : '聯絡人'}</p>
              <p>✅ 發送方式：LINE 訊息</p>
            </div>
            <div className="max-h-40 overflow-y-auto border rounded-lg p-3 space-y-1">
              {recipientDisplayNames.map((name, i) => (
                <div key={i}>・{name}</div>
              ))}
            </div>
          </div>
        }
      />
    </div>
  );
}

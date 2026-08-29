import { useEffect, useMemo, useState, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { Clock, Plus, Pencil, Trash2, AlertTriangle, CheckCircle2, XCircle, PlayCircle } from 'lucide-react';
import { PageHeader, Button, Modal, ConfirmDialog, Switch, EmptyState } from '../components/ui';
import { Recurrence, ScheduleConfig, computeNextRunAt, describeSchedule, MIN_INTERVAL_MINUTES } from '../lib/scheduleRecurrence';
import { useTemplateVariables, TemplateVariableScope } from '../hooks/useTemplateVariables';
import NoticeComposer, { type NoticeRecipient, type MentionMember } from '../components/NoticeComposer';

// 排程類型清單：之後新增排程類型（定時寄信、到期通知、LINE 分眾發送...）只需要在這裡多加一筆，
// 不用改頁面其他邏輯或資料表結構。
// 每一筆都要在 netlify/functions/scheduled-tasks-run.ts 的 TASK_EXECUTORS 有對應實作，
// 否則排程到期時只會記錄一句「未知的排程類型」。
//
// needsTemplate：這個類型會直接通知客人本人，要在下面選一個「客製訊息範本」，套用跟訂房流程
//   罐頭訊息同一套 [變數] 合併欄位系統。
// needsGroup：這個類型是彙整多筆訂單、通知內部/廠商用的「通知名單」，格式固定（標題＋清單），
//   不走範本系統——這類訊息本來就是狀態報告，不是要客製化的顧客訊息。
// 兩者都要的（例如尾款排程）表示同時做兩件事：通知客人本人 + 彙整清單通知內部名單。
// needsLineGroups：這個類型會把訊息發到「機器人被邀進去的 LINE 群組」（line_groups），
//   跟 needsGroup 的「通知名單」是兩回事——那個是一份 user ID 清單，這個是群組聊天室本身。
//   目前是洗滌單與押金通知用得到，而且是選填：沒設定就只做狀態轉換、不發訊息。
//   noticeScope：這個類型的通知訊息能算出哪一組專屬變數（洗滌單的布巾數量／押金通知的金額），
//   決定範本編輯器裡哪幾區是實際有值的，見 useTemplateVariables。
const TASK_TYPE_OPTIONS: {
  value: string; label: string; description: string;
  needsTemplate?: boolean; needsGroup?: boolean; needsLineGroups?: boolean;
  noticeScope?: TemplateVariableScope; noticeLabel?: string; noticeHint?: ReactNode; noticePlaceholder?: string;
}[] = [
  {
    value: 'cancel_unpaid_bookings',
    label: '訂單自動取消',
    description: '取消狀態為「待確認」（客人已回是要訂房，但超過匯款期限 [匯款日時間] 仍未回報匯款）的訂單。不會另外通知顧客，但會推播給真人客服帳號。',
  },
  {
    value: 'notify_checkout_completed',
    label: '訂單完成統計推播',
    description: '把已經過退房日的訂單整理成統計，推播給「廠商用」與「團隊內部用」官方帳號的所有聯絡人。每筆訂單只會推播一次。建議設定為每天執行一次。',
  },
  {
    value: 'advance_to_awaiting_balance',
    label: '訂單狀態：已預定→待收尾款',
    description:
      '入住日剩 3 天的「已預定」訂單，自動轉為「待收尾款」。' +
      '另外可以選填「待收尾款通知內容」與「發送對象」：填了就會把這批訂單彙整成一則訊息，發給指定的 LINE 群組或聯絡人；' +
      '兩者都留空就只做狀態轉換、不發任何訊息。建議設定為每天 00:00。',
    needsLineGroups: true,
    noticeScope: 'booking',
    noticeLabel: '待收尾款通知',
    noticePlaceholder: `日期:[日期]
以下 [訂單數] 筆訂單入住日剩 3 天，尚未收尾款：
[姓名]／[入住日期]
請協助追款`,
  },
  {
    value: 'checkin_reminder_notice',
    label: '入住前提醒（入住日前 2 天）',
    description:
      '入住日是 2 天後、狀態為「待入住」的訂單，把這批訂單彙整成一則訊息發給指定的 LINE 群組或聯絡人。' +
      '純通知排程，不會改動任何訂單狀態（狀態轉換由「待入住→入住中」那支在入住當天處理），也不會發訊息給客人。' +
      '通知內容與發送對象都留空就不發。建議設定為每天 09:00。',
    needsLineGroups: true,
    noticeScope: 'booking',
    noticeLabel: '入住前提醒',
    noticePlaceholder: `日期:[日期]
後天入住共 [訂單數] 筆：
[姓名]／[入住日期]／[房型]
請提前準備`,
  },
  {
    value: 'advance_to_checked_in',
    label: '訂單狀態：待入住→入住中（含洗滌單）',
    description:
      '入住日就是今天的「待入住」訂單，自動轉為「入住中」。' +
      '另外可以選填「洗滌單內容」與「發送對象」：填了就會把這批訂單今天要用的布巾品項數量加總，發給指定的 LINE 群組或聯絡人；' +
      '兩者都留空就只做狀態轉換、不發任何訊息。' +
      '洗滌單內容直接寫在下面，可插入 [日期]、[訂單數]、[布巾明細]、[布巾明細(簡稱)]，以及每個布巾品項各自的數量。' +
      '建議設定為每天 13:00。',
    needsLineGroups: true,
    noticeScope: 'laundry',
    noticeLabel: '洗滌單',
    noticePlaceholder: `日期:[日期]
[布巾明細(簡稱)]
NG:0
下午取
謝謝`,
    noticeHint: (
      <>
        [布巾明細] 跟 [布巾明細(簡稱)] 都會展開成「品項：數量」多行，差別只在品項名稱：
        前者用<strong>完整名稱</strong>（備品管理裡的分類＋規格，內部核對用），
        後者用<strong>洗滌單簡稱</strong>（發給洗滌廠的單子用，沒填簡稱的品項會自動退回完整名稱）。
        也可以改用「布巾備品洗滌成本」區每個品項各自的按鈕自己排版，那些變數帶入的是
        <strong>當日入住訂單的加總數量</strong>（沒用到的品項是 0），名稱用的是簡稱，改了簡稱記得回來重新插入。
      </>
    ),
  },
  {
    value: 'advance_to_deposit_processing',
    label: '訂單狀態：入住中→押金處理',
    description:
      '退房日就是今天的「入住中」訂單，自動轉為「押金處理」（不分押金多少，全部都轉）。' +
      '轉完之後，這批訂單裡「押金大於 0」的那幾筆會另外發一則通知；押金全是 0 就不發。' +
      '通知內容與發送對象都是選填，兩者都留空就只做狀態轉換、不發任何訊息。建議設定為每天 12:00。',
    needsLineGroups: true,
    noticeScope: 'deposit',
    noticeLabel: '押金通知',
    noticePlaceholder: `日期:[日期]
待退押金共 [訂單數] 筆，合計 [押金總額]
[押金明細]
請安排退款`,
    noticeHint: (
      <>
        [押金明細] 會自動展開成「訂單編號 姓名：押金金額」多行，[押金總額] 是這幾筆的合計。
        只有<strong>押金大於 0</strong> 的訂單會被算進去，押金是 0 的雖然一樣會轉狀態，但不會出現在這則通知裡。
      </>
    ),
  },
  {
    value: 'balance_reminder',
    label: '尾款提醒排程',
    description:
      '入住日在 3 天內、狀態仍是「待收尾款」的訂單，做兩件事：(1) 用「客製訊息範本」直接提醒客人本人繳尾款；' +
      '(2) 另外可以選填「尾款提醒通知內容」與「發送對象」，把這批訂單彙整成一則訊息發給指定的 LINE 群組或聯絡人。' +
      '兩件事各自獨立，只想做其中一件就把另一件留空。建議設定為每天執行。',
    needsTemplate: true,
    needsLineGroups: true,
    noticeScope: 'booking',
    noticeLabel: '尾款提醒通知',
    noticePlaceholder: `日期:[日期]
以下 [訂單數] 筆訂單即將入住，尚未收到尾款：
[姓名]／[入住日期]／[尾款]
請協助追款`,
  },
  {
    value: 'deposit_awaiting_notice',
    label: '待預定回覆提醒',
    description: '狀態仍是「待預定」（報價已送出、客人還沒回是否要訂）、且是昨天建立的訂單，提醒客人記得回覆是否要訂房。建議設定為每天 09:00。範本內容請寫「提醒回覆」而非「提醒匯款」——匯款是客人回「是」之後才需要做的事。',
    needsTemplate: true,
  },
  {
    value: 'awaiting_confirmation_notice',
    label: '待確認訂單通知',
    description: '狀態為「待確認」（客人已確認要訂房、待核對匯款到帳）的訂單，彙整清單通知給通知名單；其中訂單建立時間是昨天的，另外直接推播提醒客人本人記得完成匯款。建議設定為每天 09:00。',
    needsTemplate: true,
    needsGroup: true,
  },
  {
    value: 'checkin_notice',
    label: '入住通知排程',
    description: '入住日就是今天的「待入住」訂單，通知客人本人（範本裡可以用 [入住密碼] 帶入訂單管理設定的入住密碼）。建議設定為每天 09:00。',
    needsTemplate: true,
  },
  {
    value: 'deposit_processing_notice',
    label: '押金處理通知',
    description: '狀態為「押金處理」的訂單，彙整清單通知給通知名單去核對退還押金。建議設定為每天 15:00。',
    needsGroup: true,
  },
  {
    value: 'laundry_notice',
    label: '洗滌排程',
    description: '退房日就是今天、狀態為「押金處理」的訂單，彙整清單通知給通知名單安排布巾送洗。建議設定為每天 12:00。',
    needsGroup: true,
  },
  {
    value: 'sync_calendars',
    label: '行事曆整合同步',
    description: '兩步驟：(1) 抓取「第三方平台」頁面設定的 Airbnb／Booking.com／Agoda／Trip 匯入網址，同步新增/更新/取消對應訂單（狀態顯示為「外部平台已訂」），偵測到跟其他訂單撞期時推播提醒真人客服，不會自動處理。(2) 把整合後、目前所有佔用中的訂單（不分來源）同步寫入「基本設定」設定好的 Google 行事曆。不會發送任何訊息給客人。建議設定為每 15~30 分鐘執行一次。',
  },
  {
    value: 'process_waitlist',
    label: '候補自動配對',
    description: 'AI 訂房流程遇到排不出房或檔期衝突時，會把訂單排入候補並記住是被哪一筆訂單卡住。這個排程會定期檢查候補名單，只要卡住的那筆訂單「有結果」了（變成已預定，或取消/待退款/已退款），就自動重新試算一次報價並主動推播給候補的客人；同一時間有多筆候補時，人數較多的優先。只會重試一次，重試後若仍無法安排會轉真人處理，不會無限重試。建議設定為每 15~30 分鐘執行一次。',
  },
];

function taskTypeOption(value: string) {
  return TASK_TYPE_OPTIONS.find((t) => t.value === value);
}

const RECURRENCE_OPTIONS: { value: Recurrence; label: string }[] = [
  { value: 'once', label: '單次' },
  { value: 'every_n_minutes', label: '每 N 分鐘' },
  { value: 'hourly', label: '每小時' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每週' },
  { value: 'monthly', label: '每月' },
];

const WEEKDAY_OPTIONS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

interface ScheduledTask {
  id: string;
  name: string;
  task_type: string;
  config: Record<string, any> | null;
  recurrence: Recurrence;
  run_at_time: string;
  run_at_date: string | null;
  weekday: number | null;
  day_of_month: number | null;
  interval_minutes: number | null;
  is_active: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: 'success' | 'failed' | null;
  last_run_summary: string | null;
}

type TaskForm = {
  id?: string;
  name: string;
  task_type: string;
  recurrence: Recurrence;
  run_at_time: string;
  run_at_date: string;
  weekday: number;
  day_of_month: number;
  interval_minutes: number;
  // 排程類型專屬參數（見 TASK_TYPE_OPTIONS 的 needsTemplate / needsGroup），存進 scheduled_tasks.config。
  template_id: string;
  notification_group_id: string;
  line_recipients: NoticeRecipient[];
  // 每個群組各自要 @tag 哪些成員：{ [groupId]: [{ id, name }] }。
  mention_members: Record<string, MentionMember[]>;
  // 通知內容直接寫在排程設定裡，不從「客製訊息範本」挑——它的變數（布巾品項數量、押金金額）
  // 只有這支排程算得出來，放進共用範本庫對其他排程沒有意義。
  notice_template: string;
};

const emptyForm = (): TaskForm => ({
  name: '',
  task_type: TASK_TYPE_OPTIONS[0].value,
  recurrence: 'daily',
  run_at_time: '09:00',
  run_at_date: '',
  weekday: 1,
  day_of_month: 1,
  interval_minutes: MIN_INTERVAL_MINUTES,
  template_id: '',
  notification_group_id: '',
  line_recipients: [],
  mention_members: {},
  notice_template: '',
});

function formToConfig(form: TaskForm): ScheduleConfig {
  return {
    recurrence: form.recurrence,
    runAtTime: form.run_at_time,
    runAtDate: form.run_at_date || null,
    weekday: form.weekday,
    dayOfMonth: form.day_of_month,
    intervalMinutes: form.interval_minutes,
  };
}

// 排程類型專屬參數，存進 scheduled_tasks.config（JSONB）。跟上面的 formToConfig 是兩件不同的事——
// 那個是「什麼時候跑」，這個是「跑的時候要用哪個範本/通知名單」。只存這個類型真的用得到的欄位，
// 不相關的欄位不寫入，避免舊資料殘留造成混淆。
function buildTaskConfig(form: TaskForm): Record<string, any> {
  const opt = taskTypeOption(form.task_type);
  const config: Record<string, any> = {};
  if (opt?.needsTemplate) config.template_id = form.template_id || null;
  if (opt?.needsGroup) config.notification_group_id = form.notification_group_id || null;
  if (opt?.needsLineGroups) {
    config.line_recipients = form.line_recipients;
    config.notice_template = form.notice_template;
    config.mention_members = form.mention_members;
  }
  return config;
}

function taskTypeLabel(taskType: string): string {
  return taskTypeOption(taskType)?.label || taskType;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface TemplateOption { id: string; title: string }
// LINE 群組清單只留給「載入舊設定時把群組 ID 補上所屬帳號」用；勾選介面本身已經搬到
// NoticeComposer，那裡自己查自己要的資料。
interface LineGroupOption { group_id: string; channel_id: string }

interface GroupOption { id: string; name: string; channel_id: string }

export default function ScheduledTasks() {
  const [rows, setRows] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [groups, setGroups] = useState<GroupOption[]>([]);
  // 只留給「載入舊設定時把群組 ID 補上所屬帳號」用（見 openEdit）。勾選介面與它需要的
  // 帳號／群組／聯絡人／成員清單都由 NoticeComposer 自己查，這裡不再重複維護一份。
  const [lineGroups, setLineGroups] = useState<LineGroupOption[]>([]);
  const [channelNameById, setChannelNameById] = useState<Record<string, string>>({});

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskForm>(emptyForm());
  // 快捷插入清單（含分區），所有範本編輯器共用同一份來源，見 useTemplateVariables。
  // scope 跟著目前選的排程類型走：決定「洗滌單」「布巾備品洗滌成本」「押金通知」哪一組
  // 在這個編輯器真的算得出值，其餘會被標成警示色。
  const templateVars = useTemplateVariables(taskTypeOption(form.task_type)?.noticeScope || 'message');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [runningId, setRunningId] = useState<string | null>(null);

  useEffect(() => {
    fetchRows();
    fetchTemplateAndGroupOptions();
  }, []);

  const fetchRows = async () => {
    setLoading(true);
    setErrorMsg('');
    const { data, error } = await supabase.from('scheduled_tasks').select('*').order('created_at');
    if (error) {
      setErrorMsg(`查詢失敗：${error.message}（資料表可能還沒建立，請先在 Supabase 執行 supabase_schema.sql）`);
      setRows([]);
    } else {
      setRows(data || []);
    }
    setLoading(false);
  };

  // 「客製訊息範本」跟「通知名單」的下拉選單資料，跟 scheduled_tasks 本身無關，
  // 獨立查一次即可，不用每次開表單都重查。
  const fetchTemplateAndGroupOptions = async () => {
    const [templateRes, groupRes, channelRes, lineGroupRes] = await Promise.all([
      supabase.from('custom_message_templates').select('id, title').order('created_at'),
      supabase.from('notification_recipient_groups').select('id, name, channel_id').order('created_at', { ascending: false }),
      supabase.from('line_channels').select('id, name'),
      // 機器人被邀進去的 LINE 群組聊天室（洗滌單發送對象）。只列還在使用中的。
      supabase.from('line_groups').select('group_id, name, channel_id, chat_type').eq('is_active', true).order('last_message_at', { ascending: false, nullsFirst: false }),
    ]);
    setTemplates(templateRes.data || []);
    setGroups(groupRes.data || []);
    setLineGroups(lineGroupRes.data || []);
    setChannelNameById(Object.fromEntries((channelRes.data || []).map((c: any) => [c.id, c.name])));
  };

  const openNew = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (row: ScheduledTask) => {
    setEditingId(row.id);
    setForm({
      id: row.id,
      name: row.name,
      task_type: row.task_type,
      recurrence: row.recurrence,
      run_at_time: (row.run_at_time || '09:00').slice(0, 5),
      run_at_date: row.run_at_date || '',
      weekday: row.weekday ?? 1,
      day_of_month: row.day_of_month ?? 1,
      interval_minutes: row.interval_minutes ?? MIN_INTERVAL_MINUTES,
      template_id: row.config?.template_id || '',
      notification_group_id: row.config?.notification_group_id || '',
      // 舊設定只存群組 ID 陣列，沒有帳號；載入時對照 line_groups 補上，存檔就會轉成新格式。
      line_recipients: Array.isArray(row.config?.line_recipients)
        ? row.config.line_recipients
        : (Array.isArray(row.config?.line_group_ids) ? row.config.line_group_ids : [])
            .map((gid: string) => {
              const g = lineGroups.find((x) => x.group_id === gid);
              return g ? { id: gid, channel_id: g.channel_id } : null;
            })
            .filter(Boolean) as NoticeRecipient[],
      mention_members:
        row.config?.mention_members && typeof row.config.mention_members === 'object' && !Array.isArray(row.config.mention_members)
          ? row.config.mention_members
          : {},
      // notice_template 是現在的欄位名；laundry_template 是這個功能最初只有洗滌單時的舊名稱，
      // 保留讀取，既有排程設定不會因為改版變空白。
      notice_template: row.config?.notice_template ?? row.config?.laundry_template ?? '',
    });
    setFormError('');
    setShowForm(true);
  };

  const currentTaskType = taskTypeOption(form.task_type);

  const handleSave = async () => {
    if (!form.name.trim()) return setFormError('請輸入排程名稱');
    if (form.recurrence === 'once' && !form.run_at_date) return setFormError('請選擇執行日期');
    // needsLineGroups 的類型（洗滌單、押金通知）內容是選填，但「只填其中一個」一定是設定到一半，要擋下來。
    if (currentTaskType?.needsTemplate && !currentTaskType?.needsLineGroups && !form.template_id)
      return setFormError('這個排程類型需要選擇一個客製訊息範本');
    if (currentTaskType?.needsLineGroups) {
      const noticeLabel = `${currentTaskType.noticeLabel || '通知'}內容`;
      const hasTemplate = !!form.notice_template.trim();
      if (hasTemplate && !form.line_recipients.length) return setFormError(`已填寫${noticeLabel}，請一併勾選要發送的對象`);
      if (!hasTemplate && form.line_recipients.length) return setFormError(`已勾選發送對象，請一併填寫${noticeLabel}`);
    }
    if (currentTaskType?.needsGroup && !form.notification_group_id) return setFormError('這個排程類型需要選擇一個通知名單');

    const nextRunAt = computeNextRunAt(formToConfig(form), Date.now());
    if (!nextRunAt) return setFormError('算不出下一次執行時間，單次排程的日期時間必須在現在之後');

    setSaving(true);
    setFormError('');
    try {
      const payload = {
        name: form.name.trim(),
        task_type: form.task_type,
        config: buildTaskConfig(form),
        recurrence: form.recurrence,
        run_at_time: form.run_at_time,
        run_at_date: form.recurrence === 'once' ? form.run_at_date : null,
        weekday: form.recurrence === 'weekly' ? form.weekday : null,
        day_of_month: form.recurrence === 'monthly' ? form.day_of_month : null,
        interval_minutes: form.recurrence === 'every_n_minutes' ? form.interval_minutes : null,
        is_active: true,
        next_run_at: nextRunAt.toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (editingId) {
        const { error } = await supabase.from('scheduled_tasks').update(payload).eq('id', editingId);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('scheduled_tasks').insert(payload);
        if (error) throw error;
      }
      setShowForm(false);
      await fetchRows();
    } catch (e: any) {
      setFormError(`儲存失敗：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('scheduled_tasks').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      await fetchRows();
    } catch (e: any) {
      setErrorMsg(`刪除失敗：${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  // 重新啟用時要用「現在」重算下一次時間，不能沿用停用前的舊值——
  // 不然一個停用了兩週的每日排程，重新打開的瞬間會被 ticker 當成「積欠了 14 次」全部補跑。
  const toggleActive = async (row: ScheduledTask) => {
    const nextActive = !row.is_active;
    const patch: Record<string, any> = { is_active: nextActive, updated_at: new Date().toISOString() };
    if (nextActive) {
      const nextRunAt = computeNextRunAt(
        {
          recurrence: row.recurrence, runAtTime: row.run_at_time, runAtDate: row.run_at_date,
          weekday: row.weekday, dayOfMonth: row.day_of_month, intervalMinutes: row.interval_minutes,
        },
        Date.now()
      );
      if (!nextRunAt) {
        setErrorMsg('這個排程算不出下一次執行時間（單次排程的時間可能已經過去），請改用「編輯」重新設定時間。');
        return;
      }
      patch.next_run_at = nextRunAt.toISOString();
    }
    const { error } = await supabase.from('scheduled_tasks').update(patch).eq('id', row.id);
    if (error) {
      setErrorMsg(`更新失敗：${error.message}`);
      return;
    }
    await fetchRows();
  };

  // 立即執行（測試用）：不管 next_run_at 有沒有到期都馬上跑一次，但不影響原本排程的下次執行時間。
  const runNow = async (row: ScheduledTask) => {
    setRunningId(row.id);
    setErrorMsg('');
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const res = await fetch('/.netlify/functions/run-task-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ taskId: row.id }),
      });
      // 先讀純文字再自己 parse：回應本文是空的時候直接呼叫 res.json() 會丟出讓人看不懂的
      // 「Unexpected end of JSON input」。空本文一定要連 HTTP 狀態一起講——這段訊息曾經寫死成
      // 「資料量太大所以逾時」，但當時真正的原因是打到了不能用 HTTP 呼叫的排程函式，
      // 每一個排程都失敗，訊息卻把人帶去查資料量。
      const rawText = await res.text();
      let result: any = null;
      try { result = rawText ? JSON.parse(rawText) : null; } catch {}
      if (!res.ok || !result) {
        const detail = result?.error
          || (!rawText ? `伺服器回應是空的（HTTP ${res.status}）。若是「行事曆整合同步」這種要處理大量訂單的排程，可能是超過單次執行上限——排程自己到點執行不受這個上限影響。` : `HTTP ${res.status}`);
        throw new Error(detail);
      }
      await fetchRows();
    } catch (e: any) {
      setErrorMsg(`立即執行失敗：${e.message}`);
    } finally {
      setRunningId(null);
    }
  };

  const previewConfig = formToConfig(form);
  const previewNextRun = computeNextRunAt(previewConfig, Date.now());

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="w-full space-y-4">
      <PageHeader
        icon={<Clock className="w-6 h-6 text-green-600" />}
        title="排程管理"
        description="設定系統在背景自動執行的任務，例如定期取消逾期未匯款的訂單。"
        action={<Button onClick={openNew} icon={<Plus className="w-4 h-4" />}>新增排程</Button>}
      />

      {errorMsg && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-600 text-xs">關閉</button>
        </div>
      )}

      <p className="text-xs text-gray-400 bg-gray-50 border rounded-lg px-4 py-2.5">
        排程時間每 15 分鐘檢查一次，不是精準到秒——設定「09:00」代表系統會在 09:00 到 09:15 之間的某個時間點執行。
      </p>

      {rows.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <EmptyState icon={<Clock className="w-12 h-12 text-gray-200" />} message="還沒有任何排程，點右上角「新增排程」開始" />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((row) => (
            <div key={row.id} className="bg-white rounded-xl shadow-sm border p-5 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-gray-800 truncate">{row.name}</p>
                  <span className="inline-block mt-1 text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{taskTypeLabel(row.task_type)}</span>
                </div>
                <Switch checked={row.is_active} onChange={() => toggleActive(row)} title={row.is_active ? '啟用中' : '已停用'} />
              </div>
              {taskTypeOption(row.task_type)?.description && (
                <p className="text-xs text-gray-500 leading-relaxed">{taskTypeOption(row.task_type)?.description}</p>
              )}
              <p className="text-xs text-gray-500">
                {describeSchedule({ recurrence: row.recurrence, runAtTime: row.run_at_time, runAtDate: row.run_at_date, weekday: row.weekday, dayOfMonth: row.day_of_month })}
                {row.is_active && row.next_run_at && <span className="text-gray-400 block mt-0.5">下次執行約 {formatDateTime(row.next_run_at)}</span>}
              </p>
              {row.last_run_at && (
                <p className="flex items-start gap-1.5 text-xs">
                  {row.last_run_status === 'success' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                  )}
                  <span>
                    <span className="text-gray-400">上次執行 {formatDateTime(row.last_run_at)}：</span>
                    <span className="text-gray-600">{row.last_run_summary}</span>
                  </span>
                </p>
              )}
              <div className="flex items-center gap-2 pt-1 mt-auto border-t flex-wrap">
                <button
                  onClick={() => runNow(row)}
                  disabled={runningId === row.id}
                  className="flex items-center gap-1 text-xs text-blue-600 hover:bg-blue-50 rounded-lg px-2 py-1.5 mt-1 disabled:opacity-50"
                  title="不管排程時間到了沒，立即測試執行一次；不會影響原本的下次執行時間"
                >
                  <PlayCircle className="w-3.5 h-3.5" />{runningId === row.id ? '執行中...' : '立即執行'}
                </button>
                <button onClick={() => openEdit(row)} className="flex items-center gap-1 text-xs text-gray-600 hover:bg-gray-100 rounded-lg px-2 py-1.5 mt-1"><Pencil className="w-3.5 h-3.5" />編輯</button>
                <button onClick={() => setDeleteTarget(row)} className="flex items-center gap-1 text-xs text-red-500 hover:bg-red-50 rounded-lg px-2 py-1.5 mt-1"><Trash2 className="w-3.5 h-3.5" />刪除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        title={editingId ? '編輯排程' : '新增排程'}
        onClose={() => setShowForm(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
            <Button onClick={handleSave} loading={saving}>{saving ? '儲存中...' : '儲存'}</Button>
          </>
        }
      >
        <div>
          <label className="block text-xs text-gray-500 mb-1">排程名稱</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：每日取消逾期未匯款訂單" />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">排程類型</label>
          <select value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value, template_id: '', notification_group_id: '' })} className="w-full px-3 py-2 border rounded-lg bg-white">
            {TASK_TYPE_OPTIONS.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
          </select>
          <p className="text-xs text-gray-400 mt-1">{currentTaskType?.description}</p>
        </div>

        {currentTaskType?.needsTemplate && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              客製訊息範本<span className="text-red-500"> *</span>
            </label>
            {templates.length === 0 ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                還沒有任何範本，請先到「客製訊息發送」頁新增一個。
              </p>
            ) : (
              <select value={form.template_id} onChange={(e) => setForm({ ...form, template_id: e.target.value })} className="w-full px-3 py-2 border rounded-lg bg-white">
                <option value="">請選擇範本</option>
                {templates.map((t) => (<option key={t.id} value={t.id}>{t.title}</option>))}
              </select>
            )}
            <p className="text-xs text-gray-400 mt-1">這則訊息會直接發給訂單本人，範本裡可以用「訊息變數資料維護」設定的 [變數]。</p>
          </div>
        )}

        {currentTaskType?.needsLineGroups && (
          <NoticeComposer
            label={currentTaskType.noticeLabel || '通知'}
            template={form.notice_template}
            onTemplateChange={(v) => setForm((f) => ({ ...f, notice_template: v }))}
            recipients={form.line_recipients}
            onRecipientsChange={(v) => setForm((f) => ({ ...f, line_recipients: v }))}
            mentions={form.mention_members}
            onMentionsChange={(v) => setForm((f) => ({ ...f, mention_members: v }))}
            templateVars={templateVars}
            placeholder={currentTaskType.noticePlaceholder}
            hint={currentTaskType.noticeHint}
          />
        )}

        {currentTaskType?.needsGroup && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">
              通知名單<span className="text-red-500"> *</span>
            </label>
            {groups.length === 0 ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                還沒有任何通知名單，請先到「系統設定 → LINE 串接設定」新增一個。
              </p>
            ) : (
              <select value={form.notification_group_id} onChange={(e) => setForm({ ...form, notification_group_id: e.target.value })} className="w-full px-3 py-2 border rounded-lg bg-white">
                <option value="">請選擇通知名單</option>
                {groups.map((g) => (<option key={g.id} value={g.id}>{g.name}（{channelNameById[g.channel_id] || '未知帳號'}）</option>))}
              </select>
            )}
            <p className="text-xs text-gray-400 mt-1">這是彙整清單通知，格式固定（標題＋筆數＋逐筆列出），不套用範本系統。</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">頻率</label>
            <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value as Recurrence })} className="w-full px-3 py-2 border rounded-lg bg-white">
              {RECURRENCE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          {form.recurrence === 'every_n_minutes' ? (
            <div>
              <label className="block text-xs text-gray-500 mb-1">每幾分鐘</label>
              <input
                type="number" min={MIN_INTERVAL_MINUTES} step={MIN_INTERVAL_MINUTES}
                value={form.interval_minutes}
                onChange={(e) => setForm({ ...form, interval_minutes: Math.max(MIN_INTERVAL_MINUTES, Number(e.target.value) || MIN_INTERVAL_MINUTES) })}
                className="w-full px-3 py-2 border rounded-lg"
              />
              <p className="text-xs text-gray-400 mt-1">下限 {MIN_INTERVAL_MINUTES} 分鐘——排程檢查心跳本身固定每 {MIN_INTERVAL_MINUTES} 分鐘一次，設更短也不會更密集執行。</p>
            </div>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 mb-1">{form.recurrence === 'hourly' ? '每小時第幾分' : '時間'}</label>
              <input type="time" value={form.run_at_time} onChange={(e) => setForm({ ...form, run_at_time: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
              {form.recurrence === 'hourly' && <p className="text-xs text-gray-400 mt-1">選「每小時」時只有分鐘數有效，小時欄位會被忽略。</p>}
            </div>
          )}
        </div>

        {form.recurrence === 'once' && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">執行日期</label>
            <input type="date" value={form.run_at_date} onChange={(e) => setForm({ ...form, run_at_date: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
        )}

        {form.recurrence === 'weekly' && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">星期</label>
            <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })} className="w-full px-3 py-2 border rounded-lg bg-white">
              {WEEKDAY_OPTIONS.map((label, i) => (<option key={i} value={i}>{label}</option>))}
            </select>
          </div>
        )}

        {form.recurrence === 'monthly' && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">每月幾號</label>
            <input
              type="number" min={1} max={31}
              value={form.day_of_month}
              onChange={(e) => setForm({ ...form, day_of_month: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
              className="w-full px-3 py-2 border rounded-lg"
            />
            <p className="text-xs text-gray-400 mt-1">該月天數不足時，會自動順延到當月最後一天執行（例如設 31 號，2 月就會在 28 或 29 號執行）。</p>
          </div>
        )}

        <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs text-gray-600">
          {previewNextRun
            ? <>下一次執行：<strong className="text-gray-800">{formatDateTime(previewNextRun.toISOString())}</strong></>
            : <span className="text-amber-700">尚未設定完整，還算不出下一次執行時間</span>}
        </div>

        {formError && <p className="text-sm text-red-600">{formError}</p>}
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除排程"
        message={`確定要刪除排程「${deleteTarget?.name}」嗎？`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import {
  MessageSquareText, Plus, Trash2, Pencil, Calculator, CheckCircle2, Wallet,
  MessageCircleQuestion, Sparkles, Cpu, AlertTriangle, UserRound, ArrowRight, Search,
} from 'lucide-react';
import MessageTemplateEditor from '../components/MessageTemplateEditor';
import VariableText from '../components/VariableText';
import { PageHeader, Button, ConfirmDialog, Switch, EmptyState } from '../components/ui';
import { TriggerRule, KeywordMatch, parseTriggerRules, serializeTriggerRules } from '../lib/messageVariables';

const NO_PURPOSE_OPTION = { value: '', label: '無（純收集資訊）' };

const BASE_QUOTE_FIELD_OPTIONS = [
  NO_PURPOSE_OPTION,
  { value: 'checkin_date', label: '算價：入住日期' },
  { value: 'checkout_date', label: '算價：退房日期' },
  { value: 'headcount', label: '算價：入住人數' },
  { value: 'whole_house', label: '算價：是否包棟' },
];

// query 型流程只需要一種特殊用途：標記哪個答案是查詢用的訂單編號。
const QUERY_FIELD_OPTIONS = [NO_PURPOSE_OPTION, { value: 'order_number', label: '查詢依據：訂單編號' }];

// 三種流程類型共用的顯示資訊（圖示/標題/說明），選擇器跟各處的類型標籤都從這裡取，
// 才不會三個地方各寫一份、之後改一個忘了改另一個。
const FLOW_TYPE_OPTIONS: { value: FlowType; icon: JSX.Element; title: string; desc: string }[] = [
  { value: 'quote', icon: <Calculator className="w-4 h-4" />, title: '報價訂房', desc: '算價欄位收集齊後自動試算，走報價確認與付款確認，會建立訂單紀錄。' },
  { value: 'collect', icon: <MessageSquareText className="w-4 h-4" />, title: '一般收集', desc: '純問答/收集資訊，走完步驟直接送出完成訊息結束，不算價、不建立訂單紀錄。' },
  { value: 'query', icon: <Search className="w-4 h-4" />, title: '查詢訂單', desc: '用訂單編號查既有訂單狀態，只讀不寫，不會建立新的訂單紀錄。' },
];

function flowTypeMeta(type: FlowType) {
  return FLOW_TYPE_OPTIONS.find((o) => o.value === type) || FLOW_TYPE_OPTIONS[0];
}

// 「幾人房要開幾間」的選項是資料驅動的：讀「房型與空間維護」裡實際存在的房間人數，
// 新增一種人數的房間就會自動出現在這裡，不用改程式。
// 這類欄位不影響價格（價格仍由報價引擎決定），只決定實際開哪幾間房。
function roomCountOptions(capacities: number[]) {
  return capacities.map((c) => ({ value: `room_count:${c}`, label: `開房：${c} 人房間數` }));
}

// UI 用一個字串表示，存進資料庫時拆成 quote_field + room_capacity
function encodeQuoteField(quoteField: string | null, roomCapacity: number | null | undefined): string {
  if (quoteField === 'room_count' && roomCapacity != null) return `room_count:${roomCapacity}`;
  return quoteField || '';
}

function decodeQuoteField(value: string): { quote_field: string | null; room_capacity: number | null } {
  if (value.startsWith('room_count:')) {
    return { quote_field: 'room_count', room_capacity: Number(value.slice('room_count:'.length)) };
  }
  return { quote_field: value || null, room_capacity: null };
}

// 這三個算價欄位全部收集齊，流程走完才算得出金額、才會進到報價確認與付款確認；
// 少任何一個都會轉真人客服，那兩段訊息永遠不會送出。公式改成不分包棟/個別房的統一公式後，
// 「是否包棟」不再是必要欄位，這裡要跟 line-webhook.ts 的 hasAllQuoteFields 保持一致。
const QUOTE_REQUIRED_FIELDS = ['checkin_date', 'checkout_date', 'headcount'];

const MAX_STEPS = 5;
const MAX_FIELDS_PER_STEP = 10;

const NEW_FLOW_ID = '__new__';

function newId(): string {
  return crypto.randomUUID();
}

// 兩條觸發規則「重疊」：同一句客人訊息可能同時命中兩邊。字串完全相同一定算；
// 不然只要比較短的關鍵字是比較長的子字串，就代表包含關係的訊息兩邊都會命中
// （粗略但夠用的啟發式判斷，目的是提醒管理員自己確認，不是精確的邏輯證明）。
function keywordsOverlap(a: TriggerRule, b: TriggerRule): boolean {
  if (!a.keyword || !b.keyword) return false;
  if (a.keyword === b.keyword) return true;
  const [shorter, longer] = a.keyword.length <= b.keyword.length ? [a.keyword, b.keyword] : [b.keyword, a.keyword];
  return longer.includes(shorter);
}

// 儲存時只是提醒，不阻擋——重疊時系統本來就會依 display_order 選第一個，
// 管理員可能就是故意這樣設計（例如一個當備用/兜底流程），不該強制要求修改。
function findOverlappingFlowName(rules: TriggerRule[], excludeId: string, otherFlows: Flow[]): string | null {
  for (const flow of otherFlows) {
    if (flow.id === excludeId || !flow.is_active) continue;
    if (flow.trigger_rules.some((fr) => rules.some((r) => keywordsOverlap(r, fr)))) return flow.name;
  }
  return null;
}

// value_type：顧客回覆的格式限制，''＝不限。擷取到的值不符合格式時系統會請顧客重新輸入，
// 不會當作已收集（跟「用途」quote_field 是兩件事：用途決定值拿去做什麼，格式決定值長怎樣才算數）。
type FlowField = { key: string; label: string; quote_field: string; value_type: string };

const VALUE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '格式不限' },
  { value: 'date', label: '格式：日期' },
  { value: 'number', label: '格式：數字' },
  { value: 'string', label: '格式：字串' },
];
type FlowStep = { step_order: number; message_template: string; fields: FlowField[] };
type FlowType = 'quote' | 'collect' | 'query';
type Flow = {
  id: string;
  name: string;
  trigger_rules: TriggerRule[];
  reply_mode: 'ai' | 'system';
  // 'quote'＝走完步驟後嘗試算價、跑報價確認/付款確認；'collect'＝純問答/收集資訊，
  // 走完步驟直接送完成訊息結束，不算價、不建立訂單紀錄；'query'＝純查詢既有訂單，只讀不寫。
  flow_type: FlowType;
  quote_message: string;
  confirm_message: string;
  incomplete_message: string; // quote 型：算價欄位沒收集齊時的回覆，空字串＝用內建預設文字
  completion_message: string; // collect 型：走完步驟後的完成訊息，空字串＝用內建預設文字
  notify_agent_on_complete: boolean; // collect 型：完成後要不要推播通知真人客服
  found_message: string; // query 型：查到訂單時的回覆，空字串＝用內建預設文字
  not_found_message: string; // query 型：查無訂單時的回覆，空字串＝用內建預設文字
  is_active: boolean;
  display_order: number;
  steps: FlowStep[];
};

const emptyFlow = (displayOrder: number): Flow => ({
  id: '',
  name: '',
  trigger_rules: [{ keyword: '', match: 'contains' }],
  reply_mode: 'ai',
  flow_type: 'quote',
  quote_message: '',
  confirm_message: '',
  incomplete_message: '',
  completion_message: '',
  notify_agent_on_complete: true,
  found_message: '',
  not_found_message: '',
  is_active: true,
  display_order: displayOrder,
  steps: [{ step_order: 1, message_template: '', fields: [{ key: newId(), label: '', quote_field: '', value_type: '' }] }],
});

function collectedQuoteFields(flow: Flow): Set<string> {
  return new Set(flow.steps.flatMap((s) => s.fields.map((f) => f.quote_field)).filter(Boolean));
}

function missingQuoteFields(flow: Flow): string[] {
  const have = collectedQuoteFields(flow);
  return QUOTE_REQUIRED_FIELDS.filter((k) => !have.has(k)).map(
    (k) => BASE_QUOTE_FIELD_OPTIONS.find((o) => o.value === k)?.label.replace('算價：', '') || k
  );
}

// ------------------------------------------------------------------------
// 版面共用的小元件
// ------------------------------------------------------------------------

function Stage({ index, title, icon, muted, children }: {
  index: number | null;
  title: string;
  icon: React.ReactNode;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3 py-5 border-b last:border-b-0">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold ${
        muted ? 'bg-gray-100 text-gray-400' : 'bg-green-50 text-green-700'
      }`}>
        {index ?? icon}
      </div>
      <div className="min-w-0 flex-1">
        <h4 className={`text-sm font-semibold flex items-center gap-2 ${muted ? 'text-gray-500' : 'text-gray-800'}`}>
          {index !== null && <span className="text-gray-400">{icon}</span>}
          {title}
        </h4>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function KeywordChip({ rule }: { rule: TriggerRule }) {
  const exact = rule.match === 'exact';
  return (
    <span className={`inline-flex items-center rounded-md text-xs overflow-hidden border ${
      exact ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'
    }`}>
      <span className={`px-1.5 py-1 ${exact ? 'text-green-700 bg-green-100' : 'text-gray-500 bg-gray-100'}`}>
        {exact ? '等於' : '相關'}
      </span>
      <span className="px-2 py-1 text-gray-700">{rule.keyword}</span>
    </span>
  );
}

function ReplyModeSummary({ mode }: { mode: 'ai' | 'system' }) {
  return mode === 'ai' ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <Sparkles className="w-3.5 h-3.5 text-green-600" />
      AI 理解顧客回覆<span className="text-gray-400">（讀得懂「下週五」這類說法，每則訊息會用到 token）</span>
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600">
      <Cpu className="w-3.5 h-3.5 text-gray-500" />
      系統自行比對<span className="text-gray-400">（完全不呼叫 AI，只認得標準寫法如 7/30、4 位、包棟）</span>
    </span>
  );
}

// ------------------------------------------------------------------------

export default function StandardMessages() {
  const [loading, setLoading] = useState(true);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [variables, setVariables] = useState<string[]>([]);
  const [roomCapacities, setRoomCapacities] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [warningMsg, setWarningMsg] = useState('');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Flow | null>(null);

  // 答案欄位的「用途」下拉選項依流程類型而不同：quote 型才需要算價/開房這些選項，
  // query 型只需要標記「這是查詢用的訂單編號」，collect 型完全不需要（純收集，沒有下游用途）。
  const fieldPurposeOptions = useMemo(() => {
    if (draft?.flow_type === 'query') return QUERY_FIELD_OPTIONS;
    if (draft?.flow_type === 'collect') return [NO_PURPOSE_OPTION];
    return [...BASE_QUOTE_FIELD_OPTIONS, ...roomCountOptions(roomCapacities)];
  }, [draft?.flow_type, roomCapacities]);
  const [baseline, setBaseline] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Flow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const dirty = editing && draft !== null && JSON.stringify(draft) !== baseline;

  const selected = useMemo(
    () => (selectedId === NEW_FLOW_ID ? draft : flows.find((f) => f.id === selectedId) || null),
    [selectedId, flows, draft]
  );

  useEffect(() => {
    fetchAll();
  }, []);

  // 編輯到一半按上一頁／關掉分頁時，讓瀏覽器跳原生的離開確認，避免辛苦打的內容直接消失。
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const fetchAll = async () => {
    setLoading(true);
    setErrorMsg('');
    const [flowRes, stepRes, varRes, roomRes] = await Promise.all([
      supabase.from('booking_flows').select('*').order('display_order'),
      supabase.from('booking_flow_steps').select('*').order('step_order'),
      supabase.from('message_variables').select('variable_name').order('display_order'),
      supabase.from('room_types').select('capacity').eq('type', '房間').eq('is_active', true),
    ]);

    if (flowRes.error) {
      setErrorMsg(`查詢流程失敗：${flowRes.error.message}`);
      setLoading(false);
      return;
    }

    const list: Flow[] = (flowRes.data || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      trigger_rules: parseTriggerRules(f.trigger_rules, f.trigger_keywords),
      reply_mode: f.reply_mode === 'system' ? 'system' : 'ai',
      flow_type: f.flow_type === 'collect' ? 'collect' : f.flow_type === 'query' ? 'query' : 'quote',
      quote_message: f.quote_message ?? '',
      confirm_message: f.confirm_message ?? '',
      incomplete_message: f.incomplete_message ?? '',
      completion_message: f.completion_message ?? '',
      notify_agent_on_complete: f.notify_agent_on_complete !== false,
      found_message: f.found_message ?? '',
      not_found_message: f.not_found_message ?? '',
      is_active: f.is_active,
      display_order: f.display_order,
      steps: (stepRes.data || [])
        .filter((s: any) => s.flow_id === f.id)
        .map((s: any) => ({
          step_order: s.step_order,
          message_template: s.message_template,
          fields: (s.fields || []).map((f: any) => ({
            key: f.key,
            label: f.label,
            quote_field: encodeQuoteField(f.quote_field, f.room_capacity),
            value_type: f.value_type || '',
          })),
        })),
    }));

    setFlows(list);
    setVariables((varRes.data || []).map((v: any) => v.variable_name));
    setRoomCapacities(
      Array.from(new Set((roomRes.data || []).map((r: any) => r.capacity).filter((c: any) => Number.isFinite(c)))).sort((a: any, b: any) => a - b)
    );
    setSelectedId((prev) => (prev && prev !== NEW_FLOW_ID && list.some((f) => f.id === prev) ? prev : list[0]?.id ?? null));
    setLoading(false);
  };

  // 所有會離開目前編輯狀態的動作都要走這裡：有未儲存的變更就先跳確認視窗。
  const guard = useCallback((action: () => void) => {
    if (dirty) {
      setPendingAction(() => action);
      return;
    }
    action();
  }, [dirty]);

  const selectFlow = (id: string) => guard(() => {
    setSelectedId(id);
    setEditing(false);
    setDraft(null);
  });

  const startNewFlow = () => guard(() => {
    const fresh = emptyFlow(flows.length);
    setDraft(fresh);
    setBaseline(JSON.stringify(fresh));
    setSelectedId(NEW_FLOW_ID);
    setEditing(true);
  });

  const startEdit = () => {
    if (!selected) return;
    const copy: Flow = JSON.parse(JSON.stringify(selected));
    if (copy.trigger_rules.length === 0) copy.trigger_rules = [{ keyword: '', match: 'contains' }];
    setDraft(copy);
    setBaseline(JSON.stringify(copy));
    setEditing(true);
  };

  const cancelEdit = () => guard(() => {
    setEditing(false);
    setDraft(null);
    if (selectedId === NEW_FLOW_ID) setSelectedId(flows[0]?.id ?? null);
  });

  const patchDraft = (patch: Partial<Flow>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  // --- 關鍵字 ---
  const addKeyword = () => draft && patchDraft({ trigger_rules: [...draft.trigger_rules, { keyword: '', match: 'contains' }] });
  const removeKeyword = (i: number) => draft && patchDraft({ trigger_rules: draft.trigger_rules.filter((_, x) => x !== i) });
  const updateKeyword = (i: number, patch: Partial<TriggerRule>) =>
    draft && patchDraft({ trigger_rules: draft.trigger_rules.map((r, x) => (x === i ? { ...r, ...patch } : r)) });

  // --- 步驟 ---
  const addStep = () => {
    if (!draft || draft.steps.length >= MAX_STEPS) return;
    patchDraft({
      steps: [...draft.steps, { step_order: draft.steps.length + 1, message_template: '', fields: [{ key: newId(), label: '', quote_field: '', value_type: '' }] }],
    });
  };
  const removeStep = (i: number) =>
    draft && patchDraft({ steps: draft.steps.filter((_, x) => x !== i).map((s, x) => ({ ...s, step_order: x + 1 })) });
  const updateStep = (i: number, patch: Partial<FlowStep>) =>
    draft && patchDraft({ steps: draft.steps.map((s, x) => (x === i ? { ...s, ...patch } : s)) });

  const addField = (si: number) => {
    if (!draft || draft.steps[si].fields.length >= MAX_FIELDS_PER_STEP) return;
    updateStep(si, { fields: [...draft.steps[si].fields, { key: newId(), label: '', quote_field: '', value_type: '' }] });
  };
  const removeField = (si: number, fi: number) =>
    draft && updateStep(si, { fields: draft.steps[si].fields.filter((_, x) => x !== fi) });
  const updateField = (si: number, fi: number, patch: Partial<FlowField>) =>
    draft && updateStep(si, { fields: draft.steps[si].fields.map((f, x) => (x === fi ? { ...f, ...patch } : f)) });

  // --- 儲存 ---
  const handleSave = async () => {
    if (!draft) return;
    const rules = draft.trigger_rules.map((r) => ({ ...r, keyword: r.keyword.trim() })).filter((r) => r.keyword);

    if (!draft.name.trim()) return setErrorMsg('請輸入流程名稱');
    if (rules.length === 0) return setErrorMsg('請至少設定一個觸發關鍵字');
    for (const step of draft.steps) {
      if (!step.message_template.trim()) return setErrorMsg(`步驟 ${step.step_order} 的訊息內容不能是空的`);
      if (step.fields.some((f) => !f.label.trim())) return setErrorMsg(`步驟 ${step.step_order} 有欄位沒有填名稱`);
    }

    // 觸發條件重疊只是提醒，不擋儲存——重疊時系統依 display_order 選第一個，管理員自己決定要不要調整。
    const overlappingFlowName = draft.is_active ? findOverlappingFlowName(rules, draft.id, flows) : null;
    setWarningMsg(
      overlappingFlowName
        ? `注意：觸發關鍵字跟已啟用的流程「${overlappingFlowName}」重疊。同一句話兩邊都命中時，系統會依排序選第一個，請確認這是您要的結果。`
        : ''
    );

    setSaving(true);
    setErrorMsg('');
    try {
      const payload = {
        name: draft.name.trim(),
        trigger_rules: rules,
        // 舊欄位同步寫入，萬一要退回改版前的程式仍讀得到關鍵字
        trigger_keywords: serializeTriggerRules(rules),
        reply_mode: draft.reply_mode,
        flow_type: draft.flow_type,
        quote_message: draft.quote_message,
        confirm_message: draft.confirm_message,
        incomplete_message: draft.incomplete_message || null,
        completion_message: draft.completion_message || null,
        notify_agent_on_complete: draft.notify_agent_on_complete,
        found_message: draft.found_message || null,
        not_found_message: draft.not_found_message || null,
        is_active: draft.is_active,
        display_order: draft.display_order,
        updated_at: new Date().toISOString(),
      };

      let flowId = draft.id;
      if (flowId) {
        const { error } = await supabase.from('booking_flows').update(payload).eq('id', flowId);
        if (error) throw error;
        await supabase.from('booking_flow_steps').delete().eq('flow_id', flowId);
      } else {
        const { data, error } = await supabase.from('booking_flows').insert(payload).select('id').single();
        if (error) throw error;
        flowId = data.id;
      }

      const stepRows = draft.steps.map((s) => ({
        flow_id: flowId,
        step_order: s.step_order,
        message_template: s.message_template,
        fields: s.fields.map((f) => ({ key: f.key, label: f.label.trim(), value_type: f.value_type || null, ...decodeQuoteField(f.quote_field) })),
      }));
      const { error: stepsError } = await supabase.from('booking_flow_steps').insert(stepRows);
      if (stepsError) throw stepsError;

      setEditing(false);
      setDraft(null);
      setSelectedId(flowId);
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(`儲存失敗：${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const { error } = await supabase.from('booking_flows').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      setSelectedId(null);
      setEditing(false);
      setDraft(null);
      await fetchAll();
    } catch (e: any) {
      setErrorMsg(`刪除失敗：${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const toggleActive = async (flow: Flow) => {
    const { error } = await supabase.from('booking_flows').update({ is_active: !flow.is_active }).eq('id', flow.id);
    if (error) {
      setErrorMsg(`更新失敗：${error.message}`);
      return;
    }
    setFlows((prev) => prev.map((f) => (f.id === flow.id ? { ...f, is_active: !f.is_active } : f)));
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  const current = editing ? draft : selected;
  const flowType = current?.flow_type ?? 'quote';
  const missing = current && flowType === 'quote' ? missingQuoteFields(current) : [];
  const quoteCapable = missing.length === 0;

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      <PageHeader
        icon={<MessageSquareText className="w-6 h-6 text-green-600" />}
        title="LINE 自定訊息流程"
        description="顧客傳訊息時，系統依關鍵字啟動對應流程，一步步問完資料後自動算價、回報價、收訂金。"
        action={<Button onClick={startNewFlow} icon={<Plus className="w-4 h-4" />}>新增流程</Button>}
      />

      {errorMsg && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-xl">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{errorMsg}</span>
          <button onClick={() => setErrorMsg('')} className="text-red-400 hover:text-red-600 text-xs">關閉</button>
        </div>
      )}

      {warningMsg && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-700 text-sm px-4 py-3 rounded-xl">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="flex-1">{warningMsg}</span>
          <button onClick={() => setWarningMsg('')} className="text-amber-500 hover:text-amber-700 text-xs">關閉</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4 items-start">
        {/* 左：流程清單 */}
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
          <p className="px-4 pt-4 pb-2 text-xs text-gray-400">流程清單（{flows.length}）</p>
          <div className="pb-2">
            {flows.length === 0 && selectedId !== NEW_FLOW_ID ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">還沒有任何流程</p>
            ) : (
              flows.map((flow) => {
                const active = selectedId === flow.id;
                return (
                  <button
                    key={flow.id}
                    onClick={() => selectFlow(flow.id)}
                    className={`w-full text-left px-4 py-3 border-l-2 transition-colors ${
                      active ? 'border-green-600 bg-green-50' : 'border-transparent hover:bg-gray-50'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${flow.is_active ? 'bg-green-500' : 'bg-gray-300'}`} />
                      <span className={`text-sm truncate ${active ? 'font-semibold text-green-800' : 'text-gray-700'}`}>{flow.name}</span>
                    </span>
                    <span className="block pl-3.5 mt-0.5 text-xs text-gray-400">
                      {flowTypeMeta(flow.flow_type).title} · {flow.steps.length} 步驟 · {flow.trigger_rules.length} 關鍵字{flow.is_active ? '' : ' · 已停用'}
                    </span>
                  </button>
                );
              })
            )}
            {selectedId === NEW_FLOW_ID && (
              <div className="px-4 py-3 border-l-2 border-green-600 bg-green-50">
                <span className="text-sm font-semibold text-green-800">{draft?.name || '（未命名流程）'}</span>
                <span className="block mt-0.5 text-xs text-green-600">新增中，尚未儲存</span>
              </div>
            )}
          </div>
        </div>

        {/* 右：流程內容 */}
        <div className="bg-white rounded-xl shadow-sm border">
          {!current ? (
            <EmptyState
              icon={<MessageSquareText className="w-12 h-12 text-gray-200" />}
              message="從左邊選一個流程來檢視內容，或點右上角「新增流程」"
            />
          ) : (
            <>
              {/* 標題列 */}
              <div className="flex flex-wrap justify-between items-start gap-3 px-6 py-4 border-b">
                <div className="min-w-0">
                  {editing ? (
                    <input
                      value={draft!.name}
                      onChange={(e) => patchDraft({ name: e.target.value })}
                      className="text-lg font-bold text-gray-800 px-2 py-1 -ml-2 border rounded-lg w-72 max-w-full"
                      placeholder="流程名稱，例如：報價訂房"
                      autoFocus
                    />
                  ) : (
                    <h3 className="text-lg font-bold text-gray-800 truncate">{current.name}</h3>
                  )}
                  <p className="text-xs mt-1 text-gray-400">
                    {editing ? (dirty ? '有未儲存的變更' : '編輯模式') : current.is_active ? '啟用中 · 檢視模式' : '已停用 · 檢視模式'}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {editing ? (
                    <>
                      <Button variant="secondary" onClick={cancelEdit}>取消</Button>
                      <Button onClick={handleSave} loading={saving}>{saving ? '儲存中...' : '儲存流程'}</Button>
                    </>
                  ) : (
                    <>
                      <Switch checked={current.is_active} onChange={() => toggleActive(current)} title={current.is_active ? '啟用中' : '已停用'} />
                      <Button variant="secondary" onClick={startEdit} icon={<Pencil className="w-4 h-4" />}>編輯</Button>
                      <button
                        onClick={() => setDeleteTarget(current)}
                        className="p-2 hover:bg-red-50 rounded-lg border border-transparent hover:border-red-200"
                        title="刪除流程"
                      >
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="px-6">
                {/* 流程類型：決定走完步驟後要做什麼，也決定下面會顯示哪些階段 */}
                <div className="py-4 border-b">
                  <p className="text-xs text-gray-500 mb-2">流程類型</p>
                  {editing ? (
                    <div className="grid sm:grid-cols-3 gap-2">
                      {FLOW_TYPE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => patchDraft({ flow_type: opt.value })}
                          className={`text-left p-3 rounded-lg border-2 transition-colors ${
                            draft!.flow_type === opt.value ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <span className={`flex items-center gap-2 text-sm font-medium ${
                            draft!.flow_type === opt.value ? 'text-green-800' : 'text-gray-700'
                          }`}>
                            {opt.icon}{opt.title}
                          </span>
                          <span className="block mt-1 text-xs text-gray-500">{opt.desc}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm text-gray-700">
                      <span className="text-green-600">{flowTypeMeta(flowType).icon}</span>
                      {flowTypeMeta(flowType).title}
                    </span>
                  )}
                </div>

                {/* ① 觸發條件 */}
                <Stage index={1} title="觸發條件" icon={<MessageCircleQuestion className="w-4 h-4" />}>
                  {editing ? (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        {draft!.trigger_rules.map((rule, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <select
                              value={rule.match}
                              onChange={(e) => updateKeyword(i, { match: e.target.value as KeywordMatch })}
                              className="w-32 px-2 py-1.5 border rounded-lg text-sm bg-white shrink-0"
                            >
                              <option value="exact">等於</option>
                              <option value="contains">相關</option>
                            </select>
                            <input
                              value={rule.keyword}
                              onChange={(e) => updateKeyword(i, { keyword: e.target.value })}
                              className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                              placeholder="關鍵字，例如：訂房"
                            />
                            <button
                              onClick={() => removeKeyword(i)}
                              className="p-1.5 text-red-500 hover:bg-red-50 rounded shrink-0"
                              title="刪除這個關鍵字"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button onClick={addKeyword} className="text-xs flex items-center gap-1 text-green-600 hover:text-green-700">
                        <Plus className="w-3.5 h-3.5" /> 新增關鍵字（不限數量）
                      </button>
                      <p className="text-xs text-gray-400">
                        「等於」＝顧客整句話就是這個關鍵字才觸發；「相關」＝句子裡出現這個關鍵字就觸發。
                        短關鍵字建議用「等於」，否則很容易被無關的句子誤觸。
                      </p>

                      <div className="pt-3 border-t">
                        <p className="text-xs text-gray-500 mb-2">顧客回覆的解讀方式</p>
                        <div className="grid sm:grid-cols-2 gap-2">
                          {([
                            { value: 'ai', icon: <Sparkles className="w-4 h-4" />, title: 'AI 理解', desc: '讀得懂「下週五」「我們四大兩小」這類說法，每則回覆會呼叫一次 AI。' },
                            { value: 'system', icon: <Cpu className="w-4 h-4" />, title: '系統自行比對', desc: '完全不呼叫 AI，省 token。只認得 7/30、2026-07-30、4 位、包棟這類標準寫法。' },
                          ] as const).map((opt) => (
                            <button
                              key={opt.value}
                              onClick={() => patchDraft({ reply_mode: opt.value })}
                              className={`text-left p-3 rounded-lg border-2 transition-colors ${
                                draft!.reply_mode === opt.value ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
                              }`}
                            >
                              <span className={`flex items-center gap-2 text-sm font-medium ${
                                draft!.reply_mode === opt.value ? 'text-green-800' : 'text-gray-700'
                              }`}>
                                {opt.icon}{opt.title}
                              </span>
                              <span className="block mt-1 text-xs text-gray-500">{opt.desc}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {current.trigger_rules.length === 0 ? (
                          <span className="text-sm text-gray-400 italic">尚未設定關鍵字，這個流程不會被觸發</span>
                        ) : (
                          current.trigger_rules.map((r, i) => <KeywordChip key={i} rule={r} />)
                        )}
                      </div>
                      <ReplyModeSummary mode={current.reply_mode} />
                    </div>
                  )}
                </Stage>

                {/* ② 收集客戶資訊 */}
                <Stage index={2} title="收集客戶資訊" icon={<MessageSquareText className="w-4 h-4" />}>
                  {editing ? (
                    <div className="space-y-3">
                      {draft!.steps.map((step, si) => (
                        <div key={si} className="border rounded-lg overflow-hidden">
                          <div className="flex items-center justify-between gap-2 bg-gray-50 px-4 py-2 border-b">
                            <span className="text-sm font-semibold text-gray-700">步驟 {step.step_order}</span>
                            {draft!.steps.length > 1 && (
                              <button onClick={() => removeStep(si)} className="p-1 text-red-500 hover:bg-red-100 rounded" title="刪除此步驟">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                          <div className="p-4 space-y-4">
                            <div>
                              <label className="block text-xs text-gray-500 mb-1">送給顧客的訊息</label>
                              <MessageTemplateEditor
                                value={step.message_template}
                                onChange={(v) => updateStep(si, { message_template: v })}
                                placeholders={variables}
                                rows={3}
                                placeholder="例如：請問您預計的入住與退房日期？"
                              />
                            </div>
                            <div>
                              <div className="flex justify-between items-center mb-2">
                                <label className="text-xs text-gray-500">要從顧客回覆取得的答案（最多 {MAX_FIELDS_PER_STEP} 個）</label>
                                <button
                                  onClick={() => addField(si)}
                                  disabled={step.fields.length >= MAX_FIELDS_PER_STEP}
                                  className="text-xs flex items-center gap-1 text-green-600 hover:text-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <Plus className="w-3.5 h-3.5" /> 新增答案欄位
                                </button>
                              </div>
                              <div className="space-y-2">
                                {step.fields.map((field, fi) => (
                                  <div key={field.key} className="flex items-center gap-2">
                                    <input
                                      value={field.label}
                                      onChange={(e) => updateField(si, fi, { label: e.target.value })}
                                      className="flex-1 px-2 py-1.5 border rounded text-sm"
                                      placeholder="答案名稱，例如：入住日期"
                                    />
                                    <select
                                      value={field.value_type}
                                      onChange={(e) => updateField(si, fi, { value_type: e.target.value })}
                                      title="限制顧客回覆必須符合的格式，不符合會請顧客重新輸入"
                                      className="w-32 px-2 py-1.5 border rounded text-sm bg-white shrink-0"
                                    >
                                      {VALUE_TYPE_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                      ))}
                                    </select>
                                    {/* 一般收集型沒有下游用途可選（純收集），不顯示用途下拉，讓畫面單純一點 */}
                                    {draft!.flow_type !== 'collect' && (
                                      <>
                                        <ArrowRight className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                                        <select
                                          value={field.quote_field}
                                          onChange={(e) => updateField(si, fi, { quote_field: e.target.value })}
                                          className="w-60 px-2 py-1.5 border rounded text-sm bg-white shrink-0"
                                        >
                                          {fieldPurposeOptions.map((o) => (
                                            <option key={o.value} value={o.value}>{o.label}</option>
                                          ))}
                                        </select>
                                      </>
                                    )}
                                    {step.fields.length > 1 && (
                                      <button onClick={() => removeField(si, fi)} className="p-1.5 text-red-500 hover:bg-red-50 rounded shrink-0">
                                        <Trash2 className="w-4 h-4" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                              {step.fields.some((f) => f.value_type === 'date') && (
                                <p className="text-xs text-gray-400 mt-1.5">
                                  格式：日期會接受 20260601、2026/06/01、115/06/01（民國）、1150601、0601、06/01 這幾種寫法，沒寫年份就當作今年，統一轉成 YYYY-MM-DD 存起來。
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                      <button
                        onClick={addStep}
                        disabled={draft!.steps.length >= MAX_STEPS}
                        className="w-full flex items-center justify-center gap-2 border-2 border-dashed rounded-lg py-3 text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Plus className="w-4 h-4" /> 新增步驟（{draft!.steps.length}/{MAX_STEPS}）
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {current.steps.length === 0 ? (
                        <p className="text-sm text-gray-400 italic">尚未設定任何步驟</p>
                      ) : (
                        current.steps.map((step) => (
                          <div key={step.step_order} className="bg-gray-50 rounded-lg p-3">
                            <p className="text-xs text-gray-400 mb-1.5">步驟 {step.step_order} · 送出訊息</p>
                            <VariableText value={step.message_template} knownVariables={variables} />
                            {step.fields.length > 0 && (
                              <p className="text-xs text-gray-500 mt-2 pt-2 border-t border-gray-200">
                                要取得：
                                {step.fields.map((f, i) => (
                                  <span key={f.key}>
                                    {i > 0 && ' · '}
                                    {f.label || '（未命名）'}
                                    {f.quote_field && (
                                      <span className="text-gray-400">
                                        （{f.quote_field.startsWith('room_count:') ? '決定開房' : f.quote_field === 'order_number' ? '查詢依據' : '算價'}）
                                      </span>
                                    )}
                                    {f.value_type && (
                                      <span className="text-gray-400">
                                        （{VALUE_TYPE_OPTIONS.find((o) => o.value === f.value_type)?.label}）
                                      </span>
                                    )}
                                  </span>
                                ))}
                              </p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </Stage>

                {flowType === 'quote' ? (
                  <>
                    {/* ③ 系統試算 */}
                    <Stage index={3} title="系統試算" icon={<Calculator className="w-4 h-4" />} muted={!quoteCapable}>
                      <div className="space-y-3">
                        {!quoteCapable && (
                          <div className="rounded-lg p-3 text-xs leading-6 bg-amber-50 text-amber-800 border border-amber-200">
                            <strong className="font-semibold">這個流程還算不出價格。</strong>
                            缺少 {missing.join('、')}，收集完成後會直接轉真人客服，下面的報價確認與付款確認不會送出。
                            若要自動報價，請在步驟裡把對應答案的下拉選單指到這些算價欄位。
                          </div>
                        )}
                        <div className="rounded-lg p-3 text-xs leading-6 bg-gray-50 text-gray-600">
                          算價本身自動執行、無法在這裡編輯，系統依「房型與報價」頁的設定算出金額。
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">
                            算價欄位沒收集齊、或算不出價時的回覆
                          </label>
                          {editing ? (
                            <MessageTemplateEditor
                              value={draft!.incomplete_message}
                              onChange={(v) => patchDraft({ incomplete_message: v })}
                              placeholders={variables}
                              rows={4}
                              placeholder="感謝您提供的資訊！我們已經收到，將由客服人員盡快為您確認詳細報價，謝謝您的耐心等候 🙏"
                            />
                          ) : (
                            <div className="bg-gray-50 rounded-lg p-3">
                              <VariableText value={current.incomplete_message || '（未設定，會用內建預設文字）'} knownVariables={variables} />
                            </div>
                          )}
                        </div>
                      </div>
                    </Stage>

                    {/* ④ 報價確認 */}
                    <Stage index={4} title="報價確認" icon={<CheckCircle2 className="w-4 h-4" />} muted={!quoteCapable}>
                      {editing ? (
                        <>
                          <p className="text-xs text-gray-400 mb-2">算完金額後送出，接著等顧客回覆「是」繼續、「否」取消。</p>
                          <MessageTemplateEditor
                            value={draft!.quote_message}
                            onChange={(v) => patchDraft({ quote_message: v })}
                            placeholders={variables}
                            rows={8}
                          />
                        </>
                      ) : (
                        <div className="bg-gray-50 rounded-lg p-3">
                          <VariableText value={current.quote_message} knownVariables={variables} />
                          <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-gray-200">送出後等顧客回覆「是」繼續、「否」取消。</p>
                        </div>
                      )}
                    </Stage>

                    {/* ⑤ 付款確認 */}
                    <Stage index={5} title="付款確認" icon={<Wallet className="w-4 h-4" />} muted={!quoteCapable}>
                      {editing ? (
                        <>
                          <p className="text-xs text-gray-400 mb-2">
                            顧客回「是」之後送出，同時把訂單建成「待預定」並鎖房。
                            [訂金] 會在這一刻重新讀一次訂房紀錄；[匯款日時間] 由系統自動算（18:00 前帶今天 21:00，之後帶明天 21:00）。
                          </p>
                          <MessageTemplateEditor
                            value={draft!.confirm_message}
                            onChange={(v) => patchDraft({ confirm_message: v })}
                            placeholders={variables}
                            rows={10}
                          />
                        </>
                      ) : (
                        <div className="bg-gray-50 rounded-lg p-3">
                          <VariableText value={current.confirm_message} knownVariables={variables} />
                          <p className="flex items-center gap-1.5 text-xs text-gray-400 mt-2 pt-2 border-t border-gray-200">
                            <UserRound className="w-3.5 h-3.5" />
                            訂單建立為「待預定」，實際入帳目前由人工在「訂單管理」核對後改成「已預定」。
                          </p>
                        </div>
                      )}
                    </Stage>
                  </>
                ) : flowType === 'query' ? (
                  /* ③ 查詢結果（查詢訂單型專用，取代系統試算/報價確認/付款確認） */
                  <Stage index={3} title="查詢結果" icon={<Search className="w-4 h-4" />}>
                    <div className="space-y-4">
                      <p className="text-xs text-gray-400">
                        走完步驟後，系統用步驟裡標記「查詢依據：訂單編號」的答案去查訂單，
                        而且只認顧客自己 LINE 帳號底下的訂單——不會查到別人的訂房資料。
                      </p>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">查到訂單時的回覆</label>
                        {editing ? (
                          <MessageTemplateEditor
                            value={draft!.found_message}
                            onChange={(v) => patchDraft({ found_message: v })}
                            placeholders={variables}
                            rows={5}
                            placeholder={'您的訂單狀態：[訂單狀態]\n入住日期：[入住日期]\n退房日期：[退房日期]\n總金額：[總金額]'}
                          />
                        ) : (
                          <div className="bg-gray-50 rounded-lg p-3">
                            <VariableText value={current.found_message || '（未設定，會用內建預設文字）'} knownVariables={variables} />
                          </div>
                        )}
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">查無訂單時的回覆</label>
                        {editing ? (
                          <MessageTemplateEditor
                            value={draft!.not_found_message}
                            onChange={(v) => patchDraft({ not_found_message: v })}
                            placeholders={variables}
                            rows={3}
                            placeholder="不好意思，查無這筆訂單資料，請確認訂單編號是否正確，或點選「真人客服」協助查詢。"
                          />
                        ) : (
                          <div className="bg-gray-50 rounded-lg p-3">
                            <VariableText value={current.not_found_message || '（未設定，會用內建預設文字）'} knownVariables={variables} />
                          </div>
                        )}
                      </div>
                    </div>
                  </Stage>
                ) : (
                  /* ③ 完成訊息（一般收集型專用，取代系統試算/報價確認/付款確認） */
                  <Stage index={3} title="完成訊息" icon={<CheckCircle2 className="w-4 h-4" />}>
                    {editing ? (
                      <>
                        <p className="text-xs text-gray-400 mb-2">走完最後一步後直接送出，流程結束。不算價、不建立訂單紀錄。</p>
                        <MessageTemplateEditor
                          value={draft!.completion_message}
                          onChange={(v) => patchDraft({ completion_message: v })}
                          placeholders={variables}
                          rows={6}
                          placeholder="感謝您提供的資訊，我們已經收到了！"
                        />
                        <label className="flex items-center gap-2 text-sm text-gray-700 mt-3">
                          <input
                            type="checkbox"
                            checked={draft!.notify_agent_on_complete}
                            onChange={(e) => patchDraft({ notify_agent_on_complete: e.target.checked })}
                          />
                          完成後推播通知真人客服（LINE 串接設定裡的客服 LINE IDs）
                        </label>
                      </>
                    ) : (
                      <div className="bg-gray-50 rounded-lg p-3">
                        <VariableText value={current.completion_message || '（未設定，會用內建預設文字）'} knownVariables={variables} />
                        <p className="text-xs text-gray-400 mt-2 pt-2 border-t border-gray-200">
                          {current.notify_agent_on_complete ? '完成後會通知真人客服' : '完成後不會通知真人客服'}
                        </p>
                      </div>
                    )}
                  </Stage>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除流程"
        message={`確定要刪除流程「${deleteTarget?.name}」嗎？這個流程的所有步驟、關鍵字與確認訊息都會一起刪除，無法復原。`}
        confirmLabel="刪除"
        danger
        loading={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!pendingAction}
        title="放棄未儲存的變更？"
        message="這個流程有還沒儲存的修改，離開的話這些變更會消失。"
        confirmLabel="放棄變更"
        cancelLabel="繼續編輯"
        danger
        onConfirm={() => {
          const action = pendingAction;
          setPendingAction(null);
          setEditing(false);
          setDraft(null);
          action?.();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

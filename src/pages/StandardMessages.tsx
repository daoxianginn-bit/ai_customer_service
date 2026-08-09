import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Save, MessageSquareText, Plus, Trash2, Pencil, GripVertical } from 'lucide-react';
import CollapsibleSection from '../components/CollapsibleSection';
import MessageTemplateEditor from '../components/MessageTemplateEditor';
import { PageHeader, Button, Modal, ConfirmDialog, Switch } from '../components/ui';

const QUOTE_MESSAGE_PLACEHOLDERS = ['入住日期', '退房日期', '人數', '是否包棟', '總金額'];
const CONFIRM_MESSAGE_PLACEHOLDERS = ['姓名', '入住日期', '退房日期', '是否包棟', '人數', '大人小孩', '總金額', '訂金', '匯款日時間'];

const QUOTE_FIELD_OPTIONS = [
  { value: '', label: '無（純收集資訊，不影響算價）' },
  { value: 'checkin_date', label: '入住日期' },
  { value: 'checkout_date', label: '退房日期' },
  { value: 'headcount', label: '入住人數' },
  { value: 'whole_house', label: '是否包棟' },
];

const MAX_STEPS = 5;
const MAX_FIELDS_PER_STEP = 10;

function newId(): string {
  return crypto.randomUUID();
}

type FlowField = { key: string; label: string; quote_field: string };
type FlowStep = { id?: string; step_order: number; message_template: string; fields: FlowField[] };
type Flow = {
  id: string;
  name: string;
  trigger_keywords: string;
  is_active: boolean;
  display_order: number;
  steps: FlowStep[];
};

const emptyFlow = (): Flow => ({
  id: '',
  name: '',
  trigger_keywords: '',
  is_active: true,
  display_order: 0,
  steps: [{ step_order: 1, message_template: '', fields: [{ key: newId(), label: '', quote_field: '' }] }],
});

export default function StandardMessages() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  const [quoteMessage, setQuoteMessage] = useState('');
  const [confirmMessage, setConfirmMessage] = useState('');

  const [flows, setFlows] = useState<Flow[]>([]);
  const [showFlowForm, setShowFlowForm] = useState(false);
  const [flowForm, setFlowForm] = useState<Flow>(emptyFlow());
  const [savingFlow, setSavingFlow] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Flow | null>(null);
  const [deletingFlow, setDeletingFlow] = useState(false);

  useEffect(() => {
    fetchSettings();
    fetchFlows();
  }, []);

  const fetchSettings = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('settings')
      .select('id, booking_quote_message, booking_confirm_message')
      .single();
    setSettingsId(data?.id || null);
    setQuoteMessage(data?.booking_quote_message ?? '');
    setConfirmMessage(data?.booking_confirm_message ?? '');
    setLoading(false);
  };

  const fetchFlows = async () => {
    const { data: flowRows } = await supabase.from('booking_flows').select('*').order('display_order');
    const { data: stepRows } = await supabase.from('booking_flow_steps').select('*').order('step_order');
    const flowsList: Flow[] = (flowRows || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      trigger_keywords: f.trigger_keywords,
      is_active: f.is_active,
      display_order: f.display_order,
      steps: (stepRows || [])
        .filter((s: any) => s.flow_id === f.id)
        .map((s: any) => ({ id: s.id, step_order: s.step_order, message_template: s.message_template, fields: s.fields || [] })),
    }));
    setFlows(flowsList);
  };

  const handleSaveSettings = async () => {
    if (!settingsId) return;
    setSaving(true);
    try {
      await supabase
        .from('settings')
        .update({
          booking_quote_message: quoteMessage,
          booking_confirm_message: confirmMessage,
        })
        .eq('id', settingsId);
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const openNewFlow = () => {
    setFlowForm({ ...emptyFlow(), display_order: flows.length });
    setShowFlowForm(true);
  };

  const openEditFlow = (flow: Flow) => {
    setFlowForm(JSON.parse(JSON.stringify(flow)));
    setShowFlowForm(true);
  };

  const addStep = () => {
    if (flowForm.steps.length >= MAX_STEPS) return;
    setFlowForm({
      ...flowForm,
      steps: [...flowForm.steps, { step_order: flowForm.steps.length + 1, message_template: '', fields: [{ key: newId(), label: '', quote_field: '' }] }],
    });
  };

  const removeStep = (index: number) => {
    const steps = flowForm.steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_order: i + 1 }));
    setFlowForm({ ...flowForm, steps });
  };

  const updateStepMessage = (index: number, value: string) => {
    const steps = [...flowForm.steps];
    steps[index] = { ...steps[index], message_template: value };
    setFlowForm({ ...flowForm, steps });
  };

  const addField = (stepIndex: number) => {
    const steps = [...flowForm.steps];
    if (steps[stepIndex].fields.length >= MAX_FIELDS_PER_STEP) return;
    steps[stepIndex] = { ...steps[stepIndex], fields: [...steps[stepIndex].fields, { key: newId(), label: '', quote_field: '' }] };
    setFlowForm({ ...flowForm, steps });
  };

  const removeField = (stepIndex: number, fieldIndex: number) => {
    const steps = [...flowForm.steps];
    steps[stepIndex] = { ...steps[stepIndex], fields: steps[stepIndex].fields.filter((_, i) => i !== fieldIndex) };
    setFlowForm({ ...flowForm, steps });
  };

  const updateField = (stepIndex: number, fieldIndex: number, patch: Partial<FlowField>) => {
    const steps = [...flowForm.steps];
    const fields = [...steps[stepIndex].fields];
    fields[fieldIndex] = { ...fields[fieldIndex], ...patch };
    steps[stepIndex] = { ...steps[stepIndex], fields };
    setFlowForm({ ...flowForm, steps });
  };

  const handleSaveFlow = async () => {
    if (!flowForm.name.trim()) {
      alert('請輸入流程名稱');
      return;
    }
    if (!flowForm.trigger_keywords.trim()) {
      alert('請輸入至少一個觸發關鍵字');
      return;
    }
    for (const step of flowForm.steps) {
      if (!step.message_template.trim()) {
        alert(`第 ${step.step_order} 步驟的訊息內容不能是空的`);
        return;
      }
      if (step.fields.some((f) => !f.label.trim())) {
        alert(`第 ${step.step_order} 步驟有欄位沒有填標籤`);
        return;
      }
    }

    setSavingFlow(true);
    try {
      let flowId = flowForm.id;
      const flowPayload = {
        name: flowForm.name,
        trigger_keywords: flowForm.trigger_keywords,
        is_active: flowForm.is_active,
        display_order: flowForm.display_order,
        updated_at: new Date().toISOString(),
      };

      if (flowId) {
        const { error } = await supabase.from('booking_flows').update(flowPayload).eq('id', flowId);
        if (error) throw error;
        await supabase.from('booking_flow_steps').delete().eq('flow_id', flowId);
      } else {
        const { data, error } = await supabase.from('booking_flows').insert(flowPayload).select('id').single();
        if (error) throw error;
        flowId = data.id;
      }

      const stepRows = flowForm.steps.map((s) => ({
        flow_id: flowId,
        step_order: s.step_order,
        message_template: s.message_template,
        fields: s.fields.map((f) => ({ key: f.key, label: f.label, quote_field: f.quote_field || null })),
      }));
      const { error: stepsError } = await supabase.from('booking_flow_steps').insert(stepRows);
      if (stepsError) throw stepsError;

      setShowFlowForm(false);
      fetchFlows();
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSavingFlow(false);
    }
  };

  const confirmDeleteFlow = async () => {
    if (!deleteTarget) return;
    setDeletingFlow(true);
    try {
      const { error } = await supabase.from('booking_flows').delete().eq('id', deleteTarget.id);
      if (error) throw error;
      setDeleteTarget(null);
      fetchFlows();
    } catch (err: any) {
      alert(`刪除失敗：${err.message}`);
    } finally {
      setDeletingFlow(false);
    }
  };

  const toggleFlowActive = async (flow: Flow) => {
    const { error } = await supabase.from('booking_flows').update({ is_active: !flow.is_active }).eq('id', flow.id);
    if (error) {
      alert(`更新失敗：${error.message}`);
      return;
    }
    fetchFlows();
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        icon={<MessageSquareText className="w-6 h-6 text-green-600" />}
        title="LINE 自定訊息流程"
        description="管理系統自動發送的標準訊息：LINE 訂房對話的分步驟流程，以及報價確認／付款確認罐頭訊息。"
      />

      {/* 動態流程管理 */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b flex justify-between items-start gap-4">
          <div>
            <h3 className="text-lg font-bold text-gray-800">流程管理</h3>
            <p className="text-sm text-gray-500 mt-1">
              每組流程有自己的觸發關鍵字，最多 {MAX_STEPS} 個步驟。每個步驟送出一段自訂訊息給顧客，等顧客回覆後擷取最多 {MAX_FIELDS_PER_STEP} 個答案，
              全部步驟做完後，若已收集齊「入住日期／退房日期／入住人數／是否包棟」，就會自動算價並進入確認流程；沒收集齊則轉真人客服處理。
            </p>
          </div>
          <Button onClick={openNewFlow} icon={<Plus className="w-4 h-4" />} className="whitespace-nowrap">新增流程</Button>
        </div>

        <div className="divide-y divide-gray-100">
          {flows.length === 0 ? (
            <p className="p-10 text-center text-gray-400">尚未設定任何流程，點右上角「新增流程」開始</p>
          ) : (
            flows.map((flow) => (
              <div key={flow.id} className="p-6 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-800">{flow.name}</p>
                    <span className="text-xs text-gray-400">{flow.steps.length} 個步驟</span>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">觸發關鍵字：{flow.trigger_keywords}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={flow.is_active} onChange={() => toggleFlowActive(flow)} title={flow.is_active ? '啟用中' : '已停用'} />
                  <button onClick={() => openEditFlow(flow)} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                  <button onClick={() => setDeleteTarget(flow)} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <Modal
        open={showFlowForm}
        title={flowForm.id ? '編輯流程' : '新增流程'}
        onClose={() => setShowFlowForm(false)}
        maxWidth="max-w-3xl"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowFlowForm(false)}>取消</Button>
            <Button onClick={handleSaveFlow} loading={savingFlow}>{savingFlow ? '儲存中...' : '儲存流程'}</Button>
          </>
        }
      >
              <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">流程名稱</label>
                  <input value={flowForm.name} onChange={(e) => setFlowForm({ ...flowForm, name: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="例如：一般訂房詢問" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">觸發關鍵字（逗號分隔）</label>
                  <input value={flowForm.trigger_keywords} onChange={(e) => setFlowForm({ ...flowForm, trigger_keywords: e.target.value })} className="w-full px-3 py-2 border rounded-lg" placeholder="我要訂房,訂房" />
                </div>
              </div>

              <div className="space-y-4">
                {flowForm.steps.map((step, stepIndex) => (
                  <div key={stepIndex} className="border rounded-lg overflow-hidden">
                    <div className="flex items-center justify-between gap-2 bg-gray-50 px-4 py-2 border-b">
                      <span className="flex items-center gap-2 text-sm font-semibold text-gray-700">
                        <GripVertical className="w-4 h-4 text-gray-300" />
                        步驟 {step.step_order}
                      </span>
                      {flowForm.steps.length > 1 && (
                        <button onClick={() => removeStep(stepIndex)} className="p-1 text-red-500 hover:bg-red-50 rounded" title="刪除此步驟">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <div className="p-4 space-y-3">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">送給顧客的訊息（AI 回答樣版）</label>
                        <MessageTemplateEditor value={step.message_template} onChange={(v) => updateStepMessage(stepIndex, v)} placeholders={[]} rows={3} placeholder="例如：請問您預計入住與退房日期？" />
                      </div>
                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <label className="text-xs text-gray-500">預期顧客回答的欄位（最多 {MAX_FIELDS_PER_STEP} 個）</label>
                          <button onClick={() => addField(stepIndex)} disabled={step.fields.length >= MAX_FIELDS_PER_STEP} className="text-xs flex items-center gap-1 text-green-600 hover:text-green-700 disabled:opacity-40 disabled:cursor-not-allowed">
                            <Plus className="w-3.5 h-3.5" /> 新增欄位
                          </button>
                        </div>
                        <div className="space-y-2">
                          {step.fields.map((field, fieldIndex) => (
                            <div key={field.key} className="flex items-center gap-2">
                              <input
                                value={field.label}
                                onChange={(e) => updateField(stepIndex, fieldIndex, { label: e.target.value })}
                                className="flex-1 px-2 py-1.5 border rounded text-sm"
                                placeholder="欄位名稱，例如：入住日期"
                              />
                              <select
                                value={field.quote_field}
                                onChange={(e) => updateField(stepIndex, fieldIndex, { quote_field: e.target.value })}
                                className="w-56 px-2 py-1.5 border rounded text-sm bg-white"
                              >
                                {QUOTE_FIELD_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                              {step.fields.length > 1 && (
                                <button onClick={() => removeField(stepIndex, fieldIndex)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={addStep}
                disabled={flowForm.steps.length >= MAX_STEPS}
                className="w-full flex items-center justify-center gap-2 border-2 border-dashed rounded-lg py-3 text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" /> 新增步驟（{flowForm.steps.length}/{MAX_STEPS}）
              </button>
            </div>
      </Modal>

      <div className="bg-white p-6 rounded-xl shadow-sm border flex justify-end">
        <Button onClick={handleSaveSettings} loading={saving} icon={<Save className="w-4 h-4" />} className="whitespace-nowrap">
          {saving ? '儲存中...' : '儲存罐頭訊息'}
        </Button>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="刪除流程"
        message={`確定要刪除流程「${deleteTarget?.name}」嗎？`}
        confirmLabel="刪除"
        danger
        loading={deletingFlow}
        onConfirm={confirmDeleteFlow}
        onCancel={() => setDeleteTarget(null)}
      />

      <CollapsibleSection
        title="報價確認／付款確認罐頭訊息"
        icon={<MessageSquareText className="w-5 h-5 text-orange-600" />}
        description="流程走完、成功算出價格後才會用到這兩段訊息，方括號 [欄位名稱] 是合併欄位。"
        defaultOpen={true}
      >
        <div className="p-6 border-b">
          <p className="text-sm font-medium text-gray-700 mb-1">① 報價確認（算完金額後送出）</p>
          <p className="text-xs text-gray-400 mb-2">送出後會等顧客回覆「是」或「否」。</p>
          <MessageTemplateEditor value={quoteMessage} onChange={setQuoteMessage} placeholders={QUOTE_MESSAGE_PLACEHOLDERS} rows={10} />
        </div>

        <div className="p-6">
          <p className="text-sm font-medium text-gray-700 mb-1">② 付款確認（顧客回「是」之後）</p>
          <p className="text-xs text-gray-400 mb-2">
            [訂金] 讀自訂房紀錄（顧客回「是」的當下重新讀一次，讓您有時間先填好或用其他方式算好）；
            [匯款日時間] 由系統自動算：目前時間 18:00 前帶入今天 21:00，18:00（含）以後帶入明天 21:00。
          </p>
          <MessageTemplateEditor value={confirmMessage} onChange={setConfirmMessage} placeholders={CONFIRM_MESSAGE_PLACEHOLDERS} rows={14} />
        </div>
      </CollapsibleSection>
    </div>
  );
}

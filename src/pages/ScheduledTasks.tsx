import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Clock, Plus, Pencil, Trash2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { PageHeader, Button, Modal, ConfirmDialog, Switch, EmptyState } from '../components/ui';
import { Recurrence, ScheduleConfig, computeNextRunAt, describeSchedule } from '../lib/scheduleRecurrence';

// 排程類型清單：之後新增排程類型（定時寄信、到期通知、LINE 分眾發送...）只需要在這裡多加一筆，
// 不用改頁面其他邏輯或資料表結構。目前只有一種。
const TASK_TYPE_OPTIONS = [
  {
    value: 'cancel_unpaid_bookings',
    label: '訂單自動取消',
    description: '取消狀態為「待預定」、且已經超過匯款期限（[匯款日時間]）的訂單。不會另外通知顧客，但會推播給真人客服帳號。',
  },
];

const RECURRENCE_OPTIONS: { value: Recurrence; label: string }[] = [
  { value: 'once', label: '單次' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每週' },
  { value: 'monthly', label: '每月' },
];

const WEEKDAY_OPTIONS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

interface ScheduledTask {
  id: string;
  name: string;
  task_type: string;
  recurrence: Recurrence;
  run_at_time: string;
  run_at_date: string | null;
  weekday: number | null;
  day_of_month: number | null;
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
};

const emptyForm = (): TaskForm => ({
  name: '',
  task_type: TASK_TYPE_OPTIONS[0].value,
  recurrence: 'daily',
  run_at_time: '09:00',
  run_at_date: '',
  weekday: 1,
  day_of_month: 1,
});

function formToConfig(form: TaskForm): ScheduleConfig {
  return {
    recurrence: form.recurrence,
    runAtTime: form.run_at_time,
    runAtDate: form.run_at_date || null,
    weekday: form.weekday,
    dayOfMonth: form.day_of_month,
  };
}

function taskTypeLabel(taskType: string): string {
  return TASK_TYPE_OPTIONS.find((t) => t.value === taskType)?.label || taskType;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function ScheduledTasks() {
  const [rows, setRows] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaskForm>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchRows();
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
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) return setFormError('請輸入排程名稱');
    if (form.recurrence === 'once' && !form.run_at_date) return setFormError('請選擇執行日期');

    const nextRunAt = computeNextRunAt(formToConfig(form), Date.now());
    if (!nextRunAt) return setFormError('算不出下一次執行時間，單次排程的日期時間必須在現在之後');

    setSaving(true);
    setFormError('');
    try {
      const payload = {
        name: form.name.trim(),
        task_type: form.task_type,
        config: {},
        recurrence: form.recurrence,
        run_at_time: form.run_at_time,
        run_at_date: form.recurrence === 'once' ? form.run_at_date : null,
        weekday: form.recurrence === 'weekly' ? form.weekday : null,
        day_of_month: form.recurrence === 'monthly' ? form.day_of_month : null,
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
        { recurrence: row.recurrence, runAtTime: row.run_at_time, runAtDate: row.run_at_date, weekday: row.weekday, dayOfMonth: row.day_of_month },
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

  const previewConfig = formToConfig(form);
  const previewNextRun = computeNextRunAt(previewConfig, Date.now());

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-4">
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

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Clock className="w-12 h-12 text-gray-200" />} message="還沒有任何排程，點右上角「新增排程」開始" />
        ) : (
          <div className="divide-y divide-gray-100">
            {rows.map((row) => (
              <div key={row.id} className="p-5 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-medium text-gray-800">{row.name}</p>
                    <span className="text-xs bg-gray-100 text-gray-600 rounded-full px-2 py-0.5">{taskTypeLabel(row.task_type)}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {describeSchedule({ recurrence: row.recurrence, runAtTime: row.run_at_time, runAtDate: row.run_at_date, weekday: row.weekday, dayOfMonth: row.day_of_month })}
                    {row.is_active && row.next_run_at && <span className="text-gray-400"> · 下次執行約 {formatDateTime(row.next_run_at)}</span>}
                  </p>
                  {row.last_run_at && (
                    <p className="flex items-center gap-1.5 text-xs mt-2">
                      {row.last_run_status === 'success' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      )}
                      <span className="text-gray-400">上次執行 {formatDateTime(row.last_run_at)}：</span>
                      <span className="text-gray-600">{row.last_run_summary}</span>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={row.is_active} onChange={() => toggleActive(row)} title={row.is_active ? '啟用中' : '已停用'} />
                  <button onClick={() => openEdit(row)} className="p-2 hover:bg-gray-100 rounded-lg" title="編輯"><Pencil className="w-4 h-4 text-gray-500" /></button>
                  <button onClick={() => setDeleteTarget(row)} className="p-2 hover:bg-red-50 rounded-lg" title="刪除"><Trash2 className="w-4 h-4 text-red-500" /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

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
          <select value={form.task_type} onChange={(e) => setForm({ ...form, task_type: e.target.value })} className="w-full px-3 py-2 border rounded-lg bg-white">
            {TASK_TYPE_OPTIONS.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
          </select>
          <p className="text-xs text-gray-400 mt-1">{TASK_TYPE_OPTIONS.find((t) => t.value === form.task_type)?.description}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">頻率</label>
            <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value as Recurrence })} className="w-full px-3 py-2 border rounded-lg bg-white">
              {RECURRENCE_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">時間</label>
            <input type="time" value={form.run_at_time} onChange={(e) => setForm({ ...form, run_at_time: e.target.value })} className="w-full px-3 py-2 border rounded-lg" />
          </div>
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

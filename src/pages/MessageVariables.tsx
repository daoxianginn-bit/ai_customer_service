import { useCallback, useEffect, useState } from 'react';
import { Button, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { supabase } from '../lib/supabase';
import { Variable, Plus, Pencil, Trash2 } from 'lucide-react';
import {
  PageHeaderMui, FilterPanel, DataTableMui, FormPanel, ResultState,
  useConfirm, useAbortableQuery, useDirtyForm, type Column,
} from '../components/ui-mui';
import { SOURCE_OPTIONS, VariableSource } from '../lib/messageVariables';

// 這一頁是遷移到新版 MUI 元件庫的參考實作：四層式架構（頁首 → 篩選卡 → 資料表格 → 表單）
// 與 useConfirm／useDirtyForm／useAbortableQuery 的用法都在這裡，其他頁面照這個骨架搬。

interface VariableRow {
  id: string;
  variable_name: string;
  source: VariableSource;
  field_key: string;
  display_order: number;
}

interface FormValue {
  variable_name: string;
  source: VariableSource;
  field_key: string;
}

const EMPTY_FORM: FormValue = { variable_name: '', source: 'booking', field_key: '' };

function sourceLabel(source: VariableSource): string {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.label || source;
}

function fieldLabel(source: VariableSource, fieldKey: string): string {
  return SOURCE_OPTIONS.find((s) => s.value === source)?.fields.find((f) => f.value === fieldKey)?.label || fieldKey;
}

export default function MessageVariables() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();

  const { data: rows = [], loading, error, run } = useAbortableQuery<VariableRow[]>([]);

  const [keyword, setKeyword] = useState('');
  const [sourceFilter, setSourceFilter] = useState<VariableSource | ''>('');
  // 送出查詢當下的條件快照。直接拿輸入框的值去篩會變成「邊打字邊篩」，
  // 跟篩選卡有「查詢」按鈕的預期不符。
  const [applied, setApplied] = useState({ keyword: '', source: '' as VariableSource | '' });

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<VariableRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ name?: string; field?: string }>({});
  const form = useDirtyForm<FormValue>(EMPTY_FORM);

  const fetchRows = useCallback(() => {
    run(async () => {
      const { data, error } = await supabase.from('message_variables').select('*').order('display_order');
      if (error) throw error;
      return (data || []) as VariableRow[];
    });
  }, [run]);

  useEffect(() => { fetchRows(); }, [fetchRows]);

  const visibleRows = rows.filter((r) => {
    if (applied.source && r.source !== applied.source) return false;
    if (applied.keyword && !r.variable_name.toLowerCase().includes(applied.keyword.toLowerCase())) return false;
    return true;
  });

  const currentSourceFields = SOURCE_OPTIONS.find((s) => s.value === form.value.source)?.fields || [];

  const openNew = () => {
    setEditing(null);
    setFieldError({});
    form.reset({ ...EMPTY_FORM, field_key: SOURCE_OPTIONS[0].fields[0]?.value || '' });
    setShowForm(true);
  };

  const openEdit = (row: VariableRow) => {
    setEditing(row);
    setFieldError({});
    form.reset({ variable_name: row.variable_name, source: row.source, field_key: row.field_key });
    setShowForm(true);
  };

  // 換來源時原本的欄位代碼多半不屬於新來源，直接帶到新來源的第一個欄位，
  // 避免留下一個對不到選項的值（下拉會顯示空白）。
  const handleSourceChange = (source: VariableSource) => {
    const fields = SOURCE_OPTIONS.find((s) => s.value === source)?.fields || [];
    form.setValue({ ...form.value, source, field_key: fields[0]?.value || '' });
  };

  const handleSave = async () => {
    const name = form.value.variable_name.trim();
    const errs: typeof fieldError = {};
    if (!name) errs.name = '請輸入變數名稱';
    if (!form.value.field_key) errs.field = '請選擇欄位';
    setFieldError(errs);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      const payload = { variable_name: name, source: form.value.source, field_key: form.value.field_key };
      if (editing) {
        const { error } = await supabase
          .from('message_variables')
          .update({ ...payload, updated_at: new Date().toISOString() })
          .eq('id', editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('message_variables')
          .insert({ ...payload, display_order: rows.length });
        if (error) throw error;
      }
      form.commit();
      setShowForm(false);
      enqueueSnackbar(editing ? '變數已更新' : '變數已新增', { variant: 'success' });
      fetchRows();
    } catch (e: any) {
      const duplicated = e.code === '23505' || e.message?.includes('duplicate');
      if (duplicated) setFieldError({ name: '這個變數名稱已經存在，請換一個名稱' });
      else enqueueSnackbar(`儲存失敗：${e.message}`, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (row: VariableRow) => {
    const ok = await confirm({
      title: `確定要刪除變數「[${row.variable_name}]」嗎？`,
      message: `刪除後，還在用這個變數的訊息範本裡，[${row.variable_name}] 會直接顯示原始文字，不會再被替換成實際資料。`,
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('message_variables').delete().eq('id', row.id);
    if (error) {
      enqueueSnackbar(`刪除失敗：${error.message}`, { variant: 'error' });
      return;
    }
    enqueueSnackbar('變數已刪除', { variant: 'success' });
    fetchRows();
  };

  const columns: Column<VariableRow>[] = [
    {
      key: 'variable_name',
      header: '變數名稱',
      nowrap: true,
      render: (r) => <Typography variant="body2" fontFamily="monospace">[{r.variable_name}]</Typography>,
    },
    { key: 'source', header: '來源', render: (r) => sourceLabel(r.source) },
    { key: 'field_key', header: '欄位', render: (r) => fieldLabel(r.source, r.field_key) },
  ];

  if (error) {
    return (
      <Stack spacing={2}>
        <PageHeaderMui icon={<Variable size={22} />} title="訊息變數資料維護" />
        <ResultState status={500} description={`查詢失敗：${error.message}`} onRetry={fetchRows} backTo={false} />
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      <PageHeaderMui
        icon={<Variable size={22} />}
        title="訊息變數資料維護"
        description="管理「LINE 自定訊息流程」罐頭訊息與「客製訊息發送」範本裡可用的 [變數名稱]，決定每個變數要從訂單、客戶還是民宿設定的哪個欄位取值。"
        action={<Button variant="contained" startIcon={<Plus size={16} />} onClick={openNew}>新增變數</Button>}
      />

      <FilterPanel
        onSearch={() => setApplied({ keyword, source: sourceFilter })}
        onReset={() => { setKeyword(''); setSourceFilter(''); setApplied({ keyword: '', source: '' }); }}
        loading={loading}
      >
        <TextField
          label="變數名稱"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="輸入關鍵字"
          sx={{ width: 220 }}
        />
        <TextField
          select
          label="來源"
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as VariableSource | '')}
          sx={{ width: 160 }}
        >
          <MenuItem value="">全部</MenuItem>
          {SOURCE_OPTIONS.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
        </TextField>
      </FilterPanel>

      <DataTableMui
        columns={columns}
        rows={visibleRows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage={rows.length === 0 ? '尚未設定任何變數，點右上角「新增變數」開始' : '沒有符合條件的變數'}
        rowActions={(r) => (
          <>
            <Tooltip title="編輯">
              <IconButton onClick={() => openEdit(r)}><Pencil size={16} /></IconButton>
            </Tooltip>
            <Tooltip title="刪除">
              <IconButton color="error" onClick={() => handleDelete(r)}><Trash2 size={16} /></IconButton>
            </Tooltip>
          </>
        )}
      />

      {/* 3 個欄位 → FormPanel 自動選置中 Dialog（規範：≤6 欄位用 Dialog） */}
      <FormPanel
        open={showForm}
        title={editing ? '編輯變數' : '新增變數'}
        fieldCount={3}
        dirty={form.dirty}
        saving={saving}
        onClose={() => setShowForm(false)}
        onSubmit={handleSave}
      >
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label="變數名稱"
            fullWidth
            value={form.value.variable_name}
            onChange={(e) => form.setValue({ ...form.value, variable_name: e.target.value })}
            error={!!fieldError.name}
            helperText={fieldError.name || `訊息範本裡用 [${form.value.variable_name || '變數名稱'}] 這樣的寫法插入。`}
            placeholder="例如：訂單編號"
          />
          <TextField
            select
            label="來源"
            fullWidth
            value={form.value.source}
            onChange={(e) => handleSourceChange(e.target.value as VariableSource)}
          >
            {SOURCE_OPTIONS.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
          <TextField
            select
            label="欄位"
            fullWidth
            value={form.value.field_key}
            onChange={(e) => form.setValue({ ...form.value, field_key: e.target.value })}
            error={!!fieldError.field}
            helperText={fieldError.field}
          >
            {currentSourceFields.map((f) => <MenuItem key={f.value} value={f.value}>{f.label}</MenuItem>)}
          </TextField>
        </Stack>
      </FormPanel>
    </Stack>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, IconButton, InputAdornment, MenuItem, Skeleton, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ArrowRight, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { SOURCE_OPTIONS, type VariableSource } from '../../lib/messageVariables';
import { usePermission } from '../../app/Can';
import { useBreakpoint } from '../../app/useBreakpoint';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import FormPanel from '../../components/ui-mui/FormPanel';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import { useDirtyForm } from '../../components/ui-mui/useDirtyForm';

// ========================================================================
// 參數設定：訊息變數。罐頭訊息與客製訊息範本裡的 [變數名稱] 要從哪個欄位取值。
// 依來源（訂單／客戶／民宿設定）分成三張卡，一眼看出每種來源已經開了哪些變數；
// 舊版是「篩選卡＋表格」，三十幾筆全部平鋪、還要按查詢才會篩，這裡改成邊打邊篩。
// ========================================================================

interface VariableRow { id: string; variable_name: string; source: VariableSource; field_key: string; display_order: number }
interface FormValue { variable_name: string; source: VariableSource; field_key: string }
const EMPTY_FORM: FormValue = { variable_name: '', source: 'booking', field_key: '' };

const fieldLabel = (source: VariableSource, key: string) => SOURCE_OPTIONS.find((s) => s.value === source)?.fields.find((f) => f.value === key)?.label || key;

export default function ParametersPage() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const canManage = usePermission('system.manage');

  const [rows, setRows] = useState<VariableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<VariableRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{ name?: string; field?: string }>({});
  const form = useDirtyForm<FormValue>(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error: qErr } = await supabase.from('message_variables').select('*').order('display_order');
    if (qErr) setError(qErr.message); else setRows((data || []) as VariableRow[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const q = search.trim().toLowerCase();
  const groups = useMemo(() => SOURCE_OPTIONS.map((s) => ({
    ...s,
    rows: rows.filter((r) => r.source === s.value && (!q || r.variable_name.toLowerCase().includes(q) || fieldLabel(r.source, r.field_key).toLowerCase().includes(q))),
  })), [rows, q]);

  const openNew = (source: VariableSource = 'booking') => {
    setEditing(null); setFieldError({});
    form.reset({ variable_name: '', source, field_key: SOURCE_OPTIONS.find((s) => s.value === source)?.fields[0]?.value || '' });
    setShowForm(true);
  };
  const openEdit = (row: VariableRow) => {
    setEditing(row); setFieldError({});
    form.reset({ variable_name: row.variable_name, source: row.source, field_key: row.field_key });
    setShowForm(true);
  };
  // 換來源時原本的欄位多半不屬於新來源，直接帶到新來源的第一個欄位
  const changeSource = (source: VariableSource) => {
    const fields = SOURCE_OPTIONS.find((s) => s.value === source)?.fields || [];
    form.setValue({ ...form.value, source, field_key: fields[0]?.value || '' });
  };

  const save = async () => {
    const name = form.value.variable_name.trim();
    const errs: typeof fieldError = {};
    if (!name) errs.name = '請輸入變數名稱';
    if (/[[\]]/.test(name)) errs.name = '名稱不用加中括號，插入範本時系統會自己加';
    if (!form.value.field_key) errs.field = '請選擇欄位';
    setFieldError(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const payload = { variable_name: name, source: form.value.source, field_key: form.value.field_key };
      const res = editing
        ? await supabase.from('message_variables').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', editing.id)
        : await supabase.from('message_variables').insert({ ...payload, display_order: rows.length });
      if (res.error) throw res.error;
      form.commit(); setShowForm(false);
      enqueueSnackbar(editing ? '變數已更新' : '變數已新增', { variant: 'success' });
      load();
    } catch (e: any) {
      if (e.code === '23505' || e.message?.includes('duplicate')) setFieldError({ name: '這個變數名稱已經存在，請換一個名稱' });
      else enqueueSnackbar(`儲存失敗：${e.message}`, { variant: 'error' });
    } finally { setSaving(false); }
  };

  const remove = async (row: VariableRow) => {
    const ok = await confirm({
      title: `刪除變數 [${row.variable_name}]？`,
      message: `還在用這個變數的訊息範本裡，[${row.variable_name}] 會直接顯示原始文字，不會再被替換成實際資料。`,
      confirmLabel: '刪除', danger: true,
    });
    if (!ok) return;
    const { error: dErr } = await supabase.from('message_variables').delete().eq('id', row.id);
    if (dErr) { enqueueSnackbar(`刪除失敗：${dErr.message}`, { variant: 'error' }); return; }
    enqueueSnackbar('變數已刪除', { variant: 'success' });
    load();
  };

  const currentFields = SOURCE_OPTIONS.find((s) => s.value === form.value.source)?.fields || [];

  if (error) return <Box><PageHeaderV2 /><ResultState status={500} description={error} onRetry={load} backTo={false} /></Box>;

  return (
    <Box>
      <PageHeaderV2 action={canManage ? <Button variant="contained" startIcon={<Plus size={16} />} onClick={() => openNew()}>新增變數</Button> : undefined} />

      <Alert severity="info" sx={{ mb: 2.5 }}>
        在「對話流程」的罐頭訊息或「訊息發送」的範本裡打 <code>[變數名稱]</code>，送出時會換成這裡對應欄位的實際內容，例如 <code>[訂單編號]</code> → DX26090004。
      </Alert>

      <TextField
        size="small" placeholder="搜尋變數名稱或欄位" value={search} onChange={(e) => setSearch(e.target.value)}
        InputProps={{ startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> }}
        sx={{ mb: 2.5, minWidth: { md: 320 } }} fullWidth={isMobile}
      />

      {loading ? (
        <Stack spacing={2}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={140} />)}</Stack>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 2.5, alignItems: 'start' }}>
          {groups.map((g) => (
            <Card key={g.value}>
              <CardContent sx={{ p: { xs: 2, md: 2.5 }, '&:last-child': { pb: { xs: 2, md: 2.5 } } }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h6">{g.label}</Typography>
                    <Chip label={`${g.rows.length} 個`} size="small" sx={{ height: 20, fontSize: 11 }} />
                  </Stack>
                  {canManage && <Tooltip title={`新增${g.label}變數`}><IconButton size="small" onClick={() => openNew(g.value)}><Plus size={16} /></IconButton></Tooltip>}
                </Stack>
                {g.rows.length === 0 ? (
                  <Typography variant="body2" color="text.disabled" sx={{ py: 2, textAlign: 'center' }}>{q ? '沒有符合的變數' : '尚無變數'}</Typography>
                ) : (
                  <Stack divider={<Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }} />}>
                    {g.rows.map((r) => (
                      <Stack key={r.id} direction="row" alignItems="center" spacing={1} sx={{ py: 1, '&:hover .actions': { opacity: 1 } }}>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600, whiteSpace: 'nowrap' }}>[{r.variable_name}]</Typography>
                        <ArrowRight size={14} style={{ flexShrink: 0, opacity: 0.4 }} />
                        <Typography variant="body2" color="text.secondary" noWrap sx={{ flex: 1, minWidth: 0 }}>{fieldLabel(r.source, r.field_key)}</Typography>
                        {canManage && (
                          <Stack direction="row" className="actions" sx={{ opacity: isMobile ? 1 : 0, transition: 'opacity .15s', flexShrink: 0 }}>
                            <IconButton size="small" onClick={() => openEdit(r)} aria-label="編輯"><Pencil size={15} /></IconButton>
                            <IconButton size="small" color="error" onClick={() => remove(r)} aria-label="刪除"><Trash2 size={15} /></IconButton>
                          </Stack>
                        )}
                      </Stack>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          ))}
        </Box>
      )}

      <FormPanel open={showForm} title={editing ? '編輯變數' : '新增變數'} fieldCount={3} dirty={form.dirty} saving={saving} onClose={() => setShowForm(false)} onSubmit={save}>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label="變數名稱" fullWidth autoFocus value={form.value.variable_name}
            onChange={(e) => form.setValue({ ...form.value, variable_name: e.target.value })}
            error={!!fieldError.name} helperText={fieldError.name || `範本裡寫成 [${form.value.variable_name || '變數名稱'}]`} placeholder="例如：訂單編號"
          />
          <TextField select label="來源" fullWidth value={form.value.source} onChange={(e) => changeSource(e.target.value as VariableSource)}>
            {SOURCE_OPTIONS.map((s) => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
          <TextField select label="欄位" fullWidth value={form.value.field_key} onChange={(e) => form.setValue({ ...form.value, field_key: e.target.value })} error={!!fieldError.field} helperText={fieldError.field}>
            {currentFields.map((f) => <MenuItem key={f.value} value={f.value}>{f.label}</MenuItem>)}
          </TextField>
        </Stack>
      </FormPanel>
    </Box>
  );
}

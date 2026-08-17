import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, IconButton, MenuItem, Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  DataTableMui, FormPanel, useConfirm, useAbortableQuery, useDirtyForm, type Column,
} from './ui-mui';
import {
  CHANNEL_ROLE_OPTIONS, channelRoleLabel, channelWebhookUrl,
  type LineChannel, type LineChannelRole,
} from '../lib/lineChannels';

// ========================================================================
// 多 LINE 官方帳號管理。
//
// 每個官方帳號有自己的 webhook 網址（同一支 function + ?channel=<id>），要各自貼到
// 對應帳號的 LINE Developers Console。角色決定這個帳號收到訊息時的行為，
// 說明見 lib/lineChannels.ts。
// ========================================================================

interface FormValue {
  name: string;
  role: LineChannelRole;
  channel_access_token: string;
  channel_secret: string;
  is_active: boolean;
}

const EMPTY_FORM: FormValue = {
  name: '', role: 'customer', channel_access_token: '', channel_secret: '', is_active: true,
};

export default function LineChannelsPanel() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { data: channels = [], loading, error, run } = useAbortableQuery<LineChannel[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<LineChannel | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const form = useDirtyForm<FormValue>(EMPTY_FORM);

  const fetchChannels = useCallback(() => {
    run(async () => {
      const { data, error } = await supabase.from('line_channels').select('*').order('display_order');
      if (error) throw error;
      return (data || []) as LineChannel[];
    });
  }, [run]);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  const openNew = () => {
    setEditing(null);
    setNameError('');
    form.reset({ ...EMPTY_FORM, role: channels.some((c) => c.role === 'customer') ? 'vendor' : 'customer' });
    setShowForm(true);
  };

  const openEdit = (c: LineChannel) => {
    setEditing(c);
    setNameError('');
    form.reset({
      name: c.name,
      role: c.role,
      channel_access_token: c.channel_access_token || '',
      channel_secret: c.channel_secret || '',
      is_active: c.is_active,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    const name = form.value.name.trim();
    if (!name) { setNameError('請輸入官方帳號名稱'); return; }
    setNameError('');
    setSaving(true);
    try {
      const payload = { ...form.value, name, updated_at: new Date().toISOString() };
      if (editing) {
        const { error } = await supabase.from('line_channels').update(payload).eq('id', editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('line_channels')
          .insert({ ...payload, display_order: channels.length });
        if (error) throw error;
      }
      form.commit();
      setShowForm(false);
      enqueueSnackbar(editing ? '官方帳號已更新' : '官方帳號已新增', { variant: 'success' });
      fetchChannels();
    } catch (e: any) {
      enqueueSnackbar(`儲存失敗：${e.message}`, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: LineChannel) => {
    const ok = await confirm({
      title: `確定要刪除官方帳號「${c.name}」嗎？`,
      message: (
        <Typography variant="body2">
          這個帳號底下的<strong>所有聯絡人資料會一併刪除</strong>（LINE user ID 是各帳號獨立的，
          刪掉就無法復原）。對話紀錄與訂單會保留，但會失去帳號歸屬。
        </Typography>
      ),
      confirmLabel: '刪除',
      danger: true,
      requireTypedText: c.name, // 重要資源：要求輸入名稱雙重確認
    });
    if (!ok) return;
    const { error } = await supabase.from('line_channels').delete().eq('id', c.id);
    if (error) { enqueueSnackbar(`刪除失敗：${error.message}`, { variant: 'error' }); return; }
    enqueueSnackbar('官方帳號已刪除', { variant: 'success' });
    fetchChannels();
  };

  const copyWebhook = (c: LineChannel) => {
    navigator.clipboard.writeText(channelWebhookUrl(window.location.origin, c.id));
    enqueueSnackbar('Webhook 網址已複製', { variant: 'success' });
  };

  const columns: Column<LineChannel>[] = [
    {
      key: 'name',
      header: '官方帳號名稱',
      nowrap: true,
      render: (c) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" fontWeight={600}>{c.name}</Typography>
          {!c.is_active && <Chip label="已停用" size="small" />}
        </Stack>
      ),
    },
    { key: 'role', header: '角色', render: (c) => <Chip label={channelRoleLabel(c.role)} color={c.role === 'customer' ? 'primary' : 'default'} variant="outlined" /> },
    {
      key: 'credentials',
      header: '憑證',
      render: (c) =>
        c.channel_access_token && c.channel_secret
          ? <Typography variant="body2" color="success.main">已設定</Typography>
          : <Typography variant="body2" color="error.main">未完成</Typography>,
    },
    {
      key: 'webhook',
      header: 'Webhook 網址',
      render: (c) => (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" fontFamily="monospace" noWrap sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {channelWebhookUrl(window.location.origin, c.id)}
          </Typography>
          <Tooltip title="複製">
            <IconButton onClick={() => copyWebhook(c)}><Copy size={14} /></IconButton>
          </Tooltip>
        </Stack>
      ),
    },
  ];

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="flex-start" spacing={2}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">LINE 官方帳號</Typography>
          <Typography variant="body2" color="text.secondary">
            每個帳號有自己的 Webhook 網址，請各自貼到對應帳號的 LINE Developers Console，並開啟 Use webhook。
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Plus size={16} />} onClick={openNew}>新增官方帳號</Button>
      </Stack>

      <Alert severity="info" sx={{ fontSize: 13 }}>
        LINE 的 user ID 是<strong>每個官方帳號各自獨立</strong>的——同一個人在不同帳號會是兩組不同的 ID，
        無法互相對應。所以聯絡人、對話與訂單都會分別歸屬到各自的帳號底下。
      </Alert>

      {error && <Alert severity="error">讀取失敗：{error.message}</Alert>}

      <DataTableMui
        columns={columns}
        rows={channels}
        rowKey={(c) => c.id}
        loading={loading}
        emptyMessage="尚未設定任何官方帳號"
        rowActions={(c) => (
          <>
            <Tooltip title="編輯"><IconButton onClick={() => openEdit(c)}><Pencil size={16} /></IconButton></Tooltip>
            <Tooltip title="刪除"><IconButton color="error" onClick={() => handleDelete(c)}><Trash2 size={16} /></IconButton></Tooltip>
          </>
        )}
      />

      <FormPanel
        open={showForm}
        title={editing ? '編輯官方帳號' : '新增官方帳號'}
        fieldCount={5}
        dirty={form.dirty}
        saving={saving}
        onClose={() => setShowForm(false)}
        onSubmit={handleSave}
      >
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label="官方帳號名稱"
            fullWidth
            value={form.value.name}
            onChange={(e) => form.setValue({ ...form.value, name: e.target.value })}
            error={!!nameError}
            helperText={nameError || '後台各處顯示用，例如「稻香客戶用」「配合廠商群」'}
          />
          <TextField
            select
            label="角色"
            fullWidth
            value={form.value.role}
            onChange={(e) => form.setValue({ ...form.value, role: e.target.value as LineChannelRole })}
            helperText={CHANNEL_ROLE_OPTIONS.find((r) => r.value === form.value.role)?.description}
          >
            {CHANNEL_ROLE_OPTIONS.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
          </TextField>
          <TextField
            label="Channel Access Token"
            fullWidth
            type="password"
            value={form.value.channel_access_token}
            onChange={(e) => form.setValue({ ...form.value, channel_access_token: e.target.value })}
          />
          <TextField
            label="Channel Secret"
            fullWidth
            type="password"
            value={form.value.channel_secret}
            onChange={(e) => form.setValue({ ...form.value, channel_secret: e.target.value })}
            helperText="用來驗證 webhook 請求真的來自 LINE，填錯的話這個帳號會完全收不到訊息。"
          />
          <Stack direction="row" alignItems="center" spacing={1}>
            <Switch
              checked={form.value.is_active}
              onChange={(e) => form.setValue({ ...form.value, is_active: e.target.checked })}
            />
            <Typography variant="body2">啟用（停用後這個帳號的 webhook 會被拒絕）</Typography>
          </Stack>
        </Stack>
      </FormPanel>
    </Stack>
  );
}

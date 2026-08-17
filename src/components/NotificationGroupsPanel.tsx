import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, IconButton, List, ListItemButton, ListItemText,
  MenuItem, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { Pencil, Plus, Trash2, Users as UsersIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  DataTableMui, FormPanel, useConfirm, useAbortableQuery, useDirtyForm, type Column,
} from './ui-mui';
import { channelRoleLabel, type LineChannel } from '../lib/lineChannels';

// ========================================================================
// 通知名單：排程管理的各種自動通知（尾款提醒、待確認訂單通知、押金處理通知、洗滌排程…）
// 要發給「某個官方帳號底下的某幾位聯絡人，或群組」，不是整個帳號的全部聯絡人。
// 在這裡把聯絡人勾選存成具名清單，各排程可以共用同一份、也可以各自建立自己的名單。
// ========================================================================

interface NotificationGroup {
  id: string;
  channel_id: string;
  name: string;
  line_user_ids: string[];
}

interface Contact {
  line_user_id: string;
  nickname: string | null;
}

interface FormValue {
  name: string;
  channel_id: string;
  line_user_ids: string[];
}

const EMPTY_FORM: FormValue = { name: '', channel_id: '', line_user_ids: [] };

export default function NotificationGroupsPanel() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();

  const [channels, setChannels] = useState<LineChannel[]>([]);
  const { data: groups = [], loading, error, run } = useAbortableQuery<NotificationGroup[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<NotificationGroup | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const form = useDirtyForm<FormValue>(EMPTY_FORM);

  // 表單裡選的官方帳號底下有哪些聯絡人可以勾——換帳號要重新查，不同帳號的聯絡人完全不通用。
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactFilter, setContactFilter] = useState('');

  const fetchGroups = useCallback(() => {
    run(async () => {
      const { data, error } = await supabase
        .from('notification_recipient_groups')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map((g: any) => ({ ...g, line_user_ids: g.line_user_ids || [] })) as NotificationGroup[];
    });
  }, [run]);

  useEffect(() => {
    fetchGroups();
    supabase.from('line_channels').select('*').eq('is_active', true).order('display_order')
      .then(({ data }) => setChannels((data || []) as LineChannel[]));
  }, [fetchGroups]);

  const fetchContacts = useCallback(async (channelId: string) => {
    if (!channelId) { setContacts([]); return; }
    setContactsLoading(true);
    const { data } = await supabase
      .from('user_states')
      .select('line_user_id, nickname')
      .eq('channel_id', channelId)
      .order('last_message_at', { ascending: false, nullsFirst: false });
    setContacts((data || []) as Contact[]);
    setContactsLoading(false);
  }, []);

  const openNew = () => {
    setEditing(null);
    setNameError('');
    // 預設帶「團隊內部用」帳號——這是目前唯一會用到通知名單的角色。
    const defaultChannel = channels.find((c) => c.role === 'internal')?.id || channels[0]?.id || '';
    form.reset({ ...EMPTY_FORM, channel_id: defaultChannel });
    fetchContacts(defaultChannel);
    setContactFilter('');
    setShowForm(true);
  };

  const openEdit = (g: NotificationGroup) => {
    setEditing(g);
    setNameError('');
    form.reset({ name: g.name, channel_id: g.channel_id, line_user_ids: g.line_user_ids });
    fetchContacts(g.channel_id);
    setContactFilter('');
    setShowForm(true);
  };

  const handleChannelChange = (channelId: string) => {
    // 換帳號＝換了一批完全不同的聯絡人，之前勾的人在新帳號底下沒有意義，直接清空勾選，
    // 不要留著舊帳號的 line_user_id 混進新帳號的名單。
    form.setValue({ ...form.value, channel_id: channelId, line_user_ids: [] });
    fetchContacts(channelId);
  };

  const toggleContact = (lineUserId: string) => {
    const set = new Set(form.value.line_user_ids);
    if (set.has(lineUserId)) set.delete(lineUserId); else set.add(lineUserId);
    form.setValue({ ...form.value, line_user_ids: [...set] });
  };

  const handleSave = async () => {
    const name = form.value.name.trim();
    if (!name) { setNameError('請輸入名單名稱'); return; }
    if (!form.value.channel_id) { setNameError('請選擇官方帳號'); return; }
    setNameError('');
    setSaving(true);
    try {
      const payload = {
        name,
        channel_id: form.value.channel_id,
        line_user_ids: form.value.line_user_ids,
        updated_at: new Date().toISOString(),
      };
      if (editing) {
        const { error } = await supabase.from('notification_recipient_groups').update(payload).eq('id', editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('notification_recipient_groups').insert(payload);
        if (error) throw error;
      }
      form.commit();
      setShowForm(false);
      enqueueSnackbar(editing ? '名單已更新' : '名單已新增', { variant: 'success' });
      fetchGroups();
    } catch (e: any) {
      enqueueSnackbar(`儲存失敗：${e.message}`, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (g: NotificationGroup) => {
    const ok = await confirm({
      title: `確定要刪除名單「${g.name}」嗎？`,
      message: '正在使用這份名單的排程會收不到收件人，請先確認沒有排程還在用它。',
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('notification_recipient_groups').delete().eq('id', g.id);
    if (error) { enqueueSnackbar(`刪除失敗：${error.message}`, { variant: 'error' }); return; }
    enqueueSnackbar('名單已刪除', { variant: 'success' });
    fetchGroups();
  };

  const channelName = (id: string) => channels.find((c) => c.id === id)?.name || '（帳號已刪除）';

  const columns: Column<NotificationGroup>[] = [
    { key: 'name', header: '名單名稱', render: (g) => <Typography variant="body2" fontWeight={600}>{g.name}</Typography> },
    { key: 'channel', header: '官方帳號', render: (g) => channelName(g.channel_id) },
    { key: 'count', header: '人數', align: 'right', render: (g) => `${g.line_user_ids.length} 人` },
  ];

  const visibleContacts = contacts.filter((c) => {
    if (!contactFilter.trim()) return true;
    const kw = contactFilter.trim().toLowerCase();
    return (c.nickname || '').toLowerCase().includes(kw) || c.line_user_id.toLowerCase().includes(kw);
  });

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="flex-start" spacing={2}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">通知名單</Typography>
          <Typography variant="body2" color="text.secondary">
            排程管理的自動通知（尾款提醒、押金處理通知…）要發給誰，在這裡勾選聯絡人存成具名清單。
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Plus size={16} />} onClick={openNew} disabled={!channels.length}>
          新增名單
        </Button>
      </Stack>

      {!channels.length && (
        <Alert severity="warning" sx={{ fontSize: 13 }}>
          尚未設定任何 LINE 官方帳號，請先到上方「LINE 官方帳號」新增後才能建立通知名單。
        </Alert>
      )}
      {error && <Alert severity="error">讀取失敗：{error.message}</Alert>}

      <DataTableMui
        columns={columns}
        rows={groups}
        rowKey={(g) => g.id}
        loading={loading}
        emptyMessage="尚未設定任何通知名單"
        rowActions={(g) => (
          <>
            <Tooltip title="編輯"><IconButton onClick={() => openEdit(g)}><Pencil size={16} /></IconButton></Tooltip>
            <Tooltip title="刪除"><IconButton color="error" onClick={() => handleDelete(g)}><Trash2 size={16} /></IconButton></Tooltip>
          </>
        )}
      />

      <FormPanel
        open={showForm}
        title={editing ? '編輯通知名單' : '新增通知名單'}
        variant="drawer"
        dirty={form.dirty}
        saving={saving}
        onClose={() => setShowForm(false)}
        onSubmit={handleSave}
      >
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            label="名單名稱"
            fullWidth
            value={form.value.name}
            onChange={(e) => form.setValue({ ...form.value, name: e.target.value })}
            error={!!nameError}
            helperText={nameError || '例如「內部訂單通知群組」'}
          />
          <TextField
            select
            label="官方帳號"
            fullWidth
            value={form.value.channel_id}
            onChange={(e) => handleChannelChange(e.target.value)}
          >
            {channels.map((c) => (
              <MenuItem key={c.id} value={c.id}>{c.name}（{channelRoleLabel(c.role)}）</MenuItem>
            ))}
          </TextField>

          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="body2" fontWeight={600}>
                聯絡人（已選 {form.value.line_user_ids.length} 人）
              </Typography>
            </Stack>
            <TextField
              size="small"
              fullWidth
              placeholder="搜尋暱稱或 LINE User ID"
              value={contactFilter}
              onChange={(e) => setContactFilter(e.target.value)}
              sx={{ mb: 1 }}
            />
            {contactsLoading ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>載入聯絡人中…</Typography>
            ) : visibleContacts.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                {contacts.length === 0 ? '這個官方帳號底下還沒有任何聯絡人' : '沒有符合搜尋條件的聯絡人'}
              </Typography>
            ) : (
              <List
                dense
                sx={{ maxHeight: 360, overflowY: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
              >
                {visibleContacts.map((c) => {
                  const checked = form.value.line_user_ids.includes(c.line_user_id);
                  return (
                    <ListItemButton key={c.line_user_id} onClick={() => toggleContact(c.line_user_id)} dense>
                      <Checkbox edge="start" checked={checked} tabIndex={-1} disableRipple size="small" />
                      <ListItemText
                        primary={c.nickname || '（未取得暱稱）'}
                        secondary={c.line_user_id}
                        primaryTypographyProps={{ fontSize: 13 }}
                        secondaryTypographyProps={{ fontSize: 11, fontFamily: 'monospace' }}
                      />
                    </ListItemButton>
                  );
                })}
              </List>
            )}
            {form.value.line_user_ids.length > 0 && (
              <Stack direction="row" flexWrap="wrap" gap={0.5} sx={{ mt: 1.5 }}>
                {form.value.line_user_ids.map((id) => {
                  const c = contacts.find((c) => c.line_user_id === id);
                  return (
                    <Chip
                      key={id}
                      size="small"
                      icon={<UsersIcon size={12} />}
                      label={c?.nickname || id.slice(0, 10)}
                      onDelete={() => toggleContact(id)}
                    />
                  );
                })}
              </Stack>
            )}
          </Box>
        </Stack>
      </FormPanel>
    </Stack>
  );
}

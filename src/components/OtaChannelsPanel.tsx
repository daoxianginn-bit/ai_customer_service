import { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, IconButton, MenuItem, Stack, Switch, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { Copy, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  DataTableMui, FormPanel, useConfirm, useAbortableQuery, useDirtyForm, type Column,
} from './ui-mui';
import {
  OTA_PLATFORM_OPTIONS, otaPlatformLabel, otaChannelExportUrl, generateRandomToken,
  type OtaChannel, type OtaPlatform,
} from '../lib/otaChannels';

// ========================================================================
// 第三方平台（Airbnb／Booking.com／Agoda／Trip）iCal 雙向同步設定。
//
// 每一列代表「一個平台 × 一個房間對應」的同步頻道，同一個平台可以開多筆（例如每間房各自
// 對應一組 Airbnb 房源），也可以只開一筆整棟的。匯出網址（給該平台訂閱）建立時就自動產生，
// 匯入網址（該平台提供給我方讀取）由管理員貼上——沒貼就只做匯出，是否雙向由管理員自行決定。
// 實際排程執行在「排程管理」頁新增一筆「第三方平台 iCal 同步」類型的排程，這裡只管頻道設定。
// ========================================================================

interface RoomTypeOption {
  id: string;
  name: string;
}

interface FormValue {
  platform: OtaPlatform;
  name: string;
  room_type_id: string;
  import_ics_url: string;
  extra_block_keywords: string;
  is_active: boolean;
}

const EMPTY_FORM: FormValue = {
  platform: 'airbnb', name: '', room_type_id: '', import_ics_url: '', extra_block_keywords: '', is_active: true,
};

export default function OtaChannelsPanel() {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();

  const [roomTypes, setRoomTypes] = useState<RoomTypeOption[]>([]);
  const { data: channels = [], loading, error, run } = useAbortableQuery<OtaChannel[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<OtaChannel | null>(null);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState('');
  const form = useDirtyForm<FormValue>(EMPTY_FORM);

  const fetchChannels = useCallback(() => {
    run(async () => {
      const { data, error } = await supabase.from('ota_channels').select('*').order('display_order');
      if (error) throw error;
      return (data || []) as OtaChannel[];
    });
  }, [run]);

  useEffect(() => {
    fetchChannels();
    supabase.from('room_types').select('id, name').eq('type', '房間').order('display_order')
      .then(({ data }) => setRoomTypes((data || []) as RoomTypeOption[]));
  }, [fetchChannels]);

  const openNew = () => {
    setEditing(null);
    setNameError('');
    form.reset(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (c: OtaChannel) => {
    setEditing(c);
    setNameError('');
    form.reset({
      platform: c.platform,
      name: c.name,
      room_type_id: c.room_type_id || '',
      import_ics_url: c.import_ics_url || '',
      extra_block_keywords: c.extra_block_keywords || '',
      is_active: c.is_active,
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    const name = form.value.name.trim();
    if (!name) { setNameError('請輸入頻道名稱'); return; }
    setNameError('');
    setSaving(true);
    try {
      const payload = {
        platform: form.value.platform,
        name,
        room_type_id: form.value.room_type_id || null,
        import_ics_url: form.value.import_ics_url.trim() || null,
        extra_block_keywords: form.value.extra_block_keywords.trim() || null,
        is_active: form.value.is_active,
        updated_at: new Date().toISOString(),
      };
      if (editing) {
        const { error } = await supabase.from('ota_channels').update(payload).eq('id', editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('ota_channels')
          .insert({ ...payload, export_token: generateRandomToken(), display_order: channels.length });
        if (error) throw error;
      }
      form.commit();
      setShowForm(false);
      enqueueSnackbar(editing ? '頻道已更新' : '頻道已新增', { variant: 'success' });
      fetchChannels();
    } catch (e: any) {
      enqueueSnackbar(`儲存失敗：${e.message}`, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c: OtaChannel) => {
    const ok = await confirm({
      title: `確定要刪除頻道「${c.name}」嗎？`,
      message: '已經從這個頻道同步進來的訂單會保留（僅解除頻道歸屬），但之後不會再有新的同步。已貼到該平台的匯出網址也會立即失效。',
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('ota_channels').delete().eq('id', c.id);
    if (error) { enqueueSnackbar(`刪除失敗：${error.message}`, { variant: 'error' }); return; }
    enqueueSnackbar('頻道已刪除', { variant: 'success' });
    fetchChannels();
  };

  const handleRegenerateToken = async (c: OtaChannel) => {
    const ok = await confirm({
      title: `確定要重新產生「${c.name}」的匯出網址嗎？`,
      message: '原本貼在該平台的匯出網址會立即失效，需要重新複製新的網址貼過去，否則該平台會讀不到房況更新。',
      confirmLabel: '重新產生',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('ota_channels')
      .update({ export_token: generateRandomToken(), updated_at: new Date().toISOString() }).eq('id', c.id);
    if (error) { enqueueSnackbar(`操作失敗：${error.message}`, { variant: 'error' }); return; }
    enqueueSnackbar('匯出網址已重新產生', { variant: 'success' });
    fetchChannels();
  };

  const copyExportUrl = (c: OtaChannel) => {
    navigator.clipboard.writeText(otaChannelExportUrl(window.location.origin, c.export_token));
    enqueueSnackbar('匯出網址已複製', { variant: 'success' });
  };

  const roomTypeName = (id: string | null) => (id ? roomTypes.find((r) => r.id === id)?.name || '（房型已刪除）' : '整棟');

  const columns: Column<OtaChannel>[] = [
    {
      key: 'platform',
      header: '平台',
      render: (c) => <Chip label={otaPlatformLabel(c.platform)} color="primary" variant="outlined" />,
    },
    {
      key: 'name',
      header: '頻道名稱',
      nowrap: true,
      render: (c) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2" fontWeight={600}>{c.name}</Typography>
          {!c.is_active && <Chip label="已停用" size="small" />}
        </Stack>
      ),
    },
    { key: 'room', header: '房間對應', render: (c) => roomTypeName(c.room_type_id) },
    {
      key: 'import',
      header: '匯入（讀取該平台房況）',
      render: (c) => {
        if (!c.import_ics_url) return <Typography variant="body2" color="text.secondary">未設定，僅匯出</Typography>;
        if (!c.last_imported_at) return <Typography variant="body2" color="text.secondary">尚未同步過</Typography>;
        const time = new Date(c.last_imported_at).toLocaleString('zh-TW', { hour12: false });
        return (
          <Tooltip title={c.last_import_summary || ''}>
            <Typography variant="body2" color={c.last_import_status === 'failed' ? 'error.main' : 'success.main'}>
              {c.last_import_status === 'failed' ? '失敗' : '成功'}　{time}
            </Typography>
          </Tooltip>
        );
      },
    },
    {
      key: 'export',
      header: '匯出網址（給平台訂閱）',
      render: (c) => (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Typography variant="caption" fontFamily="monospace" noWrap sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {otaChannelExportUrl(window.location.origin, c.export_token)}
          </Typography>
          <Tooltip title="複製"><IconButton onClick={() => copyExportUrl(c)}><Copy size={14} /></IconButton></Tooltip>
          <Tooltip title="重新產生"><IconButton onClick={() => handleRegenerateToken(c)}><RefreshCw size={14} /></IconButton></Tooltip>
        </Stack>
      ),
    },
  ];

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="flex-start" spacing={2}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h6">第三方平台 iCal 同步</Typography>
          <Typography variant="body2" color="text.secondary">
            設定 Airbnb／Booking.com／Agoda／Trip 各自的房況同步頻道。匯出網址貼到該平台的「行事曆同步」設定，
            讓平台知道這裡的房源已被訂走；匯入網址貼上該平台提供的 .ics 網址，就會把該平台的訂單讀進來、
            自動佔用日期避免雙重預訂（顯示為「外部平台已訂」）。
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<Plus size={16} />} onClick={openNew}>新增頻道</Button>
      </Stack>

      <Alert severity="info" sx={{ fontSize: 13 }}>
        匯入方向需要排程才會實際執行：請到「排程管理」新增一筆「第三方平台 iCal 同步」類型的排程（建議每小時執行一次）。
        這裡只負責頻道與網址設定。
      </Alert>

      {error && <Alert severity="error">讀取失敗：{error.message}</Alert>}

      <DataTableMui
        columns={columns}
        rows={channels}
        rowKey={(c) => c.id}
        loading={loading}
        emptyMessage="尚未設定任何第三方平台頻道"
        rowActions={(c) => (
          <>
            <Tooltip title="編輯"><IconButton onClick={() => openEdit(c)}><Pencil size={16} /></IconButton></Tooltip>
            <Tooltip title="刪除"><IconButton color="error" onClick={() => handleDelete(c)}><Trash2 size={16} /></IconButton></Tooltip>
          </>
        )}
      />

      <FormPanel
        open={showForm}
        title={editing ? '編輯頻道' : '新增頻道'}
        fieldCount={5}
        dirty={form.dirty}
        saving={saving}
        onClose={() => setShowForm(false)}
        onSubmit={handleSave}
      >
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField
            select
            label="平台"
            fullWidth
            value={form.value.platform}
            onChange={(e) => form.setValue({ ...form.value, platform: e.target.value as OtaPlatform })}
          >
            {OTA_PLATFORM_OPTIONS.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
          </TextField>
          <TextField
            label="頻道名稱"
            fullWidth
            value={form.value.name}
            onChange={(e) => form.setValue({ ...form.value, name: e.target.value })}
            error={!!nameError}
            helperText={nameError || '後台顯示用，例如「Airbnb - 2樓雅房」「Booking 整棟」'}
          />
          <TextField
            select
            label="房間對應"
            fullWidth
            value={form.value.room_type_id}
            onChange={(e) => form.setValue({ ...form.value, room_type_id: e.target.value })}
            helperText="這個頻道只對應到單一房型，還是整棟？只有整棟頻道的訂單才會擋掉所有房間的檔期。"
          >
            <MenuItem value="">整棟（不綁定特定房型）</MenuItem>
            {roomTypes.map((r) => <MenuItem key={r.id} value={r.id}>{r.name}</MenuItem>)}
          </TextField>
          <TextField
            label="匯入網址（該平台提供的 .ics 網址，選填）"
            fullWidth
            value={form.value.import_ics_url}
            onChange={(e) => form.setValue({ ...form.value, import_ics_url: e.target.value })}
            helperText="不填就只做匯出（單向：只讓該平台知道我方房況），之後隨時可以回來補上。"
          />
          <TextField
            label="額外的關房字樣（逗號分隔，選填）"
            fullWidth
            value={form.value.extra_block_keywords}
            onChange={(e) => form.setValue({ ...form.value, extra_block_keywords: e.target.value })}
            helperText="匯入時只收該平台真正成立的訂單，關房事件（Not available／Blocked／CLOSED 等）一律略過，常見字樣系統已內建。平台改了措辭導致關房被當成訂單收進來時，把新字樣補在這裡即可，不分大小寫。"
          />
          <Stack direction="row" alignItems="center" spacing={1}>
            <Switch
              checked={form.value.is_active}
              onChange={(e) => form.setValue({ ...form.value, is_active: e.target.checked })}
            />
            <Typography variant="body2">啟用（停用後匯出網址失效、也不會再匯入這個頻道的資料）</Typography>
          </Stack>
        </Stack>
      </FormPanel>
    </Stack>
  );
}

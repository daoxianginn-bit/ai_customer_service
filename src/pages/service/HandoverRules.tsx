import { useEffect, useState } from 'react';
import { Grid, InputAdornment, MenuItem, TextField } from '@mui/material';
import { supabase } from '../../lib/supabase';
import { useSettings } from '../../lib/useSettings';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';

// ========================================================================
// 客服規則（V2 §4.3）：真人客服轉接的關鍵字、通知對象、逾時。
// 從舊的「基本設定 → 轉接規則」分頁搬過來，歸到「客服與 AI」模組——這是客服日常會調的東西，
// 不該藏在系統管理裡。匯款期限已搬去「系統管理 → 訂房規則」。
// ========================================================================
export default function HandoverRules() {
  const s = useSettings();
  const { settings, handleChange } = s;

  // 「真人客服通知名單」下拉：名單跟官方帳號是兩張表，一起查才顯示得出「名單（哪個帳號）」
  const [groups, setGroups] = useState<{ id: string; name: string; channel_id: string }[]>([]);
  const [channelNames, setChannelNames] = useState<Record<string, string>>({});
  useEffect(() => {
    (async () => {
      const [g, c] = await Promise.all([
        supabase.from('notification_recipient_groups').select('id, name, channel_id').order('created_at'),
        supabase.from('line_channels').select('id, name'),
      ]);
      setGroups(g.data || []);
      setChannelNames(Object.fromEntries((c.data || []).map((x: any) => [x.id, x.name])));
    })();
  }, []);

  return (
    <SettingsShell loading={s.loading} loadError={s.loadError} onRetry={s.refetch} dirty={s.dirty} saving={s.saving} onSave={s.handleSave} onDiscard={s.discard}>
      {settings && (
        <>
          <SettingsSection title="轉接關鍵字" description="客人訊息含其中一個關鍵字就通知客服、回制式訊息。AI 不會因此停止回覆——真人隨時可以在 LINE 官方帳號直接插話。">
            <TextField fullWidth name="handover_keywords" value={settings.handover_keywords || ''} onChange={handleChange} placeholder="例如：真人客服,找人,專人" helperText="逗號分隔" />
          </SettingsSection>

          <SettingsSection title="通知對象" description="客人喊轉接、系統需要人工判斷、待核對匯款等通知要發給誰。">
            <Grid container spacing={2}>
              <Grid item xs={12}>
                <TextField select fullWidth label="通知名單" name="handover_notification_group_id" value={settings.handover_notification_group_id || ''} onChange={handleChange}
                  helperText="名單本身帶了「用哪個官方帳號發、發給哪些人」。名單請到「串接管理 → 通知對象」建立。沒選的話用下面的 LINE ID 清單。">
                  <MenuItem value="">（未設定，改用下方的客服 LINE ID）</MenuItem>
                  {groups.map((g) => <MenuItem key={g.id} value={g.id}>{g.name}（{channelNames[g.channel_id] || '未知帳號'}）</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={12}>
                <TextField fullWidth label="客服 LINE ID（備用）" name="agent_user_ids" value={settings.agent_user_ids || ''} onChange={handleChange} placeholder="U123…, U456…" helperText="逗號分隔。用「客戶用」官方帳號推播。" />
              </Grid>
            </Grid>
          </SettingsSection>

          <SettingsSection title="真人模式逾時" description="只有系統在「對話流程設定被異動、接不下去」時會把客人切進真人模式（AI 完全靜音）；客人多久沒互動就自動切回 AI。">
            <Grid container spacing={2}>
              <Grid item xs={12} md={4}>
                <TextField fullWidth type="number" name="handover_timeout_minutes" value={settings.handover_timeout_minutes || 30} onChange={handleChange} inputProps={{ min: 1 }} InputProps={{ endAdornment: <InputAdornment position="end">分鐘</InputAdornment> }} />
              </Grid>
            </Grid>
          </SettingsSection>
        </>
      )}
    </SettingsShell>
  );
}

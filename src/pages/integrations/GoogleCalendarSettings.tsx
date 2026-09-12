import { Alert, Box, Chip, Stack, TextField, Typography } from '@mui/material';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useSettings } from '../../lib/useSettings';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';
import SecretField from '../../components/ui-mui/SecretField';

// ========================================================================
// Google 行事曆（V2 §59）：把房況推送到 Google 行事曆的設定與最近同步狀態。
// 「立即同步」在「自動化排程」的「行事曆整合同步」排程按「立即執行」（§59 的按鈕在那裡實作，
// 這頁不重複做一份會打同一支 Function 的按鈕）。
// ========================================================================
export default function GoogleCalendarSettings() {
  const s = useSettings();
  const { settings, handleChange } = s;
  const lastOk = settings?.google_calendar_last_sync_status === 'success';

  return (
    <SettingsShell loading={s.loading} loadError={s.loadError} onRetry={s.refetch} dirty={s.dirty} saving={s.saving} onSave={s.handleSave} onDiscard={s.discard}>
      {settings && (
        <>
          <SettingsSection title="同步狀態" description="「自動化排程 → 行事曆整合同步」每次執行後更新。">
            {settings.google_calendar_last_synced_at ? (
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <Chip icon={lastOk ? <CheckCircle2 size={14} /> : <XCircle size={14} />} label={lastOk ? '正常' : '失敗'} color={lastOk ? 'success' : 'error'} variant="outlined" />
                <Box>
                  <Typography variant="body2">最近同步：{new Date(settings.google_calendar_last_synced_at).toLocaleString('zh-TW')}</Typography>
                  <Typography variant="body2" color="text.secondary">{settings.google_calendar_last_sync_summary}</Typography>
                </Box>
              </Stack>
            ) : (
              <Chip label="未設定" variant="outlined" />
            )}
          </SettingsSection>

          <SettingsSection title="連線設定">
            <Stack spacing={2}>
              <TextField fullWidth label="Google 行事曆 ID" name="google_calendar_id" value={settings.google_calendar_id || ''} onChange={handleChange} placeholder="例如 abcd1234@group.calendar.google.com" helperText="在 Google 日曆該行事曆的「設定與共用」頁面可以找到「行事曆 ID」" inputProps={{ style: { fontFamily: 'monospace' } }} />
              <SecretField fullWidth multiline minRows={4} label="服務帳號金鑰（JSON）" name="google_service_account_json" value={settings.google_service_account_json || ''} onChange={handleChange} placeholder='{"type": "service_account", "client_email": "...", "private_key": "...", ...}' inputProps={{ style: { fontFamily: 'monospace', fontSize: 12 } }} />
            </Stack>
            <Alert severity="info" sx={{ mt: 2 }}>
              一次性設定：(1) 在 Google Cloud Console 啟用 <strong>Google Calendar API</strong>；(2) 建立服務帳號、下載金鑰 JSON 貼到上方；
              (3) 把目標行事曆「分享」給金鑰裡的 <code>client_email</code>，權限選「可以變更活動」；(4) 到「自動化排程」新增「行事曆整合同步」。
              <br />第 (1) 步漏掉會是 <code>403 SERVICE_DISABLED</code>；第 (3) 步只給「查看」會是 <code>403 forbidden</code>。
            </Alert>
          </SettingsSection>
        </>
      )}
    </SettingsShell>
  );
}

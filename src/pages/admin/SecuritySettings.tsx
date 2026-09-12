import { useEffect, useState } from 'react';
import { Alert, Chip, Grid, InputAdornment, Stack, TextField, Typography } from '@mui/material';
import { ShieldCheck } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useSettings } from '../../lib/useSettings';
import { useAuth } from '../../lib/AuthContext';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';

// ========================================================================
// 安全性與隱私（V2 §64、§106–108）。
// 登入政策目前是固定的（只有 Google、強制 2FA、5 次鎖 15 分），這裡如實列出讓管理員知道，
// 不做假的開關。可調的只有主帳號（在帳號與權限頁設定）與對話紀錄保留天數。
// ========================================================================
export default function SecuritySettings() {
  const s = useSettings();
  const { settings, handleChange } = s;
  const { profile } = useAuth();
  const [primaryName, setPrimaryName] = useState<string | null>(null);

  useEffect(() => {
    if (!settings?.primary_admin_id) { setPrimaryName(null); return; }
    supabase.from('admin_profiles').select('display_name, email').eq('id', settings.primary_admin_id).maybeSingle()
      .then(({ data }) => setPrimaryName(data?.display_name || data?.email || null));
  }, [settings?.primary_admin_id]);

  return (
    <SettingsShell loading={s.loading} loadError={s.loadError} onRetry={s.refetch} dirty={s.dirty} saving={s.saving} onSave={s.handleSave} onDiscard={s.discard}>
      {settings && (
        <>
          <SettingsSection title="登入政策" description="這些是系統固定的規則，不可關閉。">
            <Stack spacing={1}>
              {[
                '後台不開放自行註冊，只有受邀的 Google 帳號能登入',
                '每次登入都必須通過 Google Authenticator 驗證碼',
                '驗證碼連續錯 5 次鎖定 15 分鐘',
                '未通過雙因素驗證的登入狀態讀不到任何資料（資料庫層強制）',
              ].map((t) => (
                <Stack key={t} direction="row" spacing={1} alignItems="center"><ShieldCheck size={16} color="var(--mui-palette-success-main, #2E7D5B)" /><Typography variant="body2">{t}</Typography></Stack>
              ))}
            </Stack>
          </SettingsSection>

          <SettingsSection title="主帳號" description="主帳號不能被其他管理員停權、降級或移除，也是唯一能清除客戶個資的帳號。在「帳號與權限」頁設定。">
            {settings.primary_admin_id ? (
              <Chip color="primary" variant="outlined" label={`主帳號：${primaryName || settings.primary_admin_id}${settings.primary_admin_id === profile?.id ? '（你）' : ''}`} />
            ) : (
              <Alert severity="warning">尚未設定主帳號。建議由老闆本人到「帳號與權限」頁按「將我設為主帳號」。</Alert>
            )}
          </SettingsSection>

          <SettingsSection title="對話紀錄保留" description="超過天數的對話紀錄（含處理過程診斷）由每日排程自動清除。客戶個資的刪除請求請到「客戶資料」頁執行。">
            <Grid container spacing={2}>
              <Grid item xs={12} md={4}>
                <TextField fullWidth type="number" label="保留天數" name="conversation_retention_days" value={settings.conversation_retention_days ?? 3} onChange={handleChange} inputProps={{ min: 1 }} InputProps={{ endAdornment: <InputAdornment position="end">天</InputAdornment> }} />
              </Grid>
            </Grid>
          </SettingsSection>
        </>
      )}
    </SettingsShell>
  );
}

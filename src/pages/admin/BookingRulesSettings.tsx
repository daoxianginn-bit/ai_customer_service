import { Alert, FormControlLabel, Grid, InputAdornment, Switch, TextField, Typography } from '@mui/material';
import { useSettings } from '../../lib/useSettings';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';

// ========================================================================
// 訂房規則（V2 §68）：訂單流程的規則，不是價格計算——價格在「價格中心」。
//   是否開放包棟、訂金比例、一般押金、包棟押金、匯款期限。
// 訂金比例與包棟押金以前在「計價公式設定」裡，依 §68 原則搬過來；一般押金與包棟開放
// 以前沒有任何頁面能改。
// ========================================================================
export default function BookingRulesSettings() {
  const s = useSettings();
  const { settings, setField, handleChange } = s;

  return (
    <SettingsShell loading={s.loading} loadError={s.loadError} onRetry={s.refetch} dirty={s.dirty} saving={s.saving} onSave={s.handleSave} onDiscard={s.discard}>
      {settings && (
        <>
          <SettingsSection title="包棟" description="關閉後客人詢問包棟時系統不會報包棟價，只報個別租房。">
            <FormControlLabel
              control={<Switch checked={settings.booking_whole_house_enabled !== false} onChange={(e) => setField('booking_whole_house_enabled', e.target.checked)} />}
              label={<Typography fontWeight={500}>{settings.booking_whole_house_enabled !== false ? '開放包棟' : '不開放包棟'}</Typography>}
            />
          </SettingsSection>

          <SettingsSection title="訂金與押金" description="總金額 = 房費 + 押金；訂金 = 房費 × 訂金比例；尾款 = 總金額 − 訂金。">
            <Grid container spacing={2}>
              <Grid item xs={12} md={4}>
                <TextField fullWidth type="number" label="訂金比例" name="deposit_percent" value={settings.deposit_percent ?? ''} onChange={handleChange} inputProps={{ min: 0, max: 100 }} InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }} helperText="以房費為基數，不含押金" />
              </Grid>
              <Grid item xs={12} md={4}>
                <TextField fullWidth type="number" label="一般押金" name="security_deposit_amount" value={settings.security_deposit_amount ?? ''} onChange={handleChange} inputProps={{ min: 0 }} InputProps={{ startAdornment: <InputAdornment position="start">NT$</InputAdornment> }} helperText="個別租房每筆訂單的押金" />
              </Grid>
              <Grid item xs={12} md={4}>
                <TextField fullWidth type="number" label="包棟押金" name="whole_house_security_deposit" value={settings.whole_house_security_deposit ?? ''} onChange={handleChange} inputProps={{ min: 0 }} InputProps={{ startAdornment: <InputAdornment position="start">NT$</InputAdornment> }} />
              </Grid>
            </Grid>
          </SettingsSection>

          <SettingsSection title="匯款期限" description="客人回「是」確認訂房後，幾小時內要完成匯款。逾時由「自動化排程」的「訂單自動取消」處理。">
            <Grid container spacing={2}>
              <Grid item xs={12} md={4}>
                <TextField fullWidth type="number" label="匯款期限" name="payment_deadline_hours" value={settings.payment_deadline_hours ?? 10} onChange={handleChange} inputProps={{ min: 1 }} InputProps={{ endAdornment: <InputAdornment position="end">小時</InputAdornment> }} />
              </Grid>
            </Grid>
            <Alert severity="info" sx={{ mt: 2 }}>期限會寫進每筆訂單（訊息變數 [匯款日時間]），改設定只影響之後成立的訂單。</Alert>
          </SettingsSection>
        </>
      )}
    </SettingsShell>
  );
}

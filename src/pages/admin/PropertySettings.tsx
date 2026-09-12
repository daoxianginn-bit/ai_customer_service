import { Grid, TextField } from '@mui/material';
import { useSettings } from '../../lib/useSettings';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';

// ========================================================================
// 民宿基本資料（V2 §65）。
// 這三個欄位以前資料庫有、程式也會用（訊息變數 [民宿名稱]、[客服LINE]、[禮金內容]），
// 但沒有任何頁面能編輯，只能到資料庫改。V2 補上。
// 電話、地址、Check-in／out 時間目前資料模型沒有，依 §65 不假設欄位存在，列為之後擴充。
// ========================================================================
export default function PropertySettings() {
  const s = useSettings();
  const { settings, handleChange } = s;

  return (
    <SettingsShell loading={s.loading} loadError={s.loadError} onRetry={s.refetch} dirty={s.dirty} saving={s.saving} onSave={s.handleSave} onDiscard={s.discard}>
      {settings && (
        <>
          <SettingsSection title="基本資料" description="這些會出現在客人收到的訊息裡（訊息變數 [民宿名稱]、[客服LINE]）。">
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <TextField fullWidth label="民宿名稱" name="business_name" value={settings.business_name || ''} onChange={handleChange} />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField fullWidth label="客服 LINE" name="customer_service_line" value={settings.customer_service_line || ''} onChange={handleChange} placeholder="例如 @daoxiang 或 LINE ID" helperText="客人要找真人時看到的聯絡方式" />
              </Grid>
            </Grid>
          </SettingsSection>

          <SettingsSection title="禮金內容" description="訊息變數 [禮金內容] 會帶入這段文字，例如訂房確認訊息裡的贈品說明。">
            <TextField fullWidth multiline minRows={3} name="booking_gift_message" value={settings.booking_gift_message || ''} onChange={handleChange} placeholder="例如：入住即贈在地手作點心一份" />
          </SettingsSection>
        </>
      )}
    </SettingsShell>
  );
}

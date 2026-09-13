import { useState } from 'react';
import {
  Alert, Box, Button, FormControlLabel, Grid, MenuItem, Stack, Switch, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { Activity, CheckCircle2, XCircle } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useSettings } from '../../lib/useSettings';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';
import SecretField from '../../components/ui-mui/SecretField';
import KeywordRulesField from '../../components/ui-mui/KeywordRulesField';

// ========================================================================
// AI 引擎（V2 §66–67）：供應商 → 模型與金鑰 → 該供應商專屬參數 → 系統指令 → 忽略關鍵字。
// 選 OpenAI 只顯示 OpenAI 的參數、選 Gemini 只顯示 Gemini 的，不把不適用的欄位擺在同一頁。
// 「測試連線」用畫面上填的值實際呼叫一次（netlify/functions/ai-test.ts）。
// ========================================================================

type AiTestResult =
  | { ok: true; provider: string; model: string; latency_ms: number; reply: string; structured_ok: boolean }
  | { ok: false; provider?: string; model?: string; latency_ms?: number; error: string };

export default function AiEngineSettings() {
  const s = useSettings();
  const { settings, setField, handleChange } = s;
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AiTestResult | null>(null);

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch('/.netlify/functions/ai-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          active_ai: settings.active_ai,
          gpt_model_name: settings.gpt_model_name, gpt_api_key: settings.gpt_api_key,
          gpt_reasoning_effort: settings.gpt_reasoning_effort, gpt_verbosity: settings.gpt_verbosity,
          gpt_max_tokens: settings.gpt_max_tokens, gpt_temperature: settings.gpt_temperature,
          gemini_model_name: settings.gemini_model_name, gemini_api_key: settings.gemini_api_key,
          gemini_max_tokens: settings.gemini_max_tokens, gemini_temperature: settings.gemini_temperature,
          gemini_thinking_level: settings.gemini_thinking_level,
        }),
      });
      const text = await res.text();
      try { setResult(JSON.parse(text)); } catch { setResult({ ok: false, error: text || `HTTP ${res.status}` }); }
    } catch (e: any) {
      setResult({ ok: false, error: e?.message || '連線失敗' });
    } finally {
      setTesting(false);
    }
  };

  const isGpt = settings?.active_ai !== 'gemini';
  const isGpt5 = isGpt && !!settings?.gpt_model_name?.includes('gpt-5');
  const isGemini3 = !isGpt && !!settings?.gemini_model_name?.includes('gemini-3');

  return (
    <SettingsShell loading={s.loading} loadError={s.loadError} onRetry={s.refetch} dirty={s.dirty} saving={s.saving} onSave={s.handleSave} onDiscard={s.discard}>
      {settings && (<>
      <SettingsSection title="AI 回覆" description="關閉後客人的訊息不再由 AI 回覆，訂房流程也不會啟動；「轉真人客服」關鍵字仍然有效。設定有 30 秒快取，最慢半分鐘後生效。">
        <FormControlLabel
          control={<Switch checked={!!settings.is_ai_enabled} onChange={(e) => setField('is_ai_enabled', e.target.checked)} />}
          label={<Typography fontWeight={500}>{settings.is_ai_enabled ? 'AI 回覆啟用中' : 'AI 回覆已停用'}</Typography>}
        />
      </SettingsSection>

      <SettingsSection title="AI 模型" description="模型名稱是自由輸入，存檔前可先「測試連線」確認供應商認得這個模型、金鑰有效。" action={
        <Button variant="outlined" onClick={runTest} disabled={testing} startIcon={<Activity size={16} />}>{testing ? '測試中…' : '測試連線'}</Button>
      }>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>供應商</Typography>
            <ToggleButtonGroup exclusive value={settings.active_ai || 'gpt'} onChange={(_, v) => v && setField('active_ai', v)} size="small">
              <ToggleButton value="gpt" sx={{ px: 2 }}>OpenAI</ToggleButton>
              <ToggleButton value="gemini" sx={{ px: 2 }}>Google Gemini</ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Grid container spacing={2}>
            <Grid item xs={12}>
              <SecretField fullWidth label="API Key" name={isGpt ? 'gpt_api_key' : 'gemini_api_key'} value={(isGpt ? settings.gpt_api_key : settings.gemini_api_key) || ''} onChange={handleChange} placeholder="輸入 API 金鑰" />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField fullWidth label="模型名稱" name={isGpt ? 'gpt_model_name' : 'gemini_model_name'} value={(isGpt ? settings.gpt_model_name : settings.gemini_model_name) || ''} onChange={handleChange} placeholder={isGpt ? '例如 gpt-4.1-mini、gpt-5.2' : '例如 gemini-2.5-flash'} />
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField fullWidth type="number" label="回覆長度上限（tokens）" name={isGpt ? 'gpt_max_tokens' : 'gemini_max_tokens'} value={(isGpt ? settings.gpt_max_tokens : settings.gemini_max_tokens) ?? ''} onChange={handleChange}
                helperText={isGpt5 ? '這個上限包含推理 token；推理力道設 Medium 以上時建議 2000 以上，否則回答可能被截斷' : undefined} />
            </Grid>
            {!isGpt5 && (
              <Grid item xs={12} md={6}>
                <TextField fullWidth type="number" inputProps={{ step: 0.1, min: 0, max: 2 }} label="Temperature" name={isGpt ? 'gpt_temperature' : 'gemini_temperature'} value={(isGpt ? settings.gpt_temperature : settings.gemini_temperature) ?? ''} onChange={handleChange}
                  helperText={isGemini3 ? 'Gemini 3 系列建議保持 1.0' : '數字越低回答越穩定，越高越有變化'} />
              </Grid>
            )}
            {isGpt5 && (
              <>
                <Grid item xs={12} md={6}>
                  <TextField select fullWidth label="推理力道" name="gpt_reasoning_effort" value={settings.gpt_reasoning_effort || 'none'} onChange={handleChange} helperText="分類與擷取這種小任務用 None／Low 就夠，又快又便宜">
                    {['none', 'low', 'medium', 'high', 'xhigh'].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                  </TextField>
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField select fullWidth label="回答詳細程度" name="gpt_verbosity" value={settings.gpt_verbosity || 'medium'} onChange={handleChange}>
                    {['low', 'medium', 'high'].map((v) => <MenuItem key={v} value={v}>{v}</MenuItem>)}
                  </TextField>
                </Grid>
              </>
            )}
            {isGemini3 && (
              <Grid item xs={12} md={6}>
                <TextField select fullWidth label="思考程度" name="gemini_thinking_level" value={settings.gemini_thinking_level || 'high'} onChange={handleChange}>
                  <MenuItem value="minimal">Minimal（不思考／極速，僅 Flash 支援）</MenuItem>
                  <MenuItem value="low">Low（降低延遲）</MenuItem>
                  <MenuItem value="medium">Medium（平衡，僅 Flash 支援）</MenuItem>
                  <MenuItem value="high">High（深層推理）</MenuItem>
                </TextField>
              </Grid>
            )}
          </Grid>

          {result && (
            result.ok ? (
              <Alert severity="success" icon={<CheckCircle2 size={18} />}>
                <Typography fontWeight={600}>連線成功 · {result.model} · {result.latency_ms} ms</Typography>
                <Typography variant="body2">{result.structured_ok ? '模型有照指令輸出 JSON，訂房流程的欄位擷取與意圖判斷可以正常運作。' : '模型有回應，但沒有照指令輸出 JSON——訂房流程的欄位擷取可能不穩，建議換模型或調低推理力道。'}</Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>回覆：{result.reply}</Typography>
              </Alert>
            ) : (
              <Alert severity="error" icon={<XCircle size={18} />}>
                <Typography fontWeight={600}>連線失敗{result.model ? ` · ${result.model}` : ''}</Typography>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', wordBreak: 'break-all', display: 'block' }}>{result.error}</Typography>
                <Typography variant="body2">
                  {/model|does not exist|not found/i.test(result.error) ? '通常是模型名稱打錯，或這個帳號沒有該模型的使用權限。到供應商後台的模型列表確認正確名稱。'
                    : /api key|incorrect|invalid|401|unauthorized/i.test(result.error) ? '通常是 API Key 錯誤或已失效。'
                    : /quota|rate|429|billing|insufficient/i.test(result.error) ? '通常是額度用完或帳單問題。'
                    : '請看上方原始錯誤訊息。'}
                </Typography>
              </Alert>
            )
          )}
        </Stack>
      </SettingsSection>

      <SettingsSection title="系統指令" description="告訴 AI 它是誰、該怎麼說話。民宿的實際資訊請放在「AI 知識庫」，會自動接在這段後面。">
        <TextField fullWidth multiline minRows={4} name="system_prompt" value={settings.system_prompt || ''} onChange={handleChange} />
      </SettingsSection>

      <SettingsSection title="忽略關鍵字" description="命中任一條規則的訊息整則跳過——不進訂房流程、不轉真人、不呼叫 AI，只留對話紀錄。給貼圖轉出的固定文字、測試字串用；「包含」要小心太短的字會誤傷正常問題（例如「房型」會擋掉「房型有哪些」）。">
        <KeywordRulesField value={settings.ai_ignore_keywords} onChange={(v) => setField('ai_ignore_keywords', v)} placeholder="例如：測試、廣告" />
      </SettingsSection>
      </>)}
    </SettingsShell>
  );
}

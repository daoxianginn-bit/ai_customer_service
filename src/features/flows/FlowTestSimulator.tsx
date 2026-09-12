import { useState } from 'react';
import { Alert, Box, Button, Chip, Drawer, IconButton, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { FlaskConical, RotateCcw, Send, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import StatusBadge from '../../components/ui-mui/StatusBadge';

// ========================================================================
// 流程測試模擬器（V2 §36）：在「對話流程」頁右側打開，輸入客人會說的話，看系統判成什麼意圖、
// 抓到哪些欄位、還缺什麼。走 flow-test function → 跟正式對話同一套分類與擷取，
// 但完全不寫訂單、不推播。每一輪抓到的欄位會累積（模擬多輪收集），可隨時重來。
// ========================================================================

interface SimResult {
  flow: { id: string; name: string; replyMode: string; flowType: string } | null;
  intent: { intent: string; slots: Record<string, string>; source: 'ai' | 'rules'; reason?: string } | null;
  missing: string[];
  merged: Record<string, string>;
  fields: { key: string; label: string; quote_field: string | null }[];
  extractedWithoutAi: Record<string, string>;
  steps: string[];
  errors: string[];
  elapsed_ms: number;
}

interface Turn { message: string; result?: SimResult; error?: string }

const PHASES = [
  { value: 'collecting', label: '收集資料中' },
  { value: 'awaiting_confirmation', label: '已報價，等回「是／否」' },
  { value: 'awaiting_remittance', label: '等回報匯款' },
];

const INTENT_LABEL: Record<string, string> = {
  provide: '提供資料', modify: '修改資料', confirm: '確認訂房', decline: '不訂了', restart: '重新開始',
  question: '問問題', payment_report: '回報匯款', chitchat: '閒聊', unknown: '無法判斷', booking_inquiry: '詢問訂房', answer: '回答問題',
};

async function callFlowTest(body: unknown): Promise<SimResult> {
  const { data } = await supabase.auth.getSession();
  const res = await fetch('/.netlify/functions/flow-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  if (!res.ok) throw new Error(parsed?.error || `HTTP ${res.status}`);
  return parsed as SimResult;
}

export default function FlowTestSimulator({ flowId, flowName }: { flowId?: string | null; flowName?: string }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState('collecting');
  const [collected, setCollected] = useState<Record<string, string>>({});
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setCollected({}); setTurns([]); setPhase('collecting'); };

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft('');
    setBusy(true);
    const turn: Turn = { message };
    setTurns((t) => [...t, turn]);
    try {
      const recent = turns.slice(-3).map((t) => ({ role: 'customer' as const, text: t.message }));
      const result = await callFlowTest({ message, flowId: flowId || null, phase, collected, recentMessages: recent });
      setCollected(result.merged);
      setTurns((t) => t.map((x) => (x === turn ? { ...x, result } : x)));
    } catch (e: any) {
      setTurns((t) => t.map((x) => (x === turn ? { ...x, error: e.message } : x)));
    } finally {
      setBusy(false);
    }
  };

  const fieldLabel = (key: string, r?: SimResult) => r?.fields.find((f) => f.key === key)?.label || key;

  return (
    <>
      <Button variant="outlined" color="inherit" startIcon={<FlaskConical size={16} />} onClick={() => setOpen(true)}>測試對話</Button>
      <Drawer anchor="right" open={open} onClose={() => setOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 440 } } }}>
        <Stack sx={{ height: '100%' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1">測試對話</Typography>
              <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{flowName ? `流程：${flowName}` : '使用第一個啟用中的報價流程'}・不會寫入正式訂單</Typography>
            </Box>
            <Button size="small" color="inherit" startIcon={<RotateCcw size={14} />} onClick={reset} disabled={busy}>重來</Button>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label="關閉"><X size={18} /></IconButton>
          </Stack>

          <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
            <TextField select size="small" label="目前階段" value={phase} onChange={(e) => setPhase(e.target.value)} sx={{ minWidth: 200 }}>
              {PHASES.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
            </TextField>
            <Typography variant="caption" color="text.secondary">已收集 {Object.keys(collected).length} 欄</Typography>
          </Stack>

          <Box sx={{ flex: 1, overflowY: 'auto', p: 2, bgcolor: 'background.default' }}>
            {turns.length === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>
                輸入客人會說的話，例如「我想 10/1 住一晚 8 個人」，看系統怎麼判斷。
              </Typography>
            )}
            <Stack spacing={1.5}>
              {turns.map((t, i) => (
                <Box key={i}>
                  <Stack alignItems="flex-end"><Paper sx={{ px: 1.5, py: 1, bgcolor: 'primary.main', color: 'primary.contrastText', maxWidth: '85%' }}><Typography variant="body2">{t.message}</Typography></Paper></Stack>
                  {!t.result && !t.error && <Typography variant="caption" color="text.secondary">判斷中…</Typography>}
                  {t.error && <Alert severity="error" sx={{ mt: 1 }}>{t.error}</Alert>}
                  {t.result && (
                    <Paper variant="outlined" sx={{ mt: 1, p: 1.5 }}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                        {t.result.intent && <StatusBadge label={`意圖：${INTENT_LABEL[t.result.intent.intent] || t.result.intent.intent}`} tone={t.result.errors.length ? 'danger' : 'info'} dot={false} />}
                        {t.result.intent && <Chip size="small" label={t.result.intent.source === 'ai' ? 'AI 判斷' : '規則判斷'} />}
                        <Chip size="small" label={`${t.result.elapsed_ms} ms`} />
                      </Stack>
                      {t.result.intent?.reason && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>{t.result.intent.reason}</Typography>}
                      {t.result.intent && Object.keys(t.result.intent.slots).length > 0 && (
                        <Box sx={{ mb: 1 }}>
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>這句抓到</Typography>
                          {Object.entries(t.result.intent.slots).map(([k, v]) => <Typography key={k} variant="body2">{fieldLabel(k, t.result)}：{v}</Typography>)}
                        </Box>
                      )}
                      <Box sx={{ mb: 1 }}>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>累積已收集</Typography>
                        {Object.keys(t.result.merged).length === 0 ? <Typography variant="body2" color="text.secondary">（無）</Typography> : Object.entries(t.result.merged).map(([k, v]) => <Typography key={k} variant="body2">{fieldLabel(k, t.result)}：{v}</Typography>)}
                      </Box>
                      <Typography variant="caption" color={t.result.missing.length ? 'warning.dark' : 'success.dark'}>
                        {t.result.missing.length ? `還缺：${t.result.missing.join('、')}` : '報價三要素已齊，正式對話會進入算價'}
                      </Typography>
                      {t.result.errors.length > 0 && <Alert severity="error" sx={{ mt: 1, py: 0 }}>{t.result.errors.join('；')}</Alert>}
                      {t.result.steps.length > 0 && (
                        <Box sx={{ mt: 1 }}>
                          <Typography variant="caption" sx={{ fontWeight: 600 }}>決策過程</Typography>
                          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>{t.result.steps.map((s, j) => <Typography key={j} component="li" variant="caption">{s}</Typography>)}</Box>
                        </Box>
                      )}
                    </Paper>
                  )}
                </Box>
              ))}
            </Stack>
          </Box>

          <Stack direction="row" spacing={1} component="form" onSubmit={(e) => { e.preventDefault(); send(); }} sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <TextField size="small" fullWidth placeholder="客人會說的話…" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} autoFocus />
            <Button type="submit" variant="contained" disabled={busy || !draft.trim()} sx={{ minWidth: 44, px: 1.5 }} aria-label="送出"><Send size={16} /></Button>
          </Stack>
        </Stack>
      </Drawer>
    </>
  );
}

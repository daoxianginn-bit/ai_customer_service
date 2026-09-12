import { useState } from 'react';
import { Alert, Box, Button, Chip, Drawer, IconButton, Paper, Stack, TextField, Typography } from '@mui/material';
import { FlaskConical, Send, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';

// ========================================================================
// 知識庫「測試 AI 回答」（V2 §38）：輸入客人可能問的話，看目前的知識庫＋AI 設定會怎麼回。
// 走 knowledge-test function（跟正式問答同一條路），不寫對話紀錄、不推播。
// ========================================================================

interface Turn { question: string; reply?: string; meta?: string; error?: string }

export default function KnowledgeTestDrawer() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    const question = draft.trim();
    if (!question || busy) return;
    setDraft('');
    setBusy(true);
    const turn: Turn = { question };
    setTurns((t) => [...t, turn]);
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetch('/.netlify/functions/knowledge-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token}` },
        body: JSON.stringify({ message: question }),
      });
      const raw = await res.text();
      let parsed: any = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      if (!res.ok) throw new Error(parsed?.error || `HTTP ${res.status}`);
      setTurns((t) => t.map((x) => (x === turn ? { ...x, reply: parsed.reply, meta: `${parsed.model || parsed.provider}・知識庫 ${parsed.knowledgeCount} 條・${parsed.latency_ms} ms` } : x)));
    } catch (e: any) {
      setTurns((t) => t.map((x) => (x === turn ? { ...x, error: e.message } : x)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outlined" color="inherit" startIcon={<FlaskConical size={16} />} onClick={() => setOpen(true)}>測試 AI 回答</Button>
      <Drawer anchor="right" open={open} onClose={() => setOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 420 } } }}>
        <Stack sx={{ height: '100%' }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Box sx={{ flex: 1 }}>
              <Typography variant="subtitle1">測試 AI 回答</Typography>
              <Typography variant="caption" color="text.secondary">用目前啟用的知識庫與 AI 設定回答；不會留下對話紀錄</Typography>
            </Box>
            <IconButton size="small" onClick={() => setOpen(false)} aria-label="關閉"><X size={18} /></IconButton>
          </Stack>
          <Box sx={{ flex: 1, overflowY: 'auto', p: 2, bgcolor: 'background.default' }}>
            {turns.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>例如：「有早餐嗎？」「可以帶寵物嗎？」「幾點退房？」</Typography>}
            <Stack spacing={1.5}>
              {turns.map((t, i) => (
                <Box key={i}>
                  <Stack alignItems="flex-end"><Paper sx={{ px: 1.5, py: 1, bgcolor: 'primary.main', color: 'primary.contrastText', maxWidth: '85%' }}><Typography variant="body2">{t.question}</Typography></Paper></Stack>
                  {!t.reply && !t.error && <Typography variant="caption" color="text.secondary">AI 回答中…</Typography>}
                  {t.error && <Alert severity="error" sx={{ mt: 1 }}>{t.error}</Alert>}
                  {t.reply && (
                    <Stack alignItems="flex-start" sx={{ mt: 1 }}>
                      <Paper variant="outlined" sx={{ px: 1.5, py: 1, maxWidth: '90%' }}>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{t.reply}</Typography>
                        {t.meta && <Chip size="small" label={t.meta} sx={{ mt: 1, height: 20, fontSize: 11 }} />}
                      </Paper>
                    </Stack>
                  )}
                </Box>
              ))}
            </Stack>
          </Box>
          <Stack direction="row" spacing={1} component="form" onSubmit={(e) => { e.preventDefault(); ask(); }} sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
            <TextField size="small" fullWidth placeholder="客人會問的問題…" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={busy} autoFocus />
            <Button type="submit" variant="contained" disabled={busy || !draft.trim()} sx={{ minWidth: 44, px: 1.5 }} aria-label="送出"><Send size={16} /></Button>
          </Stack>
        </Stack>
      </Drawer>
    </>
  );
}

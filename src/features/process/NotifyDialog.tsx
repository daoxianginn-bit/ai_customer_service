import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Skeleton, Stack, TextField, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { Send } from 'lucide-react';
import MessageTemplateEditor from '../../components/MessageTemplateEditor';
import { useTemplateVariables } from '../../hooks/useTemplateVariables';
import { useBreakpoint } from '../../app/useBreakpoint';
import type { BookingRow } from '../booking/bookingQueries';
import { defaultTemplateFor, fetchNotifyContext, fetchStageTemplates, fetchTemplates, mergeTemplate, sendStageNotice, type MessageTemplate, type NotifyContext, type StageDef } from './processQueries';

// ========================================================================
// 訂單處理 → 訊息發送：只針對這一筆訂單的客人。跟「訊息發送」頁同一套範本與變數，
// 差別是收件人固定、範本預設帶這一關的（可換、可臨時改字）、右側即時預覽；
// 按「發送」先跳確認框（收件人、官方帳號、最終文字、剩餘額度），再真的推播。
// ========================================================================

export default function NotifyDialog({ open, stage, booking, onClose, onSent }: {
  open: boolean; stage: StageDef; booking: BookingRow; onClose: () => void; onSent: (text: string) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { isMobile } = useBreakpoint();
  const vars = useTemplateVariables('message');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>('');
  const [body, setBody] = useState('');
  const [ctx, setCtx] = useState<NotifyContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(null); setConfirming(false);
    Promise.all([fetchTemplates(), fetchStageTemplates(), fetchNotifyContext(booking.id)])
      .then(([tpls, map, context]) => {
        if (cancelled) return;
        setTemplates(tpls); setCtx(context);
        const def = defaultTemplateFor(stage, tpls, map);
        setTemplateId(def?.id || ''); setBody(def?.body || '');
      })
      .catch((e) => { if (!cancelled) setError(e.message || '載入失敗'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, booking.id, stage]);

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setBody(t.body);
  };

  const preview = useMemo(() => (ctx ? mergeTemplate(body, ctx.fields) : body), [body, ctx]);
  const templateTitle = templates.find((t) => t.id === templateId)?.title || null;
  const bodyChanged = !!templateId && templates.find((t) => t.id === templateId)?.body !== body;

  const send = async () => {
    setSending(true);
    try {
      const res = await sendStageNotice(booking.id, stage.key, body, bodyChanged ? (templateTitle ? `${templateTitle}（已修改）` : null) : templateTitle);
      enqueueSnackbar(`已發送給 ${booking.name || booking.nickname || '客人'}`, { variant: 'success' });
      onSent(res.text);
    } catch (e: any) {
      enqueueSnackbar(`發送失敗：${e.message}`, { variant: 'error' });
      setConfirming(false);
    } finally { setSending(false); }
  };

  return (
    <Dialog open={open} onClose={sending ? undefined : onClose} maxWidth="md" fullWidth fullScreen={isMobile}>
      <DialogTitle>
        訊息發送
        <Typography variant="body2" color="text.secondary">{booking.order_number}・{booking.name || booking.nickname || '未取得姓名'}・{stage.title}</Typography>
      </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Stack spacing={1.5}><Skeleton height={40} /><Skeleton variant="rounded" height={200} /></Stack>
        ) : error ? (
          <Alert severity="error">{error}</Alert>
        ) : confirming ? (
          <Stack spacing={2}>
            <Alert severity="warning">確認後會立刻用 LINE 推播給客人，無法收回。</Alert>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.5 }}>
              <Box><Typography variant="caption" color="text.secondary">收件人</Typography><Typography variant="body2">{booking.name || '—'}{ctx?.nickname ? `（LINE：${ctx.nickname}）` : ''}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">官方帳號</Typography><Typography variant="body2">{ctx?.channelName || '客戶用帳號'}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">範本</Typography><Typography variant="body2">{templateTitle || '自訂內容'}{bodyChanged ? '（已修改）' : ''}</Typography></Box>
              <Box><Typography variant="caption" color="text.secondary">剩餘額度</Typography><Typography variant="body2">{ctx?.quota ? (ctx.quota.remaining == null ? '無上限' : `${ctx.quota.remaining} 則`) : '—'}</Typography></Box>
            </Box>
            <Paper variant="outlined" sx={{ p: 2, bgcolor: '#f0fdf4', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.7 }}>{preview}</Paper>
          </Stack>
        ) : (
          <Stack spacing={2}>
            {!ctx?.hasLine && <Alert severity="warning">這筆訂單沒有 LINE 帳號（第三方平台或手動建立），無法推播，只能預覽。</Alert>}
            <TextField select size="small" label="範本" value={templateId} onChange={(e) => pickTemplate(e.target.value)} sx={{ maxWidth: 360 }} helperText={templates.length ? '可換範本，也可以直接改下面的內容' : '還沒有任何範本，請先到「訊息發送」建立'}>
              {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.title}</MenuItem>)}
            </TextField>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 2, alignItems: 'start' }}>
              <Box>
                <Typography variant="subtitle2" gutterBottom>內容</Typography>
                <MessageTemplateEditor value={body} onChange={setBody} placeholders={vars.placeholders} placeholderGroups={vars.placeholderGroups} rows={12} placeholder="輸入訊息內容，或點下方變數插入" />
              </Box>
              <Box>
                <Typography variant="subtitle2" gutterBottom>預覽（變數已代入）</Typography>
                <Paper variant="outlined" sx={{ p: 2, minHeight: 200, bgcolor: '#f0fdf4', whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.7 }}>{preview || '（沒有內容）'}</Paper>
              </Box>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {confirming ? (
          <>
            <Button onClick={() => setConfirming(false)} disabled={sending}>返回修改</Button>
            <Button variant="contained" startIcon={<Send size={16} />} onClick={send} disabled={sending}>{sending ? '發送中…' : '確認發送'}</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>{loading ? '取消' : '關閉'}</Button>
            <Button variant="contained" startIcon={<Send size={16} />} onClick={() => setConfirming(true)} disabled={loading || !!error || !ctx?.hasLine || !body.trim()}>發送</Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

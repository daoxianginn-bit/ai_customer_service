import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Box, Button, Grid, IconButton, Link, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { useSnackbar } from 'notistack';
import { ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import { addDaysIso, formatDate, formatMoney, todayIso } from '../../lib/format';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import { fetchLaundrySheet, type LaundrySheet } from './housekeepingQueries';

// ========================================================================
// 洗滌（V2 §4.5）：某一天入住的訂單要用到的布巾加總＝當天要交給洗滌廠的單子。
// 口徑跟排程「入住日轉入住中」自動發的洗滌單一致（同樣用洗滌單簡稱）；這頁是給人工核對／補發用。
// ========================================================================

export default function LaundryPage() {
  const { enqueueSnackbar } = useSnackbar();
  const [params, setParams] = useSearchParams();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') || '') ? params.get('date')! : todayIso();
  const setDate = (d: string) => { const n = new URLSearchParams(params); if (d === todayIso()) n.delete('date'); else n.set('date', d); setParams(n, { replace: true }); };

  const [sheet, setSheet] = useState<LaundrySheet | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError(''); setSheet(null);
    try { setSheet(await fetchLaundrySheet(date)); } catch (e: any) { setError(e.message || '載入失敗'); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  const copy = async () => {
    if (!sheet) return;
    try { await navigator.clipboard.writeText(sheet.text); enqueueSnackbar('已複製洗滌單', { variant: 'success' }); } catch { enqueueSnackbar('複製失敗，請手動選取文字', { variant: 'error' }); }
  };

  return (
    <Box>
      <PageHeaderV2 />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <IconButton size="small" onClick={() => setDate(addDaysIso(date, -1))} aria-label="前一天"><ChevronLeft size={18} /></IconButton>
        <TextField size="small" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} label="入住日" InputLabelProps={{ shrink: true }} />
        <IconButton size="small" onClick={() => setDate(addDaysIso(date, 1))} aria-label="後一天"><ChevronRight size={18} /></IconButton>
        {date !== todayIso() && <Button size="small" color="inherit" onClick={() => setDate(todayIso())}>今天</Button>}
      </Stack>

      {error && <ResultState status={500} description={error} onRetry={load} backTo={false} />}
      {!error && !sheet && <Skeleton variant="rounded" height={240} />}
      {sheet && (
        <Grid container spacing={2} alignItems="flex-start">
          <Grid item xs={12} md={5}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2">洗滌單・{formatDate(date)}</Typography>
                <Button size="small" variant="outlined" color="inherit" startIcon={<Copy size={14} />} onClick={copy} disabled={sheet.items.length === 0}>複製</Button>
              </Stack>
              {sheet.items.length === 0 ? (
                <Typography variant="body2" color="text.secondary">這天入住的訂單沒有布巾用量。到訂單頁勾選房間就會依預設組合帶出用量。</Typography>
              ) : (
                <>
                  <Table size="small">
                    <TableHead><TableRow><TableCell>品項（洗滌單簡稱）</TableCell><TableCell align="right">件數</TableCell><TableCell align="right">金額</TableCell></TableRow></TableHead>
                    <TableBody>
                      {sheet.items.map((it) => (
                        <TableRow key={it.id}>
                          <TableCell>{it.name}{it.name !== it.fullName && <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>（{it.fullName}）</Typography>}</TableCell>
                          <TableCell align="right">{it.quantity}</TableCell>
                          <TableCell align="right">{it.unitPrice != null ? formatMoney(it.quantity * it.unitPrice, { withCurrency: false }) : '—'}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }}>合計</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{sheet.totalPieces}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{formatMoney(sheet.totalCost, { withCurrency: false })}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>排程「入住日轉入住中」若有設定洗滌單範本，會在入住日自動把同一份發到 LINE 群組。</Typography>
                </>
              )}
            </Paper>
          </Grid>
          <Grid item xs={12} md={7}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1.5 }}>這天入住的訂單（{sheet.bookings.length}）</Typography>
              {sheet.bookings.length === 0 ? <Typography variant="body2" color="text.secondary">沒有已鎖房的入住。</Typography> : (
                <Stack spacing={0.75}>
                  {sheet.bookings.map((b) => (
                    <Stack key={b.id} direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                      <Box sx={{ minWidth: 0 }}>
                        <Link component={RouterLink} to={`/bookings/${b.id}`} variant="body2" underline="hover" sx={{ fontWeight: 600 }}>{b.name || b.nickname || '未取得'}</Link>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }} noWrap>
                          {b.rooms.length ? b.rooms.join('、') : b.whole_house ? '包棟（未勾選房間）' : b.room_type_label || '房型未定'}{b.nights ? `・${b.nights} 晚` : ''}{b.headcount ? `・${b.headcount} 人` : ''}
                        </Typography>
                      </Box>
                      <Typography variant="body2" sx={{ flexShrink: 0 }} color={b.pieces ? 'text.primary' : 'text.disabled'}>{b.pieces} 件</Typography>
                    </Stack>
                  ))}
                </Stack>
              )}
            </Paper>
          </Grid>
        </Grid>
      )}
    </Box>
  );
}

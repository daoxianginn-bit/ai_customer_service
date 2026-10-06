import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ClipboardCopy, X } from 'lucide-react';
import { BATCH_COLUMNS, BATCH_TEMPLATE_HEADER, parseBatchBookings } from './batchImport';
import { createBookingsBatch } from './bookingActions';
import { fetchMoneyDefaults, fetchRooms, fetchLinenSetup } from './bookingQueries';
import { computeUsage, normalizeChangeCount, type LinenItem, type RoomLinenDefault } from '../../lib/linenCost';
import type { RoomOption } from '../../lib/rooms';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';

// ========================================================================
// 批次新建訂單：把試算表裡的一整塊貼進來，一次建好多張訂單。
//
// 只給有「管理系統設定」權限的人（開關在 BookingListPage）。一次寫入幾十張訂單，
// 弄錯要一筆一筆刪回去，不是日常客服該碰的工具。
//
// 流程刻意是「貼上 → 看預覽 → 才建立」：解析結果每一列都先標出 OK 或哪裡有問題，
// 確認過才送出。有問題的列不會被建立，也不會擋住其他列。
// ========================================================================

export default function BatchCreateDialog({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (count: number) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const [text, setText] = useState('');
  const [money, setMoney] = useState({ wholeHouseSecurity: 3000, percent: 30 });
  const [rooms, setRooms] = useState<RoomOption[]>([]);
  const [linen, setLinen] = useState<{ items: LinenItem[]; defaults: RoomLinenDefault[] }>({ items: [], defaults: [] });
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ created: number; failed: { lineNo: number; error: string }[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    setText('');
    setResult(null);
    fetchMoneyDefaults().then(setMoney);
    fetchRooms().then(setRooms);
    fetchLinenSetup().then((s) => setLinen({ items: s.items, defaults: s.defaults }));
  }, [open]);

  const parsed = useMemo(
    () => (text.trim()
      ? parseBatchBookings(text, { depositPercent: money.percent, wholeHouseSecurity: money.wholeHouseSecurity, rooms })
      : { rows: [], problems: [] }),
    [text, money, rooms]
  );

  const okRows = parsed.rows.filter((r) => r.payload);
  const badRows = parsed.rows.filter((r) => !r.payload);

  const copyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(BATCH_TEMPLATE_HEADER);
      enqueueSnackbar('標題列已複製，貼到試算表第一列就能照著填', { variant: 'success' });
    } catch {
      enqueueSnackbar('複製失敗，請手動選取下方的欄位名稱', { variant: 'warning' });
    }
  };

  const submit = async () => {
    if (!okRows.length) return;
    const ok = await confirm({
      title: `確定要建立這 ${okRows.length} 筆訂單嗎？`,
      message: badRows.length
        ? `另外 ${badRows.length} 列有問題，不會被建立。建立後若要取消只能一筆一筆刪除。`
        : '建立後若要取消只能一筆一筆刪除。',
      confirmLabel: `建立 ${okRows.length} 筆`,
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await createBookingsBatch(
        okRows.map((r) => ({
          lineNo: r.lineNo,
          payload: r.payload!,
          roomIds: r.roomIds,
          // 布巾預設用量跟人工建單同一個算法；換洗次數批次裡沒有欄位，用 1 次（跟新增訂單的預設一致）。
          usage: r.roomIds.length ? computeUsage(r.roomIds, linen.defaults, normalizeChangeCount(1), linen.items) : [],
        })),
        linen.items.length > 0
      );
      setResult(res);
      if (res.created) onCreated(res.created);
    } catch (e: any) {
      enqueueSnackbar(`批次建立失敗：${e.message}`, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pr: 1 }}>
        <span>批次新建訂單</span>
        <IconButton aria-label="關閉" onClick={onClose} disabled={saving} size="small"><X size={18} /></IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ bgcolor: 'background.default' }}>
        <Stack spacing={2}>
          <Alert severity="info">
            從 Excel／Google 試算表直接整塊複製貼上即可（第一列是欄位名稱）。
            <strong>欄位順序不用照著排、用不到的欄位可以不放</strong>，程式認的是欄位名稱。
          </Alert>

          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="subtitle2">可用欄位</Typography>
              <Button size="small" startIcon={<ClipboardCopy size={15} />} onClick={copyTemplate}>複製標題列</Button>
            </Stack>
            <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75}>
              {BATCH_COLUMNS.map((c) => (
                <Tooltip key={c.key} title={c.hint || ''}>
                  <Chip
                    size="small"
                    label={c.required ? `${c.key}＊` : c.key}
                    color={c.required ? 'primary' : 'default'}
                    variant={c.required ? 'filled' : 'outlined'}
                  />
                </Tooltip>
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
              ＊為必填。滑鼠移到欄位上可以看格式說明。
            </Typography>
          </Box>

          <TextField
            fullWidth
            multiline
            minRows={6}
            maxRows={14}
            label="貼上內容"
            value={text}
            onChange={(e) => { setText(e.target.value); setResult(null); }}
            placeholder={`入住日期\t退房日期\t狀態\t客戶姓名\t人數\t房價\n2026-11-01\t2026-11-03\t已預定\t王小明\t8\t17000`}
            inputProps={{ style: { fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre' } }}
          />

          {parsed.problems.map((p) => <Alert key={p} severity="warning">{p}</Alert>)}

          {parsed.rows.length > 0 && (
            <Box>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <Typography variant="subtitle2">預覽</Typography>
                <Chip size="small" color="success" label={`可建立 ${okRows.length} 筆`} />
                {badRows.length > 0 && <Chip size="small" color="error" label={`有問題 ${badRows.length} 筆`} />}
              </Stack>
              <Box sx={{ maxHeight: 320, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>列</TableCell>
                      <TableCell>入住 → 退房</TableCell>
                      <TableCell>客戶</TableCell>
                      <TableCell>房型</TableCell>
                      <TableCell>狀態</TableCell>
                      <TableCell align="right">總額</TableCell>
                      <TableCell>檢查結果</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {parsed.rows.map((r) => (
                      <TableRow key={r.lineNo} sx={r.errors.length ? { bgcolor: 'error.lighter' } : undefined}>
                        <TableCell>{r.lineNo}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          {r.display.checkin} → {r.display.checkout}
                          {r.display.nights != null && <Typography variant="caption" color="text.secondary"> （{r.display.nights} 晚）</Typography>}
                        </TableCell>
                        <TableCell>{r.display.name}</TableCell>
                        <TableCell>{r.display.rooms}</TableCell>
                        <TableCell>{r.display.statusLabel}</TableCell>
                        <TableCell align="right">{r.display.total == null ? '—' : r.display.total.toLocaleString()}</TableCell>
                        <TableCell>
                          {r.errors.length
                            ? <Typography variant="caption" color="error">{r.errors.join('；')}</Typography>
                            : <Typography variant="caption" color="success.main">OK</Typography>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Box>
          )}

          {result && (
            <Alert severity={result.failed.length ? 'warning' : 'success'}>
              已建立 <strong>{result.created}</strong> 筆訂單。
              {result.failed.length > 0 && (
                <>
                  <br />
                  有 {result.failed.length} 筆寫入失敗：
                  {result.failed.map((f) => `第 ${f.lineNo} 列（${f.error}）`).join('、')}
                </>
              )}
            </Alert>
          )}
        </Stack>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose} disabled={saving}>關閉</Button>
        <Button variant="contained" onClick={submit} disabled={saving || !okRows.length || !!result}>
          {saving ? '建立中…' : `建立 ${okRows.length} 筆`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

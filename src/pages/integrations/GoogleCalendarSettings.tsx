import { useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Link, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { CheckCircle2, XCircle, ClipboardCheck, ExternalLink } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useSettings } from '../../lib/useSettings';
import SettingsShell, { SettingsSection } from '../../components/ui-mui/SettingsShell';
import SecretField from '../../components/ui-mui/SecretField';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';

// ========================================================================
// Google 行事曆（V2 §59）：把房況推送到 Google 行事曆的設定與最近同步狀態。
// 「立即同步」在「自動化排程」的「行事曆整合同步」排程按「立即執行」（§59 的按鈕在那裡實作，
// 這頁不重複做一份會打同一支 Function 的按鈕）。
// ========================================================================

interface OrphanEvent {
  eventId: string;
  summary: string;
  start: string;
  end: string;
  created: string | null;
  htmlLink: string | null;
}

interface MissingBooking {
  bookingId: string;
  orderNumber: string | null;
  name: string | null;
  checkin: string;
  checkout: string;
  status: string;
  reason: string;
}

interface AuditReport {
  orphans: OrphanEvent[];
  missing: MissingBooking[];
  scannedEvents: number;
  ourEvents: number;
  rangeFrom: string;
  rangeTo: string;
  deleted?: number;
  rejected?: number;
  failed?: { eventId: string; error: string }[];
}

export default function GoogleCalendarSettings() {
  const s = useSettings();
  const { settings, handleChange } = s;
  const lastOk = settings?.google_calendar_last_sync_status === 'success';
  const confirm = useConfirm();

  const [busy, setBusy] = useState<'' | 'check' | 'delete'>('');
  const [report, setReport] = useState<AuditReport | null>(null);
  const [auditError, setAuditError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const callAudit = async (payload: Record<string, unknown>): Promise<AuditReport | null> => {
    const { data: sessionData } = await supabase.auth.getSession();
    const res = await fetch('/.netlify/functions/calendar-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionData.session?.access_token}` },
      body: JSON.stringify(payload),
    });
    // 回應本文可能是空的（例如執行被中斷），直接 res.json() 會丟出看不懂的 JSON 解析錯誤。
    const raw = await res.text();
    let data: any = null;
    try { data = raw ? JSON.parse(raw) : null; } catch {}
    if (!res.ok || !data) throw new Error(data?.error || `伺服器回應異常（HTTP ${res.status}）`);
    return data as AuditReport;
  };

  const runCheck = async () => {
    setBusy('check');
    setAuditError('');
    try {
      const data = await callAudit({ action: 'check' });
      setReport(data);
      // 預設全部勾起來：會被列出來的都是已經確認沒有訂單對應的事件，
      // 讓使用者「取消不想刪的」比「一個一個勾」合理。
      setPicked(new Set((data?.orphans || []).map((o) => o.eventId)));
    } catch (e: any) {
      setReport(null);
      setAuditError(e.message);
    } finally {
      setBusy('');
    }
  };

  const runDelete = async () => {
    const ids = Array.from(picked);
    if (!ids.length) return;
    const ok = await confirm({
      title: `確定要從 Google 行事曆刪除這 ${ids.length} 筆事件嗎？`,
      message: '這些事件在訂單清單裡已經沒有對應的訂單，刪除後不影響任何訂單資料。Google 行事曆上的刪除無法復原。',
      confirmLabel: '刪除',
      danger: true,
    });
    if (!ok) return;

    setBusy('delete');
    setAuditError('');
    try {
      const data = await callAudit({ action: 'delete', eventIds: ids });
      setReport(data);
      setPicked(new Set((data?.orphans || []).map((o) => o.eventId)));
    } catch (e: any) {
      setAuditError(e.message);
    } finally {
      setBusy('');
    }
  };

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const orphans = report?.orphans || [];
  const allPicked = orphans.length > 0 && orphans.every((o) => picked.has(o.eventId));

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

          <SettingsSection
            title="行事曆對帳"
            description="比對 Google 行事曆上實際有哪些事件、跟訂單清單對不對得起來。只檢查，不會自動改任何東西；要刪什麼由你勾選後確認。"
            action={
              <Button
                variant="outlined"
                startIcon={busy === 'check' ? <CircularProgress size={16} /> : <ClipboardCheck size={18} />}
                onClick={runCheck}
                disabled={!!busy}
              >
                檢查行事曆
              </Button>
            }
          >
            <Stack spacing={2}>
              <Alert severity="info">
                訂單被刪除時，它在 Google 行事曆上的事件不會跟著消失，會變成沒有訂單對應的「殘留事件」——
                同一段日期之後再建新訂單，畫面上看起來就是重複。這裡列出來的就是這種事件。
                <br />
                判斷依據是事件的建立者：只有<strong>服務帳號建立的事件</strong>會被列入，你自己在 Google 日曆上手動加的行程不會被碰到。
              </Alert>

              {auditError && <Alert severity="error">{auditError}</Alert>}

              {report && (
                <>
                  <Alert severity={orphans.length || report.missing.length ? 'warning' : 'success'}>
                    比對範圍 {report.rangeFrom} ~ {report.rangeTo}：
                    掃描 {report.scannedEvents} 個事件，其中系統建立的有 {report.ourEvents} 個。
                    {report.deleted != null && <> 本次已刪除 <strong>{report.deleted}</strong> 筆。</>}
                    {report.rejected ? <> 有 {report.rejected} 筆因為狀態已改變而未刪除，請重新檢查。</> : null}
                    <br />
                    殘留事件 <strong>{orphans.length}</strong> 筆、漏推訂單 <strong>{report.missing.length}</strong> 筆。
                    {!orphans.length && !report.missing.length && ' 行事曆跟訂單清單一致。'}
                  </Alert>

                  {report.failed?.length ? (
                    <Alert severity="error">
                      有 {report.failed.length} 筆刪除失敗：{report.failed.map((f) => f.error).join('；')}
                    </Alert>
                  ) : null}

                  {orphans.length > 0 && (
                    <Box>
                      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                        <Typography variant="subtitle2">殘留事件（行事曆上有、訂單清單沒有）</Typography>
                        <Button size="small" onClick={() => setPicked(allPicked ? new Set() : new Set(orphans.map((o) => o.eventId)))}>
                          {allPicked ? '全部取消' : '全部勾選'}
                        </Button>
                        <Box sx={{ flex: 1 }} />
                        <Button
                          variant="contained"
                          color="error"
                          size="small"
                          onClick={runDelete}
                          disabled={!!busy || picked.size === 0}
                          startIcon={busy === 'delete' ? <CircularProgress size={14} color="inherit" /> : undefined}
                        >
                          刪除勾選的 {picked.size} 筆
                        </Button>
                      </Stack>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell padding="checkbox" />
                            <TableCell>日期</TableCell>
                            <TableCell>事件標題</TableCell>
                            <TableCell>建立時間</TableCell>
                            <TableCell />
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {orphans.map((o) => (
                            <TableRow key={o.eventId} hover>
                              <TableCell padding="checkbox">
                                <Checkbox size="small" checked={picked.has(o.eventId)} onChange={() => toggle(o.eventId)} />
                              </TableCell>
                              <TableCell sx={{ whiteSpace: 'nowrap' }}>{o.start} ~ {o.end}</TableCell>
                              <TableCell>{o.summary}</TableCell>
                              <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                {o.created ? new Date(o.created).toLocaleString('zh-TW') : '—'}
                              </TableCell>
                              <TableCell>
                                {o.htmlLink && (
                                  <Link href={o.htmlLink} target="_blank" rel="noopener noreferrer" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                                    開啟<ExternalLink size={13} />
                                  </Link>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Box>
                  )}

                  {report.missing.length > 0 && (
                    <Box>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>漏推訂單（訂單在佔用中、行事曆上找不到）</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                        這些不用在這裡處理，下一次「行事曆整合同步」排程執行時會自動補推上去。列出來是為了讓你知道差異在哪一邊。
                      </Typography>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>日期</TableCell>
                            <TableCell>訂單</TableCell>
                            <TableCell>原因</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {report.missing.map((m) => (
                            <TableRow key={m.bookingId}>
                              <TableCell sx={{ whiteSpace: 'nowrap' }}>{m.checkin} ~ {m.checkout}</TableCell>
                              <TableCell>{[m.orderNumber, m.name].filter(Boolean).join(' ') || m.bookingId}</TableCell>
                              <TableCell>{m.reason}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Box>
                  )}
                </>
              )}
            </Stack>
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

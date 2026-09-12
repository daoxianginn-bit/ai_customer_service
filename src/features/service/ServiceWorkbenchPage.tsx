import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import {
  Alert, Avatar, Box, Button, Chip, Collapse, Divider, Drawer, IconButton, InputAdornment, Link, Paper, Skeleton, Stack, TextField,
  Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ArrowLeft, Bot, Info, PanelRightOpen, RefreshCw, Search, Send, UserCheck, X } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { hasPermission } from '../../app/permissions';
import { useBreakpoint } from '../../app/useBreakpoint';
import { formatDateRange, formatDateTime, formatMoney, formatRelative, formatTime } from '../../lib/format';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import type { BookingRow } from '../booking/bookingQueries';
import {
  FILTER_OPTIONS, SESSION_PHASE_LABEL, SOURCE_LABEL, fetchConversationUser, fetchMessages, fetchUserBookings, listConversationUsers,
  parseBookingSession, type ConversationFilter, type ConversationMessage, type ConversationUser, type HandoverLog, type TurnMeta,
} from './serviceQueries';
import { releaseToAi, resolveHandover, sendReply, takeOverConversation } from './serviceActions';

// ========================================================================
// 客服工作台（V2 §28–32、§113、§135）：對話清單｜對話內容｜客戶脈絡 三欄。
//   桌面：三欄並排；平板：清單＋對話，脈絡開右側 Drawer；手機：清單 → 對話兩頁切換。
// AI 的判斷過程不混進對話（§31）：客人訊息旁有「判斷」按鈕，點了在右欄「AI 判斷」展開。
// 選到哪位客人記在網址（?user=），重新整理或分享連結會回到同一段對話。
// ========================================================================

const LIST_WIDTH = 300;
const CONTEXT_WIDTH = 320;
const REFRESH_MS = 15000;

function userLabel(u: { nickname?: string | null; line_user_id: string }) {
  return u.nickname || u.line_user_id;
}

function userModeBadge(u: ConversationUser) {
  if (u.is_human_mode) return <StatusBadge label="真人" tone="success" dot={false} sx={{ height: 20, fontSize: 11 }} />;
  if (u.openHandover) return <StatusBadge label="待人工" tone="warning" dot={false} sx={{ height: 20, fontSize: 11 }} />;
  return <StatusBadge label="AI" tone="neutral" dot={false} sx={{ height: 20, fontSize: 11 }} />;
}

// ---------------------------------------------------------------- 左欄：清單
function ConversationList({ filter, onFilter, keyword, onKeyword, onSearch, users, loading, hasMore, onMore, selectedId, onSelect, counts, onRefresh }: {
  filter: ConversationFilter; onFilter: (f: ConversationFilter) => void;
  keyword: string; onKeyword: (v: string) => void; onSearch: () => void;
  users: ConversationUser[]; loading: boolean; hasMore: boolean; onMore: () => void;
  selectedId: string | null; onSelect: (u: ConversationUser) => void;
  counts: Partial<Record<ConversationFilter, number>>; onRefresh: () => void;
}) {
  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack spacing={1} sx={{ p: 1.5, pb: 1 }}>
        <Stack direction="row" spacing={0.75} sx={{ overflowX: 'auto', '&::-webkit-scrollbar': { display: 'none' } }}>
          {FILTER_OPTIONS.map((o) => {
            const n = counts[o.value];
            return (
              <Tooltip key={o.value} title={o.hint}>
                <Chip size="small" clickable label={n ? `${o.label} ${n}` : o.label}
                  color={filter === o.value ? 'primary' : 'default'} variant={filter === o.value ? 'filled' : 'outlined'}
                  onClick={() => onFilter(o.value)} sx={{ flexShrink: 0, ...(o.value === 'handover' && n && filter !== 'handover' ? { borderColor: 'warning.main', color: 'warning.dark' } : {}) }} />
              </Tooltip>
            );
          })}
        </Stack>
        <Stack direction="row" spacing={0.5} component="form" onSubmit={(e) => { e.preventDefault(); onSearch(); }}>
          <TextField size="small" fullWidth placeholder="搜尋暱稱或 LINE ID" value={keyword} onChange={(e) => onKeyword(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search size={14} /></InputAdornment> }} />
          <Tooltip title="重新整理"><IconButton size="small" onClick={onRefresh} aria-label="重新整理"><RefreshCw size={16} /></IconButton></Tooltip>
        </Stack>
      </Stack>
      <Divider />
      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {loading && users.length === 0 && [0, 1, 2, 3].map((i) => (
          <Stack key={i} direction="row" spacing={1.5} sx={{ p: 1.5 }}><Skeleton variant="circular" width={40} height={40} /><Box sx={{ flex: 1 }}><Skeleton width="60%" /><Skeleton width="90%" /></Box></Stack>
        ))}
        {!loading && users.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ p: 3, textAlign: 'center' }}>{filter === 'handover' ? '沒有等待處理的轉接' : '沒有符合的客人'}</Typography>
        )}
        {users.map((u) => {
          const active = u.line_user_id === selectedId;
          const last = u.lastMessage;
          return (
            <Stack
              key={u.line_user_id}
              direction="row" spacing={1.25} alignItems="flex-start"
              onClick={() => onSelect(u)}
              sx={{ p: 1.5, cursor: 'pointer', bgcolor: active ? 'primary.light' : 'transparent', borderLeft: '3px solid', borderLeftColor: active ? 'primary.main' : 'transparent', '&:hover': { bgcolor: active ? 'primary.light' : 'grey.50' } }}
            >
              <Avatar src={u.avatar_url || undefined} sx={{ width: 40, height: 40, fontSize: 14 }}>{(u.nickname || '?').slice(0, 1)}</Avatar>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{userLabel(u)}</Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>{formatRelative(last?.created_at || u.last_message_at)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ mt: 0.25 }}>
                  <Typography variant="caption" color="text.secondary" noWrap sx={{ flex: 1 }}>
                    {last ? `${last.direction === 'outbound' ? (SOURCE_LABEL[last.source] || last.source) + '：' : ''}${last.content}` : '（尚無對話）'}
                  </Typography>
                  {userModeBadge(u)}
                </Stack>
              </Box>
            </Stack>
          );
        })}
        {hasMore && <Button fullWidth size="small" color="inherit" onClick={onMore} disabled={loading}>載入更多</Button>}
      </Box>
    </Stack>
  );
}

// ---------------------------------------------------------------- 中欄：對話
function Bubble({ m, selected, onInspect }: { m: ConversationMessage; selected: boolean; onInspect?: () => void }) {
  const inbound = m.direction === 'inbound';
  if (m.source === 'system' && !inbound) {
    // 系統訊息（制式回覆、轉接通知）：置中的小字，不當成 AI 或真人的話
    return (
      <Stack alignItems="center" sx={{ my: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ bgcolor: 'grey.100', px: 1.5, py: 0.5, borderRadius: 999, maxWidth: '85%', textAlign: 'center' }}>{m.content}</Typography>
      </Stack>
    );
  }
  const human = m.source === 'human_agent';
  return (
    <Stack alignItems={inbound ? 'flex-start' : 'flex-end'} sx={{ my: 0.5 }}>
      <Stack direction={inbound ? 'row' : 'row-reverse'} alignItems="flex-end" spacing={0.5} sx={{ maxWidth: '85%' }}>
        <Box sx={{
          px: 1.5, py: 1, borderRadius: 2,
          borderBottomLeftRadius: inbound ? 4 : 16, borderBottomRightRadius: inbound ? 16 : 4,
          bgcolor: inbound ? 'grey.100' : human ? 'primary.main' : 'primary.light',
          color: inbound ? 'text.primary' : human ? 'primary.contrastText' : 'primary.dark',
          outline: selected ? '2px solid' : 'none', outlineColor: 'info.main',
        }}>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</Typography>
          <Typography variant="caption" sx={{ display: 'block', mt: 0.5, opacity: 0.75 }}>
            {SOURCE_LABEL[m.source] || m.source} · {formatTime(m.created_at)}
          </Typography>
        </Box>
        {inbound && m.meta && onInspect && (
          <Tooltip title={m.meta.errors?.length ? `查看 AI 判斷（${m.meta.errors.length} 個錯誤）` : '查看 AI 判斷'}>
            <IconButton size="small" onClick={onInspect} sx={{ color: m.meta.errors?.length ? 'error.main' : selected ? 'info.main' : 'text.disabled' }} aria-label="查看 AI 判斷"><Info size={14} /></IconButton>
          </Tooltip>
        )}
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------- 右欄：脈絡
function MetaValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <Typography component="span" variant="caption" color="text.disabled">（空）</Typography>;
  if (typeof value === 'string') return <Typography component="span" variant="caption" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{value}</Typography>;
  if (typeof value === 'number' || typeof value === 'boolean') return <Typography component="span" variant="caption" sx={{ fontFamily: 'monospace' }}>{String(value)}</Typography>;
  if (Array.isArray(value)) return <Typography component="span" variant="caption">{value.length ? value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join('、') : '（無）'}</Typography>;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return <Typography component="span" variant="caption" color="text.disabled">（無）</Typography>;
  return (
    <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 1, rowGap: 0.25, m: 0 }}>
      {entries.map(([k, v]) => (
        <Box key={k} sx={{ display: 'contents' }}>
          <Typography component="dt" variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{k}</Typography>
          <Box component="dd" sx={{ m: 0, minWidth: 0 }}><MetaValue value={v} /></Box>
        </Box>
      ))}
    </Box>
  );
}

const META_SECTION_LABEL: Record<string, string> = { flow: '訂房流程', extracted: '抓到的欄位', ai_extract: 'AI 欄位擷取', ai_chat: 'AI 問答', intent: '意圖判斷' };

function AiDiagnostics({ meta, canSeeRaw }: { meta: TurnMeta | null; canSeeRaw: boolean }) {
  const [showRaw, setShowRaw] = useState(false);
  if (!meta) return <Typography variant="caption" color="text.secondary">點客人訊息旁的 ⓘ 查看那一句的判斷過程。</Typography>;
  const hasError = meta.errors?.length > 0;
  const rawKeys = ['ai_extract', 'ai_chat'];
  const otherKeys = Object.keys(meta).filter((k) => !['elapsed_ms', 'steps', 'errors'].includes(k) && !rawKeys.includes(k));
  const intent = (meta as any).intent;
  return (
    <Stack spacing={1.25}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        {intent && typeof intent === 'object' && (intent as any).intent && <StatusBadge label={`意圖：${(intent as any).intent}`} tone="info" dot={false} />}
        {intent && typeof intent === 'object' && (intent as any).source && <Chip size="small" label={`來源 ${(intent as any).source}`} />}
        <Chip size="small" label={`${meta.elapsed_ms} ms`} />
        {hasError && <StatusBadge label={`${meta.errors.length} 個錯誤`} tone="danger" dot={false} />}
      </Stack>
      {hasError && (
        <Alert severity="error" sx={{ py: 0 }}>
          {meta.errors.map((e, i) => <Typography key={i} variant="caption" sx={{ display: 'block', wordBreak: 'break-word' }}>{e}</Typography>)}
        </Alert>
      )}
      <Box>
        <Typography variant="caption" sx={{ fontWeight: 600 }}>決策過程</Typography>
        {meta.steps?.length ? (
          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
            {meta.steps.map((s, i) => <Typography key={i} component="li" variant="caption" sx={{ wordBreak: 'break-word' }}>{s}</Typography>)}
          </Box>
        ) : <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>（沒有記錄到任何步驟）</Typography>}
      </Box>
      {otherKeys.map((k) => (
        <Box key={k}>
          <Typography variant="caption" sx={{ fontWeight: 600 }}>{META_SECTION_LABEL[k] || k}</Typography>
          <Paper variant="outlined" sx={{ p: 1, mt: 0.5 }}><MetaValue value={meta[k]} /></Paper>
        </Box>
      ))}
      {canSeeRaw && rawKeys.some((k) => meta[k] !== undefined) && (
        <Box>
          <Link component="button" type="button" variant="caption" underline="hover" onClick={() => setShowRaw((v) => !v)}>{showRaw ? '隱藏' : '顯示'} AI 原文（Raw Output）</Link>
          <Collapse in={showRaw}>
            {rawKeys.filter((k) => meta[k] !== undefined).map((k) => (
              <Box key={k} sx={{ mt: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>{META_SECTION_LABEL[k]}</Typography>
                <Paper variant="outlined" sx={{ p: 1, mt: 0.5, maxHeight: 240, overflow: 'auto' }}>
                  <Typography component="pre" variant="caption" sx={{ m: 0, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11 }}>{JSON.stringify(meta[k], null, 2)}</Typography>
                </Paper>
              </Box>
            ))}
          </Collapse>
        </Box>
      )}
    </Stack>
  );
}

function ContextSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{title}</Typography>
      {children}
    </Box>
  );
}

function ContextPane({ user, bookings, selectedMeta, canSeeRaw }: { user: ConversationUser | null; bookings: BookingRow[]; selectedMeta: TurnMeta | null; canSeeRaw: boolean }) {
  if (!user) return null;
  const session = parseBookingSession(user.booking_session);
  return (
    <Stack spacing={2.5} sx={{ p: 2 }}>
      <ContextSection title="客戶">
        <Stack direction="row" spacing={1.25} alignItems="center">
          <Avatar src={user.avatar_url || undefined} sx={{ width: 44, height: 44 }}>{(user.nickname || '?').slice(0, 1)}</Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{user.nickname || '未取得暱稱'}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{user.line_user_id}</Typography>
          </Box>
        </Stack>
        <Stack spacing={0.25} sx={{ mt: 1 }}>
          <Typography variant="caption" color="text.secondary">最近互動：{formatDateTime(user.last_message_at) || '—'}</Typography>
          {user.marketing_opt_out && <Typography variant="caption" color="warning.dark">已拒收行銷訊息</Typography>}
          <Link component={RouterLink} to={`/customers?q=${encodeURIComponent(user.nickname || user.line_user_id)}`} variant="caption" underline="hover">查看客戶資料 →</Link>
        </Stack>
      </ContextSection>

      <ContextSection title="訂單">
        {bookings.length === 0 ? <Typography variant="caption" color="text.secondary">這位客人還沒有訂單。</Typography> : (
          <Stack spacing={0.75}>
            {bookings.map((b) => (
              <Paper key={b.id} variant="outlined" component={RouterLink} to={`/bookings/${b.id}`} sx={{ p: 1, display: 'block', textDecoration: 'none', color: 'inherit' }}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{b.order_number || '—'}</Typography>
                  <StatusBadge status={b.status} sx={{ height: 20, fontSize: 11 }} />
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  {formatDateRange(b.checkin_date, b.checkout_date) || '日期未定'}{b.headcount ? `・${b.headcount} 人` : ''}・{formatMoney(b.total_amount) || '未報價'}
                </Typography>
              </Paper>
            ))}
          </Stack>
        )}
      </ContextSection>

      <ContextSection title="Session（訂房對話）">
        {!session ? <Typography variant="caption" color="text.secondary">目前沒有進行中的訂房詢問。</Typography> : (
          <Stack spacing={0.5}>
            <StatusBadge label={SESSION_PHASE_LABEL[session.phase] || session.phase} tone={session.phase === 'in_flow' ? 'info' : 'warning'} dot={false} sx={{ alignSelf: 'flex-start' }} />
            {session.collected && Object.keys(session.collected).length > 0 && (
              <Paper variant="outlined" sx={{ p: 1 }}><MetaValue value={session.collected} /></Paper>
            )}
            {session.bookingId && <Link component={RouterLink} to={`/bookings/${session.bookingId}`} variant="caption" underline="hover">對應訂單 →</Link>}
            <Typography variant="caption" color="text.secondary">更新於 {formatRelative(session.updatedAt)}</Typography>
          </Stack>
        )}
      </ContextSection>

      <ContextSection title="AI 判斷">
        <AiDiagnostics meta={selectedMeta} canSeeRaw={canSeeRaw} />
      </ContextSection>
    </Stack>
  );
}

// ---------------------------------------------------------------- 頁面
export default function ServiceWorkbenchPage() {
  const { role, profile } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile, isDesktop } = useBreakpoint();
  const canReply = hasPermission(role, 'service.reply');
  const canHandover = hasPermission(role, 'service.handover');
  const canSeeRaw = role === 'admin';

  const [params, setParams] = useSearchParams();
  const selectedId = params.get('user');
  const filterParam = params.get('filter');
  const filter: ConversationFilter = (FILTER_OPTIONS.some((o) => o.value === filterParam) ? filterParam : 'all') as ConversationFilter;

  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [users, setUsers] = useState<ConversationUser[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [openHandovers, setOpenHandovers] = useState<HandoverLog[]>([]);
  const [humanCount, setHumanCount] = useState(0);

  const [current, setCurrent] = useState<ConversationUser | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgHasMore, setMsgHasMore] = useState(false);
  const [bookings, setBookings] = useState<BookingRow[]>([]);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const setFilter = (f: ConversationFilter) => {
    const n = new URLSearchParams(params);
    if (f === 'all') n.delete('filter'); else n.set('filter', f);
    setParams(n, { replace: true });
  };
  const selectUser = (id: string | null) => {
    const n = new URLSearchParams(params);
    if (id) n.set('user', id); else n.delete('user');
    setParams(n, { replace: !id });
  };

  const loadList = useCallback(async (pageIndex: number, opts?: { silent?: boolean; append?: boolean }) => {
    if (!opts?.silent) setListLoading(true);
    setListError('');
    try {
      const res = await listConversationUsers({ filter, keyword: appliedKeyword, page: pageIndex });
      setUsers((prev) => (opts?.append ? [...prev, ...res.users] : res.users));
      setHasMore(res.hasMore);
      setOpenHandovers(res.openHandovers);
      setPage(pageIndex);
      // 真人服務中的人數：清單不一定包含全部，另外輕量算一次
      setHumanCount(res.users.filter((u) => u.is_human_mode).length);
    } catch (e: any) {
      setListError(e.message || '載入失敗');
    } finally {
      setListLoading(false);
    }
  }, [filter, appliedKeyword]);

  useEffect(() => { loadList(0); }, [loadList]);

  const loadConversation = useCallback(async (id: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) { setMsgLoading(true); setMessages([]); setSelectedTurnId(null); }
    try {
      const [u, m, b] = await Promise.all([fetchConversationUser(id), fetchMessages(id), fetchUserBookings(id)]);
      setCurrent(u);
      setMessages((prev) => {
        if (!opts?.silent) return m.messages;
        // 背景刷新：只接上新的訊息，不打掉使用者已載入的更早段落
        const known = new Set(prev.map((x) => x.id));
        const fresh = m.messages.filter((x) => !known.has(x.id));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      if (!opts?.silent) setMsgHasMore(m.hasMore);
      setBookings(b);
      if (!opts?.silent) {
        const lastWithMeta = [...m.messages].reverse().find((x) => x.direction === 'inbound' && x.meta);
        setSelectedTurnId(lastWithMeta?.id || null);
      }
    } finally {
      setMsgLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadConversation(selectedId);
    else { setCurrent(null); setMessages([]); setBookings([]); }
  }, [selectedId, loadConversation]);

  // 捲到最底：新訊息進來或剛載入時
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, selectedId]);

  // 每 15 秒背景刷新清單與目前對話（分頁在背景時不查）
  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    loadList(0, { silent: true });
    if (selectedId) loadConversation(selectedId, { silent: true });
  };
  useEffect(() => {
    const t = setInterval(() => refreshRef.current(), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const loadEarlier = async () => {
    if (!selectedId || !messages.length) return;
    const res = await fetchMessages(selectedId, messages[0].created_at);
    setMessages((prev) => [...res.messages, ...prev]);
    setMsgHasMore(res.hasMore);
  };

  const counts = useMemo<Partial<Record<ConversationFilter, number>>>(() => ({ handover: openHandovers.length || undefined, human: humanCount || undefined }), [openHandovers, humanCount]);

  const act = async (fn: () => Promise<void>, okText: string) => {
    setBusy(true);
    try {
      await fn();
      enqueueSnackbar(okText, { variant: 'success' });
      await Promise.all([loadList(0, { silent: true }), selectedId ? loadConversation(selectedId, { silent: true }) : Promise.resolve()]);
    } catch (e: any) {
      enqueueSnackbar(`操作失敗：${e.message}`, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const takeOver = () => current && act(() => takeOverConversation(current.line_user_id, current.channel_id), '已接手，AI 暫停回覆');
  const release = async () => {
    if (!current) return;
    const ok = await confirm({ title: '轉回 AI 接手', message: `${userLabel(current)} 之後的訊息會由 AI 回覆，這次的轉接紀錄會標成已處理。`, confirmLabel: '轉回 AI' });
    if (ok) act(() => releaseToAi(current.line_user_id), '已轉回 AI 接手');
  };
  const markResolved = () => current?.openHandover && act(() => resolveHandover(current.openHandover!.id), '已標記為處理完成');

  const submitReply = async () => {
    if (!current || !draft.trim()) return;
    setSending(true);
    try {
      await sendReply(current.line_user_id, current.channel_id, draft.trim());
      setDraft('');
      await loadConversation(current.line_user_id, { silent: true });
      setCurrent((c) => (c ? { ...c, is_human_mode: true } : c));
    } catch (e: any) {
      enqueueSnackbar(`傳送失敗：${e.message}`, { variant: 'error' });
    } finally {
      setSending(false);
    }
  };

  const selectedMeta = messages.find((m) => m.id === selectedTurnId)?.meta || null;

  // 版面：手機時清單與對話二選一（§135 Page 1／Page 2）
  const showList = !isMobile || !selectedId;
  const showChat = !isMobile || !!selectedId;

  const chatHeader = current && (
    <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider', minHeight: 56 }}>
      {isMobile && <IconButton size="small" onClick={() => selectUser(null)} aria-label="回清單"><ArrowLeft size={18} /></IconButton>}
      <Avatar src={current.avatar_url || undefined} sx={{ width: 32, height: 32, fontSize: 13 }}>{(current.nickname || '?').slice(0, 1)}</Avatar>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>{userLabel(current)}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
          {current.is_human_mode ? `真人模式・AI 暫停${current.last_human_interaction ? `・${formatRelative(current.last_human_interaction)}` : ''}` : current.openHandover ? `喊了「${current.openHandover.triggered_keyword || '找真人'}」・${formatRelative(current.openHandover.started_at)}` : 'AI 服務中'}
        </Typography>
      </Box>
      {canHandover && !current.is_human_mode && (
        <Button size="small" variant="contained" startIcon={<UserCheck size={14} />} onClick={takeOver} disabled={busy}>{isMobile ? '接手' : '接手對話'}</Button>
      )}
      {canHandover && current.is_human_mode && (
        <Button size="small" variant="outlined" color="inherit" startIcon={<Bot size={14} />} onClick={release} disabled={busy}>{isMobile ? '轉回 AI' : '轉回 AI 接手'}</Button>
      )}
      {canHandover && current.openHandover && !current.is_human_mode && !isMobile && (
        <Tooltip title="已在 LINE 上回過客人，關掉這筆轉接提醒（不改變 AI 回覆）"><Button size="small" color="inherit" onClick={markResolved} disabled={busy}>標記已處理</Button></Tooltip>
      )}
      {!isDesktop && <IconButton size="small" onClick={() => setContextOpen(true)} aria-label="客戶脈絡"><PanelRightOpen size={18} /></IconButton>}
    </Stack>
  );

  const chatBody = (
    <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', px: 2, py: 1.5, minHeight: 0, bgcolor: 'background.default' }}>
      {msgLoading && [0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={44} sx={{ my: 1, width: i % 2 ? '50%' : '70%', ml: i % 2 ? 'auto' : 0 }} />)}
      {!msgLoading && msgHasMore && <Button size="small" color="inherit" fullWidth onClick={loadEarlier}>載入更早的訊息</Button>}
      {!msgLoading && messages.length === 0 && <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 4 }}>沒有對話紀錄（依保留天數設定自動清除）。</Typography>}
      {messages.map((m) => (
        <Bubble key={m.id} m={m} selected={m.id === selectedTurnId} onInspect={m.meta ? () => { setSelectedTurnId(m.id); if (!isDesktop) setContextOpen(true); } : undefined} />
      ))}
    </Box>
  );

  const composer = current && (
    <Box sx={{ p: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
      {current.is_human_mode && (
        <Typography variant="caption" color="success.dark" sx={{ display: 'block', mb: 0.75 }}>
          目前由 {profile?.display_name || profile?.email || '客服'} 處理・AI 回覆：暫停
        </Typography>
      )}
      {canReply ? (
        <Stack direction="row" spacing={1} alignItems="flex-end" component="form" onSubmit={(e) => { e.preventDefault(); submitReply(); }}>
          <TextField
            size="small" fullWidth multiline maxRows={4}
            placeholder={current.is_human_mode ? '輸入回覆，Enter 送出、Shift+Enter 換行' : '送出回覆後會自動接手（AI 暫停）'}
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply(); } }}
            disabled={sending}
          />
          <Button type="submit" variant="contained" disabled={sending || !draft.trim()} sx={{ minWidth: 44, px: 1.5 }} aria-label="送出"><Send size={16} /></Button>
        </Stack>
      ) : (
        <Typography variant="caption" color="text.secondary">你的角色沒有回覆權限；要回客人請用 LINE 官方帳號 App。</Typography>
      )}
    </Box>
  );

  const contextPane = <ContextPane user={current} bookings={bookings} selectedMeta={selectedMeta} canSeeRaw={canSeeRaw} />;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: { xs: 'calc(100vh - 60px - 48px - 16px)', md: 'calc(100vh - 60px - 48px - 48px)' }, minHeight: 480 }}>
      {!isMobile && <PageHeaderV2 />}
      {listError && <ResultState status={500} description={listError} onRetry={() => loadList(0)} backTo={false} />}
      <Paper variant="outlined" sx={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        {showList && (
          <Box sx={{ width: isMobile ? '100%' : LIST_WIDTH, flexShrink: 0, borderRight: isMobile ? 'none' : '1px solid', borderColor: 'divider', minHeight: 0 }}>
            <ConversationList
              filter={filter} onFilter={setFilter}
              keyword={keyword} onKeyword={setKeyword} onSearch={() => setAppliedKeyword(keyword)}
              users={users} loading={listLoading} hasMore={hasMore} onMore={() => loadList(page + 1, { append: true })}
              selectedId={selectedId} onSelect={(u) => selectUser(u.line_user_id)}
              counts={counts} onRefresh={() => loadList(0)}
            />
          </Box>
        )}
        {showChat && (
          <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
            {!selectedId ? (
              <Stack alignItems="center" justifyContent="center" sx={{ flex: 1, color: 'text.secondary', p: 4 }}>
                <Typography variant="body2">從左邊選一位客人，這裡會顯示對話內容。</Typography>
              </Stack>
            ) : (
              <>
                {chatHeader}
                {chatBody}
                {composer}
              </>
            )}
          </Stack>
        )}
        {isDesktop && selectedId && (
          <Box sx={{ width: CONTEXT_WIDTH, flexShrink: 0, borderLeft: '1px solid', borderColor: 'divider', overflowY: 'auto', minHeight: 0 }}>
            {contextPane}
          </Box>
        )}
      </Paper>

      {/* 平板／手機：脈絡欄改成右側 Drawer（§135） */}
      <Drawer anchor="right" open={contextOpen && !isDesktop} onClose={() => setContextOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 360 } } }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2">客戶脈絡</Typography>
          <IconButton size="small" onClick={() => setContextOpen(false)} aria-label="關閉"><X size={18} /></IconButton>
        </Stack>
        <Box sx={{ overflowY: 'auto' }}>{contextPane}</Box>
      </Drawer>
    </Box>
  );
}

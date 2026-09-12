import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { Box, Button, Chip, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { ArrowRight, RefreshCw } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { hasPermission } from '../../app/permissions';
import { useBreakpoint } from '../../app/useBreakpoint';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import StatusBadge from '../../components/ui-mui/StatusBadge';
import ResultState from '../../components/ui-mui/ResultState';
import {
  TASK_TYPE_LABELS, deriveBookingTasks, fetchHandoverTask, fetchSystemErrorTask, fetchTaskBookings, sortTasks, taskStatusHint,
  type Task, type TaskGroup, type TaskSeverity,
} from './taskQueries';

// ========================================================================
// 待辦事項中心（V2 §27）：把所有「要人動手」的事集中成一份清單，依 訂房／客服／系統 分頁籤。
// 資料是推導的（見 taskQueries.ts），沒有「完成」按鈕——處理完對應的訂單狀態一改，待辦自然消失。
// ========================================================================

const GROUP_TABS: { value: 'all' | TaskGroup; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'booking', label: '訂房' },
  { value: 'service', label: '客服' },
  { value: 'system', label: '系統' },
];

const SEVERITY_TONE: Record<TaskSeverity, 'danger' | 'warning' | 'info'> = { critical: 'danger', warning: 'warning', normal: 'info' };
const SEVERITY_LABEL: Record<TaskSeverity, string> = { critical: '緊急', warning: '待處理', normal: '例行' };

export default function TaskCenterPage() {
  const { role } = useAuth();
  const { isMobile } = useBreakpoint();
  const canSeeErrors = hasPermission(role, 'audit.view');
  const [params, setParams] = useSearchParams();
  const group = (GROUP_TABS.some((g) => g.value === params.get('group')) ? params.get('group') : 'all') as 'all' | TaskGroup;
  const typeFilter = params.get('type') || '';

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [booking, handover, sys] = await Promise.all([
        fetchTaskBookings().then(deriveBookingTasks),
        fetchHandoverTask().catch(() => null),
        canSeeErrors ? fetchSystemErrorTask().catch(() => null) : Promise.resolve(null),
      ]);
      setTasks(sortTasks([...booking, ...(handover ? [handover] : []), ...(sys ? [sys] : [])]));
    } catch (e: any) {
      setTasks([]);
      setError(e.message || '載入失敗');
    }
  }, [canSeeErrors]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const t of tasks || []) { c.all++; c[t.group] = (c[t.group] || 0) + 1; c[t.type] = (c[t.type] || 0) + 1; }
    return c;
  }, [tasks]);

  const visible = (tasks || []).filter((t) => (group === 'all' || t.group === group) && (!typeFilter || t.type === typeFilter));
  const typesInGroup = Array.from(new Set((tasks || []).filter((t) => group === 'all' || t.group === group).map((t) => t.type)));

  const setGroup = (g: string) => { const n = new URLSearchParams(); if (g !== 'all') n.set('group', g); setParams(n); };
  const setType = (t: string) => { const n = new URLSearchParams(params); if (t && typeFilter !== t) n.set('type', t); else n.delete('type'); setParams(n); };

  return (
    <Box>
      <PageHeaderV2 secondary={<Button color="inherit" startIcon={<RefreshCw size={16} />} onClick={load}>重新整理</Button>} />

      <Stack direction="row" spacing={1} sx={{ mb: 1.5, overflowX: 'auto', '&::-webkit-scrollbar': { display: 'none' } }}>
        {GROUP_TABS.map((g) => (
          <Chip
            key={g.value}
            label={counts[g.value] ? `${g.label} ${counts[g.value]}` : g.label}
            clickable
            color={group === g.value ? 'primary' : 'default'}
            variant={group === g.value ? 'filled' : 'outlined'}
            onClick={() => setGroup(g.value)}
          />
        ))}
      </Stack>
      {typesInGroup.length > 1 && (
        <Stack direction="row" spacing={0.75} sx={{ mb: 2, overflowX: 'auto', '&::-webkit-scrollbar': { display: 'none' } }}>
          {typesInGroup.map((t) => (
            <Chip key={t} size="small" label={`${TASK_TYPE_LABELS[t]} ${counts[t] || 0}`} clickable
              color={typeFilter === t ? 'primary' : 'default'} variant={typeFilter === t ? 'filled' : 'outlined'} onClick={() => setType(t)} sx={{ flexShrink: 0 }} />
          ))}
        </Stack>
      )}

      {error && <ResultState status={500} description={error} onRetry={load} backTo={false} />}
      {tasks === null && <Stack spacing={1}>{[0, 1, 2, 3].map((i) => <Skeleton key={i} variant="rounded" height={64} />)}</Stack>}
      {tasks !== null && !error && visible.length === 0 && (
        <ResultState status="empty" title="沒有待辦" description="目前沒有需要人工處理的事項。" backTo={false} />
      )}

      <Stack spacing={1}>
        {visible.map((t) => {
          const hint = taskStatusHint(t);
          return (
            <Paper key={t.id} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1.5} alignItems="flex-start">
                <StatusBadge label={SEVERITY_LABEL[t.severity]} tone={SEVERITY_TONE[t.severity]} sx={{ mt: 0.25, flexShrink: 0 }} />
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{t.title}</Typography>
                    {hint && <Typography variant="caption" color="text.secondary">訂單狀態：{hint}</Typography>}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">{t.detail}</Typography>
                  {t.meta && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.meta}</Typography>}
                </Box>
                <Button size="small" variant={t.severity === 'critical' ? 'contained' : 'outlined'} color={t.severity === 'critical' ? 'error' : 'inherit'} component={RouterLink} to={t.href} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                  {isMobile ? <ArrowRight size={16} /> : t.actionLabel}
                </Button>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </Box>
  );
}

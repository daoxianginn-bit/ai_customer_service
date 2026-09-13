import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom';
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, FormControlLabel, IconButton, Link, List, ListItem, ListItemText, Menu, MenuItem, Paper, Radio, RadioGroup,
  Skeleton, Stack, Step, StepLabel, Stepper, Tab, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ChevronLeft, Eye, MoreVertical, Power, Save, Trash2 } from 'lucide-react';
import { usePermissions } from '../../app/PermissionContext';
import { useBreakpoint } from '../../app/useBreakpoint';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { PERMISSION_CATALOG, ROLE_TEMPLATES, permissionDef, permissionName } from '../../app/permissions';
import { formatDateTime } from '../../lib/format';
import { STATUS_LABELS } from '../../lib/permissions';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';
import ResultState from '../../components/ui-mui/ResultState';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';
import PermissionMatrix, { groupByModule, riskCounts } from './PermissionMatrix';
import { LegacyDbAlert } from './RolesPage';
import { fetchGrantable, fetchRbacLogs, fetchRoleUsers, fetchRoles, rolesAdmin, type ChangeLogRow, type RoleRecord, type UserRecord } from './rbacQueries';

// ========================================================================
// 角色編輯器（權限管理 V2 §16–26、§55）。
//   /admin/roles/new  三步驟精靈：基本資料（可從範本或既有角色複製）→ 選擇權限 → 確認建立
//   /admin/roles/:id  頁籤：權限（矩陣＋摘要＋底部儲存列）／使用者／變更紀錄
// 儲存前會列出 新增／移除 的差異；有高風險權限或角色已有使用者時再確認一次（§24）。
// 帶 expected_version 做樂觀鎖：別人先改過就提示重新載入，不會蓋掉對方的修改（§55）。
// ========================================================================

type StartSource = { kind: 'blank' } | { kind: 'template'; code: string } | { kind: 'role'; id: string };

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

function SummaryPanel({ selected, baseline, userCount, compact }: { selected: ReadonlySet<string>; baseline: ReadonlySet<string> | null; userCount: number | null; compact?: boolean }) {
  const rc = riskCounts(selected);
  const added = baseline ? [...selected].filter((c) => !baseline.has(c)) : [];
  const removed = baseline ? [...baseline].filter((c) => !selected.has(c)) : [];
  const highNames = PERMISSION_CATALOG.filter((p) => p.risk === 'high' && selected.has(p.code)).map((p) => p.name);
  if (compact) {
    return (
      <Typography variant="body2" color="text.secondary" noWrap>
        已選 {rc.total} 項{rc.high ? `・高風險 ${rc.high}` : ''}{baseline && (added.length || removed.length) ? `・新增 ${added.length}、移除 ${removed.length}` : ''}
      </Typography>
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom>摘要</Typography>
      <Stack spacing={0.75}>
        <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">已選權限</Typography><Typography variant="body2" fontWeight={600}>{rc.total} / {PERMISSION_CATALOG.length}</Typography></Stack>
        <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">高風險</Typography><Typography variant="body2" color={rc.high ? 'error.main' : 'text.primary'} fontWeight={600}>{rc.high}</Typography></Stack>
        <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">敏感</Typography><Typography variant="body2" color={rc.medium ? 'warning.main' : 'text.primary'} fontWeight={600}>{rc.medium}</Typography></Stack>
        {baseline && (
          <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">這次變更</Typography><Typography variant="body2" fontWeight={600}>{added.length || removed.length ? `+${added.length} / −${removed.length}` : '無'}</Typography></Stack>
        )}
        {userCount != null && (
          <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">使用者</Typography><Typography variant="body2" fontWeight={600}>{userCount} 位</Typography></Stack>
        )}
      </Stack>
      {highNames.length > 0 && (
        <>
          <Divider sx={{ my: 1.5 }} />
          <Typography variant="caption" color="error.main" sx={{ display: 'block', mb: 0.5 }}>包含高風險權限</Typography>
          <Typography variant="caption" color="text.secondary">{highNames.join('、')}</Typography>
        </>
      )}
    </Paper>
  );
}

function PermissionReview({ codes }: { codes: ReadonlySet<string> }) {
  const groups = groupByModule(codes);
  if (!groups.length) return <Alert severity="warning">還沒有勾選任何權限，這個角色的成員登入後會什麼都看不到。</Alert>;
  return (
    <Stack spacing={1.5}>
      {groups.map((g) => (
        <Box key={g.module}>
          <Typography variant="subtitle2" gutterBottom>{g.label} <Typography component="span" variant="caption" color="text.secondary">{g.items.length} 項</Typography></Typography>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {g.items.map((p) => (
              <Chip key={p.code} label={p.name} size="small" variant={p.risk === 'low' ? 'filled' : 'outlined'} color={p.risk === 'high' ? 'error' : p.risk === 'medium' ? 'warning' : 'default'} />
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function ChangeLogList({ rows, loading }: { rows: ChangeLogRow[]; loading: boolean }) {
  if (loading) return <Stack spacing={1}>{[0, 1, 2].map((i) => <Skeleton key={i} variant="rounded" height={64} />)}</Stack>;
  if (!rows.length) return <ResultState status="empty" title="還沒有變更紀錄" description="建立、修改、停用或指派這個角色時會記錄在這裡。" backTo={false} />;
  const render = (v: Record<string, unknown> | null) => v && Object.entries(v).map(([k, val]) => (
    <Typography key={k} variant="caption" color="text.secondary" sx={{ display: 'block' }}>{k}：{String(val)}</Typography>
  ));
  return (
    <List disablePadding>
      {rows.map((r) => (
        <ListItem key={r.id} divider alignItems="flex-start" sx={{ px: 0 }}>
          <ListItemText
            primary={<Stack direction="row" spacing={1} alignItems="baseline" flexWrap="wrap" useFlexGap><Typography variant="body2" fontWeight={600}>{r.action}</Typography><Typography variant="caption" color="text.secondary">{r.actor_name}・{formatDateTime(r.created_at)}</Typography></Stack>}
            secondary={<Box sx={{ mt: 0.5 }}>{render(r.before)}{render(r.after)}</Box>}
            secondaryTypographyProps={{ component: 'div' }}
          />
        </ListItem>
      ))}
    </List>
  );
}

export default function RoleEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile, isDesktop } = useBreakpoint();
  const { hasPermission, refresh: refreshPermissions, setPreview, legacy } = usePermissions();
  const canManage = hasPermission('role.manage');

  const [role, setRole] = useState<RoleRecord | null>(null);
  const [allRoles, setAllRoles] = useState<RoleRecord[]>([]);
  const [grantable, setGrantable] = useState<ReadonlySet<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<'notfound' | string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [baseline, setBaseline] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<StartSource>({ kind: 'blank' });
  const [appliedSource, setAppliedSource] = useState<string>('blank');

  const [tab, setTab] = useState<'permissions' | 'users' | 'history'>('permissions');
  const [users, setUsers] = useState<UserRecord[] | null>(null);
  const [logs, setLogs] = useState<ChangeLogRow[] | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null); setConflict(false);
    try {
      const [roles, g] = await Promise.all([fetchRoles(), canManage ? fetchGrantable().catch(() => ({ isOwner: false, grantable: null })) : Promise.resolve({ isOwner: false, grantable: null })]);
      setAllRoles(roles);
      setGrantable(g.grantable);
      if (!isNew) {
        const r = roles.find((x) => x.id === id) || null;
        if (!r) { setLoadError('notfound'); return; }
        setRole(r); setName(r.name); setDescription(r.description || '');
        const codes = new Set(r.permission_codes);
        setSelected(codes); setBaseline(codes);
      }
    } catch (e: any) { setLoadError(e.message || '讀取失敗'); } finally { setLoading(false); }
  }, [id, isNew, canManage]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (tab === 'users' && users === null && role) fetchRoleUsers(role.id).then(setUsers).catch(() => setUsers([]));
    if (tab === 'history' && logs === null && role) fetchRbacLogs(role.name).then(setLogs).catch(() => setLogs([]));
  }, [tab, users, logs, role]);

  const isSystem = !!role?.is_system;
  const readOnlyMatrix = !canManage || isSystem;
  const dirty = isNew
    ? (name.trim() !== '' || description.trim() !== '' || selected.size > 0)
    : (!!role && (name !== role.name || description !== (role.description || '') || !sameSet(selected, baseline)));
  useUnsavedChanges(dirty && !saving);
  useEffect(() => {
    if (!dirty || saving) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, saving]);

  const added = useMemo(() => [...selected].filter((c) => !baseline.has(c)), [selected, baseline]);
  const removed = useMemo(() => [...baseline].filter((c) => !selected.has(c)), [selected, baseline]);

  const nameError = useMemo(() => {
    const n = name.trim();
    if (!n) return dirty ? '請輸入角色名稱' : '';
    if (n.length > 40) return '角色名稱請在 40 字以內';
    if (allRoles.some((r) => r.id !== role?.id && r.name.toLowerCase() === n.toLowerCase())) return '已經有同名的角色';
    return '';
  }, [name, allRoles, role, dirty]);

  // 新增精靈：離開第一步時套用起始權限（範本／複製既有角色）
  const applySource = () => {
    const key = source.kind === 'blank' ? 'blank' : source.kind === 'template' ? `t:${source.code}` : `r:${source.id}`;
    if (key === appliedSource) return;
    let codes: string[] = [];
    if (source.kind === 'template') codes = ROLE_TEMPLATES.find((t) => t.code === source.code)?.permissions || [];
    if (source.kind === 'role') codes = allRoles.find((r) => r.id === source.id)?.permission_codes || [];
    const filtered = grantable ? codes.filter((c) => grantable.has(c)) : codes;
    if (filtered.length !== codes.length) enqueueSnackbar(`有 ${codes.length - filtered.length} 項你自己沒有的權限沒有帶入`, { variant: 'warning' });
    setSelected(new Set(filtered));
    setAppliedSource(key);
  };

  const save = async () => {
    if (nameError || !name.trim()) { enqueueSnackbar(nameError || '請輸入角色名稱', { variant: 'warning' }); return; }
    const highAdded = added.filter((c) => permissionDef(c)?.risk === 'high');
    const affected = role?.user_count || 0;
    if (highAdded.length || (affected > 0 && (added.length || removed.length))) {
      const lines: string[] = [];
      if (added.length) lines.push(`新增 ${added.length} 項${highAdded.length ? `，其中高風險：${highAdded.map(permissionName).join('、')}` : ''}`);
      if (removed.length) lines.push(`移除 ${removed.length} 項：${removed.map(permissionName).join('、')}`);
      if (affected > 0) lines.push(`此角色目前有 ${affected} 位使用者，儲存後立即生效。`);
      const ok = await confirm({
        title: isNew ? '確認建立角色' : '確認儲存變更',
        message: <Stack spacing={0.5}>{lines.map((l) => <Typography key={l} variant="body2">{l}</Typography>)}</Stack>,
        confirmLabel: isNew ? '建立' : '儲存', danger: highAdded.length > 0,
      });
      if (!ok) return;
    }
    setSaving(true); setConflict(false);
    try {
      const res = await rolesAdmin('save_role', {
        id: role?.id || null, name: name.trim(), description: description.trim(), permission_codes: [...selected], expected_version: role?.version ?? null,
      });
      enqueueSnackbar(isNew ? `已建立角色「${name.trim()}」` : '角色已儲存', { variant: 'success' });
      refreshPermissions();
      if (isNew) { setSelected(new Set()); setName(''); setDescription(''); navigate(`/admin/roles/${res.role.id}`, { replace: true }); return; }
      setLogs(null);
      await load();
    } catch (e: any) {
      if (e.status === 409) setConflict(true);
      enqueueSnackbar(e.message || '儲存失敗', { variant: 'error' });
    } finally { setSaving(false); }
  };

  const discard = () => {
    if (!role) return;
    setName(role.name); setDescription(role.description || ''); setSelected(new Set(baseline));
  };

  const preview = () => {
    setPreview({ roleName: name.trim() || role?.name || '未命名角色', permissions: selected });
    enqueueSnackbar('已切換為角色預覽，側欄與按鈕都依這個角色顯示；預覽期間不能做任何修改。', { variant: 'info' });
    navigate('/');
  };

  const toggleActive = async () => {
    if (!role) return;
    setMenuEl(null);
    if (role.is_active) {
      const ok = await confirm({
        title: `停用「${role.name}」？`,
        message: role.user_count > 0 ? `目前有 ${role.user_count} 位使用者擁有這個角色，停用後他們會立即失去這個角色給的權限。角色設定會保留。` : '角色設定會保留，可隨時再啟用。',
        confirmLabel: '停用', danger: true,
      });
      if (!ok) return;
    }
    try {
      await rolesAdmin('set_role_active', { id: role.id, is_active: !role.is_active });
      enqueueSnackbar(role.is_active ? '已停用' : '已啟用', { variant: 'success' });
      refreshPermissions(); setLogs(null); await load();
    } catch (e: any) { enqueueSnackbar(e.message || '操作失敗', { variant: 'error' }); }
  };

  const remove = async () => {
    if (!role) return;
    setMenuEl(null);
    const ok = await confirm({ title: `刪除「${role.name}」？`, message: '角色與它的權限設定會永久刪除，無法復原。', confirmLabel: '永久刪除', danger: true });
    if (!ok) return;
    try {
      await rolesAdmin('delete_role', { id: role.id });
      enqueueSnackbar(`已刪除「${role.name}」`, { variant: 'success' });
      navigate('/admin/roles', { replace: true });
    } catch (e: any) { enqueueSnackbar(e.message || '刪除失敗', { variant: 'error' }); }
  };

  const deleteBlockReason = role ? (role.is_system ? '系統角色不可刪除' : role.user_count > 0 ? `目前有 ${role.user_count} 位使用者，請先改指派或停用` : null) : null;

  const backLink = (
    <Button component={RouterLink} to="/admin/roles" size="small" color="inherit" startIcon={<ChevronLeft size={16} />} sx={{ mb: 1, ml: -1 }}>角色列表</Button>
  );

  if (loadError === 'notfound') return <Box>{backLink}<ResultState status={404} description="找不到這個角色，可能已被刪除。" backTo="/admin/roles" /></Box>;
  if (loadError) return <Box>{backLink}<ResultState status={500} description={loadError} onRetry={load} backTo="/admin/roles" /></Box>;
  if (loading) return <Box>{backLink}<Skeleton width={240} height={36} /><Skeleton variant="rounded" height={320} sx={{ mt: 2 }} /></Box>;

  const basicFields = (
    <Stack spacing={2}>
      <TextField label="角色名稱" value={name} onChange={(e) => setName(e.target.value)} error={!!nameError} helperText={nameError || '例如：櫃台、夜班客服、會計'} fullWidth required disabled={!canManage} inputProps={{ maxLength: 40 }} />
      <TextField label="說明" value={description} onChange={(e) => setDescription(e.target.value)} helperText="一句話說明這個角色是給誰用的，會顯示在邀請與指派的選單裡" fullWidth multiline minRows={2} disabled={!canManage} inputProps={{ maxLength: 200 }} />
    </Stack>
  );

  // ---------------- 新增精靈 ----------------
  if (isNew) {
    if (!canManage) return <Box>{backLink}<ResultState status={403} backTo="/admin/roles" /></Box>;
    const steps = ['基本資料', '選擇權限', '確認'];
    const canNext = step === 0 ? !!name.trim() && !nameError : true;
    const next = () => { if (step === 0) applySource(); setStep((s) => Math.min(s + 1, 2)); };
    const templates = ROLE_TEMPLATES.filter((t) => !t.isSystem);
    return (
      <Box sx={{ pb: 10 }}>
        {backLink}
        <PageHeaderV2 title="新增角色" description="先取名字，再勾選這個角色可以做的事；可以從範本或既有角色複製後再調整。" />
        <LegacyDbAlert />
        <Stepper activeStep={step} alternativeLabel={!isMobile} orientation="horizontal" sx={{ mb: 3 }}>
          {steps.map((s) => <Step key={s}><StepLabel>{isMobile ? '' : s}</StepLabel></Step>)}
        </Stepper>
        {isMobile && <Typography variant="subtitle1" sx={{ mb: 2 }}>步驟 {step + 1}／3：{steps[step]}</Typography>}

        {step === 0 && (
          <Card><CardContent sx={{ p: { xs: 2, md: 3 } }}>
            <Stack spacing={3}>
              {basicFields}
              <Box>
                <Typography variant="subtitle2" gutterBottom>起始權限</Typography>
                <RadioGroup value={source.kind} onChange={(e) => { const k = e.target.value; setSource(k === 'blank' ? { kind: 'blank' } : k === 'template' ? { kind: 'template', code: templates[0]?.code || '' } : { kind: 'role', id: allRoles.find((r) => !r.is_system)?.id || allRoles[0]?.id || '' }); }}>
                  <FormControlLabel value="blank" control={<Radio size="small" />} label={<Typography variant="body2">從空白開始</Typography>} />
                  <FormControlLabel value="template" control={<Radio size="small" />} label={<Typography variant="body2">套用範本</Typography>} />
                  {source.kind === 'template' && (
                    <TextField select size="small" value={source.code} onChange={(e) => setSource({ kind: 'template', code: e.target.value })} sx={{ ml: 4, mb: 1, maxWidth: 420 }} helperText={templates.find((t) => t.code === source.code)?.description}>
                      {templates.map((t) => <MenuItem key={t.code} value={t.code}>{t.name}（{t.permissions.length} 項）</MenuItem>)}
                    </TextField>
                  )}
                  <FormControlLabel value="role" control={<Radio size="small" />} label={<Typography variant="body2">複製既有角色</Typography>} disabled={allRoles.length === 0} />
                  {source.kind === 'role' && (
                    <TextField select size="small" value={source.id} onChange={(e) => setSource({ kind: 'role', id: e.target.value })} sx={{ ml: 4, maxWidth: 420 }} helperText={allRoles.find((r) => r.id === source.id)?.description}>
                      {allRoles.map((r) => <MenuItem key={r.id} value={r.id}>{r.name}（{r.permission_codes.length} 項）</MenuItem>)}
                    </TextField>
                  )}
                </RadioGroup>
              </Box>
            </Stack>
          </CardContent></Card>
        )}

        {step === 1 && (
          <Stack direction={isDesktop ? 'row' : 'column'} spacing={2} alignItems="flex-start">
            <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
              <PermissionMatrix selected={selected} onChange={setSelected} grantable={grantable} />
            </Box>
            {isDesktop && <Box sx={{ width: 280, flexShrink: 0, position: 'sticky', top: 16 }}><SummaryPanel selected={selected} baseline={null} userCount={null} /></Box>}
          </Stack>
        )}

        {step === 2 && (
          <Stack spacing={2}>
            <Card><CardContent>
              <Typography variant="h6">{name.trim()}</Typography>
              {description.trim() && <Typography variant="body2" color="text.secondary">{description.trim()}</Typography>}
              <Divider sx={{ my: 2 }} />
              <SummaryPanel selected={selected} baseline={null} userCount={null} />
            </CardContent></Card>
            <Card><CardContent><PermissionReview codes={selected} /></CardContent></Card>
          </Stack>
        )}

        <Box sx={{ position: 'fixed', left: { xs: 0, lg: 'var(--sidebar-offset, 0px)' }, right: 0, bottom: 0, zIndex: (t) => t.zIndex.appBar, bgcolor: 'background.paper', borderTop: '1px solid', borderColor: 'divider', px: { xs: 1.5, md: 3 }, py: 1.5, display: 'flex', alignItems: 'center', gap: 2, boxShadow: '0 -4px 12px rgba(16,24,40,.06)' }}>
          {step === 1 && <SummaryPanel selected={selected} baseline={null} userCount={null} compact />}
          <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
            {step > 0 && <Button variant="outlined" onClick={() => setStep((s) => s - 1)} disabled={saving}>上一步</Button>}
            {step < 2 && <Button variant="contained" onClick={next} disabled={!canNext}>下一步</Button>}
            {step === 2 && <Button variant="contained" onClick={save} disabled={saving} startIcon={<Save size={16} />}>{saving ? '建立中…' : '建立角色'}</Button>}
          </Stack>
        </Box>
      </Box>
    );
  }

  // ---------------- 既有角色 ----------------
  if (!role) return null;
  const header = (
    <PageHeaderV2
      title={role.name}
      description={role.description || undefined}
      adornment={<Stack direction="row" spacing={0.5}>{role.is_system && <Chip label="系統角色" size="small" color="primary" variant="outlined" />}{!role.is_active && <Chip label="已停用" size="small" />}</Stack>}
      secondary={
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" size="small" startIcon={<Eye size={16} />} onClick={preview}>以此角色預覽</Button>
          {canManage && !role.is_system && (
            <>
              <IconButton size="small" onClick={(e) => setMenuEl(e.currentTarget)} aria-label="更多操作"><MoreVertical size={18} /></IconButton>
              <Menu open={!!menuEl} anchorEl={menuEl} onClose={() => setMenuEl(null)}>
                <MenuItem onClick={toggleActive}><Power size={16} style={{ marginRight: 8 }} />{role.is_active ? '停用角色' : '啟用角色'}</MenuItem>
                <Tooltip title={deleteBlockReason || ''} placement="left"><span>
                  <MenuItem disabled={!!deleteBlockReason} onClick={remove} sx={{ color: 'error.main' }}><Trash2 size={16} style={{ marginRight: 8 }} />刪除角色</MenuItem>
                </span></Tooltip>
              </Menu>
            </>
          )}
        </Stack>
      }
    />
  );

  const permissionsTab = (
    <Stack direction={isDesktop ? 'row' : 'column'} spacing={2} alignItems="flex-start">
      <Box sx={{ flex: 1, minWidth: 0, width: '100%' }}>
        <Stack spacing={2}>
          {conflict && (
            <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>重新載入</Button>}>
              此角色已被其他人更新，你的修改沒有儲存。請重新載入最新內容後再改一次。
            </Alert>
          )}
          {isSystem && <Alert severity="info">Super Admin 永遠擁有全部權限，不能修改、停用或刪除；只能調整名稱與說明。</Alert>}
          {!canManage && <Alert severity="info">你只有查看權限，無法修改這個角色。</Alert>}
          {legacy && <LegacyDbAlert />}
          <Card><CardContent sx={{ p: { xs: 2, md: 3 } }}>{basicFields}</CardContent></Card>
          <PermissionMatrix selected={selected} onChange={setSelected} grantable={grantable} readOnly={readOnlyMatrix} baseline={baseline} />
        </Stack>
      </Box>
      {isDesktop && <Box sx={{ width: 280, flexShrink: 0, position: 'sticky', top: 16 }}><SummaryPanel selected={selected} baseline={baseline} userCount={role.user_count} /></Box>}
    </Stack>
  );

  const usersTab = users === null
    ? <Stack spacing={1}>{[0, 1].map((i) => <Skeleton key={i} variant="rounded" height={56} />)}</Stack>
    : users.length === 0
      ? <ResultState status="empty" title="還沒有人擁有這個角色" description="到「使用者」頁指派，或在邀請同事時直接選這個角色。" backTo={false} action={<Button component={RouterLink} to="/admin/accounts" variant="outlined">前往使用者</Button>} />
      : (
        <List disablePadding>
          {users.map((u) => (
            <ListItem key={u.id} divider sx={{ px: 0 }} secondaryAction={<Chip label={STATUS_LABELS[u.status]} size="small" />}>
              <ListItemText
                primary={<Link component={RouterLink} to={`/admin/accounts/${u.id}`} underline="hover">{u.display_name || u.email}</Link>}
                secondary={u.email}
              />
            </ListItem>
          ))}
        </List>
      );

  const body: ReactNode = tab === 'permissions' ? permissionsTab : tab === 'users' ? usersTab : <ChangeLogList rows={logs || []} loading={logs === null} />;

  return (
    <Box sx={{ pb: dirty ? 10 : 0 }}>
      {backLink}
      {header}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: '1px solid', borderColor: 'divider' }} variant="scrollable" allowScrollButtonsMobile>
        <Tab value="permissions" label="權限" />
        <Tab value="users" label={`使用者（${role.user_count}）`} />
        <Tab value="history" label="變更紀錄" />
      </Tabs>
      {body}

      {dirty && canManage && (
        <Box sx={{ position: 'fixed', left: { xs: 0, lg: 'var(--sidebar-offset, 0px)' }, right: 0, bottom: 0, zIndex: (t) => t.zIndex.appBar, bgcolor: 'background.paper', borderTop: '1px solid', borderColor: 'divider', px: { xs: 1.5, md: 3 }, py: 1.5, display: 'flex', alignItems: 'center', gap: 2, boxShadow: '0 -4px 12px rgba(16,24,40,.06)' }}>
          <Box sx={{ minWidth: 0 }}>
            {!isMobile && <Typography variant="body2" fontWeight={600}>尚有未儲存變更</Typography>}
            <SummaryPanel selected={selected} baseline={baseline} userCount={null} compact />
          </Box>
          <Stack direction="row" spacing={1} sx={{ ml: 'auto', flexShrink: 0 }}>
            <Button variant="outlined" onClick={discard} disabled={saving}>取消變更</Button>
            <Button variant="contained" onClick={save} disabled={saving || !!nameError} startIcon={<Save size={16} />}>{saving ? '儲存中…' : '儲存'}</Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}

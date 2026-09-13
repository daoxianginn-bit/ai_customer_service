import { useMemo, useState } from 'react';
import {
  Box, Button, ButtonGroup, Checkbox, Chip, Collapse, IconButton, InputAdornment, Menu, MenuItem, Paper,
  Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react';
import {
  MODULE_LABELS, MODULE_ORDER, PERMISSION_CATALOG, PRESET_LABELS, RISK_LABELS, dependentsOf, modulePreset, permissionName, withDependencies,
  type PermissionDef, type PermissionModule, type PresetKind, type RiskLevel,
} from '../../app/permissions';
import { useBreakpoint } from '../../app/useBreakpoint';
import { useConfirm } from '../../components/ui-mui/ConfirmDialogProvider';

// ========================================================================
// 權限矩陣（權限管理 V2 §18–25）：依模組摺疊的權限清單，角色編輯器與新增角色精靈共用。
//
// - 模組標題有三態勾選（全選／部分／未選）與快速 Preset（僅查看／日常操作／完整管理）
// - 勾 edit 自動帶 view，並提示「已自動勾選前置權限」；取消 view 會先問要不要連帶取消依賴它的權限
// - 敏感／高風險用低調的標籤標示，滑過看說明（§22）
// - 呼叫者自己沒有的權限整列鎖起來（§40 防止權限提升；主帳號不鎖）
// - 搜尋時只留下符合的列，並自動展開有結果的模組
// ========================================================================

export function RiskChip({ risk, size = 'small' }: { risk: RiskLevel; size?: 'small' | 'medium' }) {
  if (risk === 'low') return null;
  return (
    <Tooltip title={risk === 'high' ? '高風險：會造成不可逆的刪除、資料外洩或系統層級變更，只給真的需要的角色。' : '敏感：牽涉金流、個資或機密設定，建議只給相關職務。'}>
      <Chip
        label={RISK_LABELS[risk]} size={size} variant="outlined" color={risk === 'high' ? 'error' : 'warning'}
        sx={{ height: 20, fontSize: 11, '& .MuiChip-label': { px: 0.75 } }}
      />
    </Tooltip>
  );
}

export interface PermissionMatrixProps {
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** 呼叫者可授予的權限；null＝全部可授予（主帳號） */
  grantable?: ReadonlySet<string> | null;
  readOnly?: boolean;
  /** 儲存前的原始權限：顯示 新增／移除 標記 */
  baseline?: ReadonlySet<string>;
}

export default function PermissionMatrix({ selected, onChange, grantable = null, readOnly = false, baseline }: PermissionMatrixProps) {
  const { enqueueSnackbar } = useSnackbar();
  const confirm = useConfirm();
  const { isMobile } = useBreakpoint();
  const [search, setSearch] = useState('');
  // 預設展開已有勾選的模組；沒有任何勾選（新角色）就展開第一個
  const [expanded, setExpanded] = useState<Set<PermissionModule>>(() => {
    const withSel = MODULE_ORDER.filter((m) => PERMISSION_CATALOG.some((p) => p.module === m && selected.has(p.code)));
    return new Set(withSel.length ? withSel : [MODULE_ORDER[0]]);
  });
  const [presetAnchor, setPresetAnchor] = useState<{ el: HTMLElement; module: PermissionModule } | null>(null);

  const canGrant = (code: string) => !grantable || grantable.has(code);
  const locked = (code: string) => readOnly || !canGrant(code);

  const q = search.trim().toLowerCase();
  const byModule = useMemo(() => {
    const map = new Map<PermissionModule, PermissionDef[]>();
    for (const m of MODULE_ORDER) map.set(m, []);
    for (const p of PERMISSION_CATALOG) {
      if (q && !(p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) || MODULE_LABELS[p.module].includes(q))) continue;
      map.get(p.module)!.push(p);
    }
    return map;
  }, [q]);

  const isExpanded = (m: PermissionModule) => (q ? (byModule.get(m)?.length || 0) > 0 : expanded.has(m));
  const toggleExpanded = (m: PermissionModule) => setExpanded((prev) => { const n = new Set(prev); if (n.has(m)) n.delete(m); else n.add(m); return n; });
  const expandAll = () => setExpanded(new Set(MODULE_ORDER));
  const collapseAll = () => setExpanded(new Set());

  const add = (codes: string[]) => {
    const next = new Set(selected);
    const auto: string[] = [];
    for (const c of withDependencies(codes)) {
      if (!next.has(c)) { next.add(c); if (!codes.includes(c)) auto.push(c); }
    }
    onChange(next);
    if (auto.length) enqueueSnackbar(`已自動勾選前置權限：${auto.map(permissionName).join('、')}`, { variant: 'info' });
  };

  const remove = async (codes: string[]) => {
    const deps = new Set<string>();
    for (const c of codes) for (const d of dependentsOf(c, selected)) if (!codes.includes(d)) deps.add(d);
    if (deps.size) {
      const ok = await confirm({
        title: codes.length === 1 ? `取消「${permissionName(codes[0])}」？` : '取消這些權限？',
        message: `以下權限需要它才能運作，會一併取消：${[...deps].map(permissionName).join('、')}。`,
        confirmLabel: '一併取消', danger: true,
      });
      if (!ok) return;
    }
    const next = new Set(selected);
    for (const c of [...codes, ...deps]) next.delete(c);
    onChange(next);
  };

  const toggleOne = (p: PermissionDef) => {
    if (locked(p.code)) return;
    if (selected.has(p.code)) remove([p.code]); else add([p.code]);
  };

  const moduleState = (m: PermissionModule) => {
    const all = PERMISSION_CATALOG.filter((p) => p.module === m);
    const grantableAll = all.filter((p) => canGrant(p.code));
    const selectedCount = all.filter((p) => selected.has(p.code)).length;
    const checked = grantableAll.length > 0 && grantableAll.every((p) => selected.has(p.code));
    return { total: all.length, selectedCount, checked, indeterminate: !checked && selectedCount > 0, grantableCount: grantableAll.length };
  };

  const toggleModule = (m: PermissionModule) => {
    if (readOnly) return;
    const st = moduleState(m);
    const codes = PERMISSION_CATALOG.filter((p) => p.module === m && canGrant(p.code)).map((p) => p.code);
    if (st.checked) remove(codes.filter((c) => selected.has(c)));
    else add(codes);
  };

  const applyPreset = (m: PermissionModule, kind: PresetKind) => {
    setPresetAnchor(null);
    if (readOnly) return;
    const target = new Set(modulePreset(m, kind).filter(canGrant));
    const inModule = PERMISSION_CATALOG.filter((p) => p.module === m).map((p) => p.code);
    const next = new Set(selected);
    for (const c of inModule) { if (locked(c)) continue; if (target.has(c)) next.add(c); else next.delete(c); }
    onChange(next);
    enqueueSnackbar(`${MODULE_LABELS[m]}已套用「${PRESET_LABELS[kind]}」`, { variant: 'info' });
  };

  const presetButtons = (m: PermissionModule) => {
    if (readOnly) return null;
    if (isMobile) {
      return (
        <Button size="small" variant="text" startIcon={<SlidersHorizontal size={14} />} onClick={(e) => setPresetAnchor({ el: e.currentTarget, module: m })} sx={{ minWidth: 0, px: 1 }}>
          快速
        </Button>
      );
    }
    return (
      <ButtonGroup size="small" variant="outlined" sx={{ '& .MuiButton-root': { fontSize: 12, py: 0.25 } }}>
        {(Object.keys(PRESET_LABELS) as PresetKind[]).map((k) => (
          <Button key={k} onClick={() => applyPreset(m, k)}>{PRESET_LABELS[k]}</Button>
        ))}
      </ButtonGroup>
    );
  };

  const changeMark = (code: string) => {
    if (!baseline) return null;
    const was = baseline.has(code); const now = selected.has(code);
    if (was === now) return null;
    return <Chip label={now ? '新增' : '移除'} size="small" color={now ? 'success' : 'default'} sx={{ height: 18, fontSize: 11, '& .MuiChip-label': { px: 0.75 } }} />;
  };

  return (
    <Stack spacing={1.5}>
      <Stack direction={isMobile ? 'column' : 'row'} spacing={1} alignItems={isMobile ? 'stretch' : 'center'}>
        <TextField
          size="small" placeholder="搜尋權限名稱或說明…" value={search} onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> }}
          sx={{ flex: 1 }}
        />
        {!q && (
          <Stack direction="row" spacing={0.5} justifyContent={isMobile ? 'flex-end' : undefined}>
            <Button size="small" onClick={expandAll}>全部展開</Button>
            <Button size="small" onClick={collapseAll}>全部收合</Button>
          </Stack>
        )}
      </Stack>

      {MODULE_ORDER.map((m) => {
        const items = byModule.get(m) || [];
        if (q && items.length === 0) return null;
        const st = moduleState(m);
        const open = isExpanded(m);
        return (
          // 不用 MUI Accordion：AccordionSummary 本身是 <button>，裡面再放勾選框與 Preset 按鈕會變成 button 套 button
          <Paper key={m} variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 1, pr: 1, py: 0.75 }}>
              <Checkbox
                size="small" checked={st.checked} indeterminate={st.indeterminate} disabled={readOnly || st.grantableCount === 0}
                onChange={() => toggleModule(m)}
                inputProps={{ 'aria-label': `${MODULE_LABELS[m]} 全選` }}
              />
              <Box
                role="button" tabIndex={0} aria-expanded={open}
                onClick={() => !q && toggleExpanded(m)}
                onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!q) toggleExpanded(m); } }}
                sx={{ flex: 1, minWidth: 0, cursor: q ? 'default' : 'pointer', py: 0.5, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2, borderRadius: 1 } }}
              >
                <Typography variant="subtitle2" noWrap>{MODULE_LABELS[m]}</Typography>
                <Typography variant="caption" color={st.selectedCount ? 'primary.main' : 'text.secondary'}>{st.selectedCount} / {st.total} 項</Typography>
              </Box>
              {presetButtons(m)}
              <IconButton size="small" onClick={() => !q && toggleExpanded(m)} aria-label={open ? '收合' : '展開'} sx={{ ml: 0.5, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
                <ChevronDown size={18} />
              </IconButton>
            </Box>
            <Collapse in={open} unmountOnExit>
            <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
              {items.map((p) => {
                const isLocked = locked(p.code);
                const row = (
                  <Box
                    key={p.code} role="button" tabIndex={isLocked ? -1 : 0}
                    onClick={() => toggleOne(p)}
                    onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleOne(p); } }}
                    sx={{
                      display: 'flex', alignItems: 'flex-start', gap: 1, px: { xs: 1, md: 2 }, py: 1,
                      cursor: isLocked ? 'not-allowed' : 'pointer', opacity: isLocked && !selected.has(p.code) ? 0.55 : 1,
                      borderBottom: '1px solid', borderColor: 'divider', '&:last-child': { borderBottom: 0 },
                      '&:hover': { bgcolor: isLocked ? undefined : 'action.hover' },
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                    }}
                  >
                    <Checkbox size="small" checked={selected.has(p.code)} disabled={isLocked} tabIndex={-1} sx={{ p: 0.5, mt: -0.25 }} />
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Typography variant="body2" fontWeight={500}>{p.name}</Typography>
                        <RiskChip risk={p.risk} />
                        {changeMark(p.code)}
                        {!isMobile && <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace' }}>{p.code}</Typography>}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{p.description}</Typography>
                      {p.requires && p.requires.length > 0 && (
                        <Typography variant="caption" color="text.disabled" sx={{ display: 'block' }}>需要：{p.requires.map(permissionName).join('、')}</Typography>
                      )}
                    </Box>
                  </Box>
                );
                return !readOnly && !canGrant(p.code)
                  ? <Tooltip key={p.code} title="你自己沒有這個權限，不能授予他人" placement="top-start"><Box>{row}</Box></Tooltip>
                  : row;
              })}
            </Box>
            </Collapse>
          </Paper>
        );
      })}

      {q && MODULE_ORDER.every((m) => (byModule.get(m)?.length || 0) === 0) && (
        <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'center', py: 3 }}>沒有符合「{search}」的權限</Typography>
      )}

      <Menu open={!!presetAnchor} anchorEl={presetAnchor?.el} onClose={() => setPresetAnchor(null)}>
        {(Object.keys(PRESET_LABELS) as PresetKind[]).map((k) => (
          <MenuItem key={k} onClick={() => presetAnchor && applyPreset(presetAnchor.module, k)}>{PRESET_LABELS[k]}</MenuItem>
        ))}
      </Menu>
    </Stack>
  );
}

/** 依模組整理一組權限 code（摘要、確認頁、有效權限頁共用） */
export function groupByModule(codes: Iterable<string>): { module: PermissionModule; label: string; items: PermissionDef[] }[] {
  const set = new Set(codes);
  return MODULE_ORDER
    .map((m) => ({ module: m, label: MODULE_LABELS[m], items: PERMISSION_CATALOG.filter((p) => p.module === m && set.has(p.code)) }))
    .filter((g) => g.items.length > 0);
}

export function riskCounts(codes: Iterable<string>): { high: number; medium: number; total: number } {
  const set = new Set(codes);
  let high = 0; let medium = 0;
  for (const p of PERMISSION_CATALOG) {
    if (!set.has(p.code)) continue;
    if (p.risk === 'high') high += 1; else if (p.risk === 'medium') medium += 1;
  }
  return { high, medium, total: set.size };
}

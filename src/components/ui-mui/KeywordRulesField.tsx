import { useState } from 'react';
import { Box, Button, Divider, IconButton, MenuItem, Paper, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { Plus, Trash2 } from 'lucide-react';
import { useBreakpoint } from '../../app/useBreakpoint';
import { parseKeywordRules, serializeKeywordRules, type KeywordMatch, type TriggerRule } from '../../lib/messageVariables';

// ========================================================================
// 關鍵字規則編輯器：上方一列新增（關鍵字＋比對方式），下方一條一列，每列可切換比對方式、可刪除。
// 值存成單一字串（JSON 陣列）交給呼叫端放進設定欄位；舊的逗號格式讀得懂，存回去就變新格式。
//   包含：客人訊息裡有這幾個字就算（「房型有哪些」含「房型」）
//   整句相等：整句剛好就是這幾個字才算（去頭尾空白後比對）
// ========================================================================

interface Props {
  value: string | null | undefined;
  onChange: (serialized: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function KeywordRulesField({ value, onChange, placeholder = '輸入關鍵字', disabled }: Props) {
  const { isMobile } = useBreakpoint();
  const rules = parseKeywordRules(value);
  const [draft, setDraft] = useState('');
  const [draftMatch, setDraftMatch] = useState<KeywordMatch>('contains');

  const commit = (next: TriggerRule[]) => onChange(serializeKeywordRules(next));

  const add = () => {
    const keyword = draft.trim();
    if (!keyword) return;
    if (!rules.some((r) => r.keyword === keyword)) commit([...rules, { keyword, match: draftMatch }]);
    setDraft('');
  };
  const remove = (idx: number) => commit(rules.filter((_, i) => i !== idx));
  const setMatch = (idx: number, match: KeywordMatch) => commit(rules.map((r, i) => (i === idx ? { ...r, match } : r)));

  const matchToggle = (current: KeywordMatch, onPick: (m: KeywordMatch) => void) => (
    <ToggleButtonGroup
      size="small"
      color="primary"
      exclusive
      value={current}
      onChange={(_, v) => v && onPick(v)}
      disabled={disabled}
      sx={{ '& .MuiToggleButton-root': { px: 1.25, py: 0.25, fontSize: 12, lineHeight: 1.6, textTransform: 'none', whiteSpace: 'nowrap' }, '& .Mui-selected': { fontWeight: 600 } }}
    >
      <ToggleButton value="contains">包含</ToggleButton>
      <ToggleButton value="exact">整句相等</ToggleButton>
    </ToggleButtonGroup>
  );

  return (
    <Stack spacing={1.5}>
      {/* 新增列 */}
      <Stack direction={isMobile ? 'column' : 'row'} spacing={1} alignItems={isMobile ? 'stretch' : 'center'} component="form" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <TextField size="small" fullWidth placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled} />
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField select size="small" value={draftMatch} onChange={(e) => setDraftMatch(e.target.value as KeywordMatch)} sx={{ minWidth: 130 }} disabled={disabled}>
            <MenuItem value="contains">包含</MenuItem>
            <MenuItem value="exact">整句相等</MenuItem>
          </TextField>
          <Button type="submit" variant="contained" startIcon={<Plus size={16} />} disabled={disabled || !draft.trim()} sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>新增</Button>
        </Stack>
      </Stack>

      {/* 規則清單 */}
      <Paper variant="outlined">
        {rules.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>還沒有任何規則。上面輸入關鍵字後按「新增」。</Typography>
        ) : (
          <Stack divider={<Divider />}>
            {rules.map((r, i) => (
              <Stack key={`${r.keyword}-${i}`} direction="row" alignItems="center" spacing={1.5} sx={{ px: 2, py: 0.75, minHeight: 44 }}>
                <Typography variant="body2" sx={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{r.keyword}</Typography>
                {matchToggle(r.match, (m) => setMatch(i, m))}
                <Tooltip title="移除">
                  <span>
                    <IconButton size="small" onClick={() => remove(i)} disabled={disabled} aria-label={`移除 ${r.keyword}`}><Trash2 size={16} /></IconButton>
                  </span>
                </Tooltip>
              </Stack>
            ))}
          </Stack>
        )}
      </Paper>

      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          共 {rules.length} 條。<b>包含</b>＝訊息裡有這幾個字就命中（「房型有哪些」會被「房型」擋掉）；<b>整句相等</b>＝整句剛好就是這幾個字才命中。
        </Typography>
      </Box>
    </Stack>
  );
}

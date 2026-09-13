import { useState } from 'react';
import { Box, Button, Chip, IconButton, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { Plus, X } from 'lucide-react';
import { parseKeywordRules, serializeKeywordRules, type KeywordMatch, type TriggerRule } from '../../lib/messageVariables';

// ========================================================================
// 關鍵字規則編輯器：一條一條新增，每條可選「包含」或「整句相等」。
// 值存成單一字串（JSON 陣列）交給呼叫端放進設定欄位；舊的逗號格式讀得懂，存回去就變新格式。
//   包含：客人訊息裡有這幾個字就算（「房型有哪些」含「房型」）
//   整句相等：整句剛好就是這幾個字才算（去頭尾空白後比對）
// ========================================================================

const MATCH_LABEL: Record<KeywordMatch, string> = { contains: '包含', exact: '整句相等' };

interface Props {
  value: string | null | undefined;
  onChange: (serialized: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function KeywordRulesField({ value, onChange, placeholder = '輸入關鍵字', disabled }: Props) {
  const rules = parseKeywordRules(value);
  const [draft, setDraft] = useState('');
  const [draftMatch, setDraftMatch] = useState<KeywordMatch>('contains');

  const commit = (next: TriggerRule[]) => onChange(serializeKeywordRules(next));

  const add = () => {
    const keyword = draft.trim();
    if (!keyword) return;
    if (rules.some((r) => r.keyword === keyword && r.match === draftMatch)) { setDraft(''); return; }
    commit([...rules, { keyword, match: draftMatch }]);
    setDraft('');
  };

  const remove = (idx: number) => commit(rules.filter((_, i) => i !== idx));
  const toggleMatch = (idx: number) => commit(rules.map((r, i) => (i === idx ? { ...r, match: r.match === 'exact' ? 'contains' : 'exact' } : r)));

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="flex-start" component="form" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <TextField size="small" fullWidth placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} disabled={disabled} />
        <TextField select size="small" value={draftMatch} onChange={(e) => setDraftMatch(e.target.value as KeywordMatch)} sx={{ minWidth: 130 }} disabled={disabled}>
          <MenuItem value="contains">包含</MenuItem>
          <MenuItem value="exact">整句相等</MenuItem>
        </TextField>
        <Button type="submit" variant="outlined" color="inherit" startIcon={<Plus size={16} />} disabled={disabled || !draft.trim()} sx={{ flexShrink: 0 }}>新增</Button>
      </Stack>

      {rules.length === 0 ? (
        <Typography variant="caption" color="text.secondary">目前沒有任何規則。</Typography>
      ) : (
        <Stack direction="row" flexWrap="wrap" gap={1}>
          {rules.map((r, i) => (
            <Chip
              key={`${r.keyword}-${r.match}-${i}`}
              variant="outlined"
              disabled={disabled}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <span>{r.keyword}</span>
                  <Tooltip title="點一下切換 包含／整句相等">
                    <Box
                      component="button"
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleMatch(i); }}
                      sx={{ border: 'none', cursor: 'pointer', px: 0.75, py: 0.1, borderRadius: 1, fontSize: 11, bgcolor: r.match === 'exact' ? 'info.light' : 'grey.100', color: r.match === 'exact' ? 'info.dark' : 'text.secondary' }}
                    >
                      {MATCH_LABEL[r.match]}
                    </Box>
                  </Tooltip>
                </Box>
              }
              deleteIcon={<IconButton size="small" aria-label="移除" sx={{ p: 0.25 }}><X size={14} /></IconButton>}
              onDelete={() => remove(i)}
            />
          ))}
        </Stack>
      )}
      <Typography variant="caption" color="text.secondary">
        包含＝訊息裡有這幾個字就算（「房型有哪些」會被「房型」命中）；整句相等＝整句剛好是這幾個字才算。
      </Typography>
    </Stack>
  );
}

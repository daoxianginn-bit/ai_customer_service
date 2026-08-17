import { useState, type ReactNode } from 'react';
import { Box, Button, Collapse, Paper, Stack } from '@mui/material';
import { ChevronDown, RotateCcw, Search } from 'lucide-react';

// ========================================================================
// CRUD 四層式架構的第 2 層：篩選卡片。
// 常用條件永遠可見，進階條件收在展開區——後台的篩選欄位常常多到十幾個，
// 全部攤開會把資料表格擠到摺疊線以下，等於每次進頁面都要先捲動才看得到資料。
// ========================================================================

interface FilterPanelProps {
  /** 常駐顯示的主要條件（關鍵字、狀態這類每次都會用到的） */
  children: ReactNode;
  /** 進階條件；有給才會出現「更多條件」展開鈕 */
  advanced?: ReactNode;
  onSearch?: () => void;
  onReset?: () => void;
  /** 查詢中：鎖住按鈕避免連點送出重複請求 */
  loading?: boolean;
  /** 右側額外動作（例如「匯出」），跟查詢/重設並列 */
  actions?: ReactNode;
}

export default function FilterPanel({
  children, advanced, onSearch, onReset, loading, actions,
}: FilterPanelProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        // 表單語意：讓 Enter 直接觸發查詢，不用一定要點按鈕
        component="form"
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          onSearch?.();
        }}
      >
        {children}

        <Box sx={{ flexGrow: 1 }} />

        {advanced && (
          <Button
            size="small"
            color="inherit"
            onClick={() => setExpanded((v) => !v)}
            endIcon={
              <ChevronDown
                size={14}
                style={{ transition: 'transform .2s', transform: expanded ? 'rotate(180deg)' : 'none' }}
              />
            }
          >
            更多條件
          </Button>
        )}
        {onReset && (
          <Button size="small" variant="outlined" color="inherit" onClick={onReset} startIcon={<RotateCcw size={14} />}>
            重設
          </Button>
        )}
        {onSearch && (
          <Button size="small" type="submit" variant="contained" disabled={loading} startIcon={<Search size={14} />}>
            查詢
          </Button>
        )}
        {actions}
      </Stack>

      {advanced && (
        <Collapse in={expanded} unmountOnExit>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
            {advanced}
          </Stack>
        </Collapse>
      )}
    </Paper>
  );
}

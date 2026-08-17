import type { ReactNode } from 'react';
import { Alert, Box, Button, Collapse, Stack, Typography } from '@mui/material';
import { X } from 'lucide-react';

// ========================================================================
// CRUD 四層式架構：勾選多筆時浮現的「批次動作列」。
//
// 規範特別要求區分「全選當前頁」與「全選所有跨頁資料」並給明確提示——
// 這兩者在資料量大時差很多：使用者以為自己選了全部 500 筆，實際只選了當頁 20 筆，
// 批次刪除的結果就會跟預期不同。所以當整頁被選滿、而且總筆數大於當頁筆數時，
// 這裡會主動提示還有多少筆沒被選到，並提供一鍵選取全部。
// ========================================================================

interface BatchActionBarProps {
  selectedCount: number;
  /** 當前頁的資料筆數 */
  pageCount: number;
  /** 篩選條件下的總筆數（跨頁）；不給就不顯示跨頁提示 */
  totalCount?: number;
  onClear: () => void;
  /** 選取全部跨頁資料；不給就不顯示該按鈕 */
  onSelectAll?: () => void;
  /** 批次動作按鈕（批次匯出、批次刪除…） */
  children?: ReactNode;
}

export default function BatchActionBar({
  selectedCount, pageCount, totalCount, onClear, onSelectAll, children,
}: BatchActionBarProps) {
  const hasMoreAcrossPages = totalCount !== undefined && totalCount > pageCount;
  // 「當頁選滿了，但跨頁還有更多」才需要提示；已經選到全部就不用再囉嗦。
  const showSelectAllHint =
    hasMoreAcrossPages && selectedCount >= pageCount && selectedCount < (totalCount as number);

  return (
    <Collapse in={selectedCount > 0} unmountOnExit>
      <Alert
        severity="info"
        icon={false}
        sx={{
          borderRadius: 1,
          border: '1px solid',
          borderColor: 'primary.main',
          bgcolor: 'primary.light',
          '& .MuiAlert-message': { width: '100%', py: 0.5 },
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" fontWeight={600}>
            已選 {selectedCount} 筆
          </Typography>

          {showSelectAllHint && (
            <Typography variant="caption" color="text.secondary">
              （目前只選到這一頁的 {pageCount} 筆，共有 {totalCount} 筆符合條件）
            </Typography>
          )}
          {showSelectAllHint && onSelectAll && (
            <Button size="small" onClick={onSelectAll}>
              選取全部 {totalCount} 筆
            </Button>
          )}

          <Box sx={{ flexGrow: 1 }} />
          {children}
          <Button size="small" color="inherit" onClick={onClear} startIcon={<X size={14} />}>
            取消選取
          </Button>
        </Stack>
      </Alert>
    </Collapse>
  );
}

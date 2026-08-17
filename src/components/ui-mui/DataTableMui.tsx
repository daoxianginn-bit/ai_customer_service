import { useMemo, type ReactNode } from 'react';
import {
  Box, Checkbox, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TablePagination, TableRow, TableSortLabel, Typography,
} from '@mui/material';

// ========================================================================
// CRUD 四層式架構的第 3 層：資料表格。
// 封裝 MuiTable 而不是引入 @mui/x-data-grid——規範允許兩者擇一，這個專案的表格
// 需求是「欄位少、要塞自訂 render（狀態標籤、流程進度、行內按鈕）」，
// 自封裝的彈性比較夠，也不用多背一個大套件。
//
// 排序與分頁刻意做成「受控」：後台有些列表資料量會成長到需要伺服器端分頁，
// 由呼叫端決定要在前端排序還是丟給後端，元件本身不假設資料全在記憶體裡。
// ========================================================================

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** 這一格要顯示什麼；不給就直接取 row[key] */
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  /** 開啟這欄的排序箭頭；排序實作由呼叫端在 onSortChange 裡處理 */
  sortable?: boolean;
  /** 讓長字串不換行（訂單編號、日期這類） */
  nowrap?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** 每列的唯一鍵，批次勾選與 React key 都靠它 */
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyMessage?: ReactNode;

  // --- 排序（受控）---
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (key: string, dir: 'asc' | 'desc') => void;

  // --- 分頁（受控）；不傳 page 就不顯示分頁列 ---
  page?: number;
  rowsPerPage?: number;
  totalCount?: number;
  onPageChange?: (page: number) => void;
  onRowsPerPageChange?: (rowsPerPage: number) => void;

  // --- 批次勾選；不傳 selected 就不顯示勾選欄 ---
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;

  /** 每列最右側的行內動作按鈕 */
  rowActions?: (row: T) => ReactNode;
  /** 點整列時觸發（通常是開啟檢視/編輯） */
  onRowClick?: (row: T) => void;
}

export default function DataTableMui<T>({
  columns, rows, rowKey, loading, emptyMessage = '沒有資料',
  sortBy, sortDir = 'asc', onSortChange,
  page, rowsPerPage = 20, totalCount, onPageChange, onRowsPerPageChange,
  selected, onSelectedChange, rowActions, onRowClick,
}: DataTableProps<T>) {
  const selectable = !!selected && !!onSelectedChange;
  const pageKeys = useMemo(() => rows.map(rowKey), [rows, rowKey]);

  const allOnPageSelected = selectable && pageKeys.length > 0 && pageKeys.every((k) => selected!.includes(k));
  const someOnPageSelected = selectable && pageKeys.some((k) => selected!.includes(k)) && !allOnPageSelected;

  const toggleAllOnPage = () => {
    if (!selectable) return;
    if (allOnPageSelected) onSelectedChange!(selected!.filter((k) => !pageKeys.includes(k)));
    else onSelectedChange!([...new Set([...selected!, ...pageKeys])]);
  };

  const toggleOne = (key: string) => {
    if (!selectable) return;
    onSelectedChange!(selected!.includes(key) ? selected!.filter((k) => k !== key) : [...selected!, key]);
  };

  const colSpan = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  return (
    <Paper variant="outlined">
      {/* overflowX 讓寬表格自己捲動，而不是把整個版面撐寬（外層 main 有 minWidth:0 配合） */}
      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table stickyHeader>
          <TableHead>
            <TableRow>
              {selectable && (
                <TableCell padding="checkbox" sx={{ width: 44 }}>
                  <Checkbox
                    checked={allOnPageSelected}
                    indeterminate={someOnPageSelected}
                    onChange={toggleAllOnPage}
                    inputProps={{ 'aria-label': '全選當前頁' }}
                  />
                </TableCell>
              )}
              {columns.map((col) => (
                <TableCell
                  key={col.key}
                  align={col.align}
                  sx={{ width: col.width, whiteSpace: col.nowrap ? 'nowrap' : undefined }}
                  sortDirection={sortBy === col.key ? sortDir : false}
                >
                  {col.sortable && onSortChange ? (
                    <TableSortLabel
                      active={sortBy === col.key}
                      direction={sortBy === col.key ? sortDir : 'asc'}
                      onClick={() => onSortChange(col.key, sortBy === col.key && sortDir === 'asc' ? 'desc' : 'asc')}
                    >
                      {col.header}
                    </TableSortLabel>
                  ) : col.header}
                </TableCell>
              ))}
              {rowActions && <TableCell align="right" sx={{ width: 1, whiteSpace: 'nowrap' }}>操作</TableCell>}
            </TableRow>
          </TableHead>

          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={colSpan} align="center" sx={{ py: 6 }}>
                  <CircularProgress size={22} />
                </TableCell>
              </TableRow>
            )}

            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={colSpan} align="center" sx={{ py: 6 }}>
                  <Typography variant="body2" color="text.secondary">{emptyMessage}</Typography>
                </TableCell>
              </TableRow>
            )}

            {!loading && rows.map((row) => {
              const key = rowKey(row);
              const isSelected = selectable && selected!.includes(key);
              return (
                <TableRow
                  key={key}
                  hover
                  selected={isSelected}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  sx={{ cursor: onRowClick ? 'pointer' : undefined }}
                >
                  {selectable && (
                    // 勾選格自己吃掉點擊，否則會連帶觸發整列的 onRowClick
                    <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={isSelected} onChange={() => toggleOne(key)} />
                    </TableCell>
                  )}
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      align={col.align}
                      sx={{ whiteSpace: col.nowrap ? 'nowrap' : undefined }}
                    >
                      {col.render ? col.render(row) : (row as any)[col.key]}
                    </TableCell>
                  ))}
                  {rowActions && (
                    <TableCell align="right" onClick={(e) => e.stopPropagation()} sx={{ whiteSpace: 'nowrap' }}>
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">{rowActions(row)}</Stack>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {page !== undefined && onPageChange && (
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}>
          <TablePagination
            component="div"
            count={totalCount ?? rows.length}
            page={page}
            onPageChange={(_, p) => onPageChange(p)}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={
              onRowsPerPageChange ? (e) => onRowsPerPageChange(parseInt(e.target.value, 10)) : undefined
            }
            rowsPerPageOptions={onRowsPerPageChange ? [10, 20, 50, 100] : [rowsPerPage]}
            labelRowsPerPage="每頁筆數"
            labelDisplayedRows={({ from, to, count }) => `${from}–${to} / 共 ${count} 筆`}
          />
        </Box>
      )}
    </Paper>
  );
}

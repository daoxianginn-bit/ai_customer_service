import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { resolveNav } from '../../app/navigation';
import { useBreakpoint } from '../../app/useBreakpoint';

// ========================================================================
// 頁首（V2 §12）：標題 + 說明 + 主要操作（＋可選的次要操作）。
//
// 不給 title/description 時從 navigation.ts 讀，同一頁不用在兩個地方維護文案。
// 手機：說明隱藏、標題與主要操作同一列（§12 Mobile）。
// 不用卡片包起來（舊版 PageHeaderMui 是卡片）：V2 的頁首是內容區的一部分，靠留白分層。
// ========================================================================
interface PageHeaderV2Props {
  title?: string;
  description?: string;
  /** 主要操作：一頁只放一個 Primary（§138） */
  action?: ReactNode;
  /** 次要操作：outline / ghost */
  secondary?: ReactNode;
  /** 標題左側的小元素（例如狀態 chip） */
  adornment?: ReactNode;
}

export default function PageHeaderV2({ title, description, action, secondary, adornment }: PageHeaderV2Props) {
  const location = useLocation();
  const { isMobile } = useBreakpoint();
  const resolved = resolveNav(location.pathname);
  const resolvedTitle = title ?? resolved?.child?.label ?? resolved?.item.label ?? '';
  const resolvedDescription = description ?? resolved?.child?.description ?? resolved?.item.description;

  return (
    <Box sx={{ display: 'flex', alignItems: isMobile ? 'center' : 'flex-start', justifyContent: 'space-between', gap: 2, mb: { xs: 2, md: 3 }, flexWrap: 'wrap' }}>
      <Box sx={{ minWidth: 0 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant={isMobile ? 'h5' : 'h4'} component="h1" noWrap>{resolvedTitle}</Typography>
          {adornment}
        </Stack>
        {resolvedDescription && !isMobile && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{resolvedDescription}</Typography>
        )}
      </Box>
      {(action || secondary) && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
          {secondary}
          {action}
        </Stack>
      )}
    </Box>
  );
}

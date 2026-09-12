import { useMediaQuery, useTheme } from '@mui/material';

// ========================================================================
// RWD 斷點（V2 §16–17）：xs <480、sm 480–767、md 768–1023、lg 1024–1439、xl ≥1440。
//
// 全站只從這裡判斷裝置類型，不要在各頁散落 window.innerWidth（§102）。
//   isMobile  <768  ：側欄抽屜、表格轉卡片、詳情摺疊、對話框整頁、主要操作固定底部
//   isTablet  768–1023：側欄抽屜、表格減欄、篩選可換行
//   isDesktop ≥1024 ：側欄固定、完整表格、雙欄詳情
// ========================================================================
export function useBreakpoint() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const isTablet = useMediaQuery(theme.breakpoints.between('md', 'lg'));
  const isDesktop = useMediaQuery(theme.breakpoints.up('lg'));
  const isWide = useMediaQuery(theme.breakpoints.up('xl'));
  return { isMobile, isTablet, isDesktop, isWide, isCompact: isMobile || isTablet };
}

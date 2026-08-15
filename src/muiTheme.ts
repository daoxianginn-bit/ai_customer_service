import { createTheme } from '@mui/material/styles';

// 這個 theme 只給已經遷移到 MUI 的頁面用（目前：行事曆、計價公式設定），
// 其餘頁面仍是 Tailwind + src/components/ui/，兩套系統暫時共存。
// 顏色/圓角刻意對齊現有 Tailwind 版面（green-600 主色、rounded-xl 卡片），
// 讓使用者在兩套系統之間切換時視覺不會突兀。
export const muiTheme = createTheme({
  palette: {
    primary: { main: '#16a34a', dark: '#15803d', light: '#22c55e', contrastText: '#fff' },
    secondary: { main: '#f59e0b' },
    error: { main: '#dc2626' },
    background: { default: '#f9fafb', paper: '#ffffff' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'inherit',
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: { boxShadow: '0 1px 2px 0 rgba(0,0,0,0.05)' },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 500 },
      },
    },
  },
});

import { createTheme } from '@mui/material/styles';

// ========================================================================
// 全域 Theme：依《企業級 React + Material UI (MUI) 後台系統規範標準書》實作。
//
// 設計取向跟改版前刻意不同：改版前是「對齊 Tailwind 綠色系、圓角 12、寬鬆留白」，
// 現在改成規範要求的「企業級後台」——藍色主色、緊湊（Dense）排版、卡片用邊框而非陰影，
// 目的是在單一螢幕塞進最多有效業務資料。
//
// 頁面仍在從 Tailwind 逐頁遷移到 MUI（見 components/ui-mui/），這份 theme 是唯一的樣式來源，
// 新頁面一律不要自己寫死顏色/字級，改用 theme token，避免又長回各模組各行其道的狀態。
// ========================================================================

// 對話框改成整頁顯示的門檻。這裡用 600px，跟外殼側欄的 900px、內容表格的 768px 都不同，
// 三個數字各有各的理由：側欄要讓出 240px 所以最早收；表格對齊 Tailwind 的 md；
// 對話框則是到了真正的手機寬度才值得整頁，600～768px 的平板上置中卡片仍然好用。
const dialogFullScreenQuery = '@media (max-width:599.95px)';
const dialogFullScreen = {
  margin: 0,
  width: '100%',
  maxWidth: '100%',
  height: '100%',
  maxHeight: '100%',
  borderRadius: 0,
  border: 'none',
} as const;

// 規範的資訊層級：頁標題 20px、模組標題 16px、表格/內文 14px、輔助字 12px。
// 基準 fontSize 13 是規範指定值（MUI 會以此換算 rem）。
export const enterpriseTheme = createTheme({
  palette: {
    primary: { main: '#1890FF', light: '#E6F7FF', dark: '#096DD9', contrastText: '#FFFFFF' },
    success: { main: '#52C41A' },
    warning: { main: '#FAAD14' },
    error: { main: '#FF4D4F' },
    info: { main: '#1890FF' },
    background: { default: '#F0F2F5', paper: '#FFFFFF' },
    text: { primary: '#1F2937', secondary: '#6B7280' },
    divider: '#E5E7EB',
  },
  typography: {
    fontFamily: '"Inter", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif',
    fontSize: 13,
    h5: { fontSize: 20, fontWeight: 600, lineHeight: 1.4 },   // 頁標題
    h6: { fontSize: 16, fontWeight: 600, lineHeight: 1.5 },   // 模組標題
    subtitle1: { fontSize: 14, fontWeight: 600, lineHeight: 1.5 },
    subtitle2: { fontSize: 13, fontWeight: 600, lineHeight: 1.5 },
    body1: { fontSize: 14, lineHeight: 1.6 },                 // 表格/內文
    body2: { fontSize: 13, lineHeight: 1.6 },
    caption: { fontSize: 12, lineHeight: 1.5 },               // 輔助字
    button: { textTransform: 'none', fontWeight: 500 },
  },
  shape: { borderRadius: 6 },
  components: {
    // 緊湊型排版：全域預設 small，個別需要放大的地方再自己覆寫。
    MuiButton: {
      defaultProps: { size: 'small', disableElevation: true },
    },
    MuiTextField: {
      defaultProps: { size: 'small', variant: 'outlined' },
    },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiFormControl: { defaultProps: { size: 'small' } },
    MuiTable: { defaultProps: { size: 'small' } },
    MuiCheckbox: { defaultProps: { size: 'small' } },
    MuiRadio: { defaultProps: { size: 'small' } },
    MuiChip: { defaultProps: { size: 'small' } },
    MuiIconButton: { defaultProps: { size: 'small' } },
    // 卡片一律用 1px 邊框取代陰影，資訊密度高時陰影會讓畫面顯得雜亂。
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none' },
        outlined: { borderColor: '#E5E7EB' },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0, variant: 'outlined' },
      styleOverrides: { root: { borderColor: '#E5E7EB' } },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderColor: '#E5E7EB' },
        head: { fontWeight: 600, backgroundColor: '#FAFAFA', whiteSpace: 'nowrap' },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: { '&:last-child td': { borderBottom: 0 } },
      },
    },
    MuiTooltip: {
      defaultProps: { arrow: true },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { border: '1px solid #E5E7EB' },
        // 手機上把「內容型」對話框撐成整頁。用 maxWidth 產生的 class 來分流：
        //   sm／md → 幾乎都是表單，留邊界只是把可填的空間變小，整頁最好用
        //   xs     → 確認提示、單筆詳情這類短內容，維持置中小卡；
        //            把一句「確定要刪除嗎？」放大成整頁反而像出事了
        // 寫在 theme 而不是各頁加 fullScreen：一處生效，之後新增的對話框也自動適用。
        paperWidthSm: { [dialogFullScreenQuery]: dialogFullScreen },
        paperWidthMd: { [dialogFullScreenQuery]: dialogFullScreen },
      },
    },
  },
});

// 舊名稱保留：頁面仍以 `muiTheme` 匯入，改名會一次動到所有已遷移頁面，
// 沒有實質好處。兩個名字指向同一個 theme。
export const muiTheme = enterpriseTheme;

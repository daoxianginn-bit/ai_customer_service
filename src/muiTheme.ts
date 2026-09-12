import { createTheme } from '@mui/material/styles';
import { primary, gray, success, warning, danger, info, neutral, fontFamily, typeScale, radius, shadow, breakpoints } from './app/tokens';

// ========================================================================
// 全域 MUI Theme：依《民宿 AI 客服暨營運後台 V2》§6–7 實作。
//
// 所有數值來自 app/tokens.ts，這裡只負責把 token 對映到 MUI 的結構。
// 風格取向：專業、留白、資訊密度中等、靠邊框而不是陰影分層、不用高飽和整列底色。
// 新頁面一律用 theme token，不要自己寫死顏色／字級。
// ========================================================================

// 對話框改成整頁顯示的門檻：真正的手機寬度才整頁，平板上置中卡片仍然好用。
const dialogFullScreenQuery = `@media (max-width:${breakpoints.md - 0.05}px)`;
const dialogFullScreen = {
  margin: 0,
  width: '100%',
  maxWidth: '100%',
  height: '100%',
  maxHeight: '100%',
  borderRadius: 0,
  border: 'none',
} as const;

const px = (n: number) => `${n}px`;

export const appTheme = createTheme({
  breakpoints: { values: { ...breakpoints } },
  palette: {
    primary: { main: primary[600], light: primary[100], dark: primary[700], contrastText: '#FFFFFF' },
    secondary: { main: gray[600], light: gray[100], dark: gray[800], contrastText: '#FFFFFF' },
    success: { main: success[600], light: success[100], dark: success[700], contrastText: '#FFFFFF' },
    warning: { main: warning[600], light: warning[100], dark: warning[700], contrastText: '#FFFFFF' },
    error: { main: danger[600], light: danger[100], dark: danger[700], contrastText: '#FFFFFF' },
    info: { main: info[600], light: info[100], dark: info[700], contrastText: '#FFFFFF' },
    background: { default: neutral.background, paper: neutral.surface },
    text: { primary: neutral.text900, secondary: neutral.text600, disabled: neutral.text400 },
    divider: neutral.border,
    action: { hover: gray[50], selected: primary[100] },
  },
  typography: {
    fontFamily,
    fontSize: typeScale.body.size,
    h4: { fontSize: px(typeScale.pageTitle.size), lineHeight: px(typeScale.pageTitle.lineHeight), fontWeight: typeScale.pageTitle.weight },
    h5: { fontSize: px(typeScale.sectionTitle.size), lineHeight: px(typeScale.sectionTitle.lineHeight), fontWeight: typeScale.sectionTitle.weight },
    h6: { fontSize: px(typeScale.cardTitle.size), lineHeight: px(typeScale.cardTitle.lineHeight), fontWeight: typeScale.cardTitle.weight },
    subtitle1: { fontSize: px(typeScale.body.size), lineHeight: px(typeScale.body.lineHeight), fontWeight: 600 },
    subtitle2: { fontSize: px(typeScale.small.size), lineHeight: px(typeScale.small.lineHeight), fontWeight: 600 },
    body1: { fontSize: px(typeScale.body.size), lineHeight: px(typeScale.body.lineHeight) },
    body2: { fontSize: px(typeScale.small.size), lineHeight: px(typeScale.small.lineHeight) },
    caption: { fontSize: px(typeScale.caption.size), lineHeight: px(typeScale.caption.lineHeight) },
    button: { textTransform: 'none', fontWeight: 500, fontSize: px(typeScale.body.size) },
  },
  shape: { borderRadius: radius.small },
  shadows: [
    'none',
    shadow.card, shadow.card, shadow.card, shadow.card,
    shadow.overlay, shadow.overlay, shadow.overlay, shadow.overlay,
    shadow.overlay, shadow.overlay, shadow.overlay, shadow.overlay,
    shadow.overlay, shadow.overlay, shadow.overlay, shadow.overlay,
    shadow.overlay, shadow.overlay, shadow.overlay, shadow.overlay,
    shadow.overlay, shadow.overlay, shadow.overlay, shadow.overlay,
  ],
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { backgroundColor: neutral.background, color: neutral.text900 },
        // 手機上可點區域至少 44px（§89）
        '@media (max-width: 767.95px)': {
          '.MuiIconButton-root': { minWidth: 44, minHeight: 44 },
        },
      },
    },
    MuiButton: {
      defaultProps: { size: 'medium', disableElevation: true },
      styleOverrides: {
        root: { borderRadius: radius.input, minHeight: 36 },
        sizeSmall: { minHeight: 32 },
        outlined: { borderColor: neutral.border, color: neutral.text900, '&:hover': { borderColor: gray[300], backgroundColor: gray[50] } },
      },
    },
    MuiTextField: { defaultProps: { size: 'small', variant: 'outlined' } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { borderRadius: radius.input, backgroundColor: neutral.surface, '& fieldset': { borderColor: neutral.border } },
      },
    },
    MuiSelect: { defaultProps: { size: 'small' } },
    MuiFormControl: { defaultProps: { size: 'small' } },
    MuiFormHelperText: { styleOverrides: { root: { marginLeft: 0 } } },
    MuiTable: { defaultProps: { size: 'small' } },
    MuiCheckbox: { defaultProps: { size: 'small' } },
    MuiRadio: { defaultProps: { size: 'small' } },
    MuiChip: {
      defaultProps: { size: 'small' },
      styleOverrides: { root: { borderRadius: radius.small, fontWeight: 500 } },
    },
    MuiIconButton: { defaultProps: { size: 'small' } },
    // 卡片：1px 邊框 + 極淡陰影，不用重陰影
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: 'none' },
        outlined: { borderColor: neutral.border },
        rounded: { borderRadius: radius.card },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0, variant: 'outlined' },
      styleOverrides: { root: { borderColor: neutral.border, borderRadius: radius.card, boxShadow: shadow.card } },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { borderColor: neutral.border, fontSize: px(typeScale.body.size), paddingTop: 12, paddingBottom: 12 },
        head: { fontWeight: 600, color: neutral.text600, backgroundColor: gray[50], whiteSpace: 'nowrap', fontSize: px(typeScale.small.size) },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: { '&:last-child td': { borderBottom: 0 }, '&:hover td': { backgroundColor: gray[50] } },
      },
    },
    MuiTooltip: { defaultProps: { arrow: true } },
    MuiDialog: {
      styleOverrides: {
        paper: { border: `1px solid ${neutral.border}`, borderRadius: radius.modal, boxShadow: shadow.overlay },
        // 手機上把表單型對話框撐成整頁；xs（確認提示）維持置中小卡
        paperWidthSm: { [dialogFullScreenQuery]: dialogFullScreen },
        paperWidthMd: { [dialogFullScreenQuery]: dialogFullScreen },
      },
    },
    MuiDrawer: {
      styleOverrides: { paper: { boxShadow: 'none' } },
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 40 },
        indicator: { height: 2, backgroundColor: primary[600] },
      },
    },
    MuiTab: {
      styleOverrides: {
        root: { minHeight: 40, textTransform: 'none', fontWeight: 500, fontSize: px(typeScale.body.size), padding: '8px 12px', '&.Mui-selected': { color: primary[700], fontWeight: 600 } },
      },
    },
    MuiAlert: {
      styleOverrides: { root: { borderRadius: radius.input } },
    },
    MuiListItemButton: {
      styleOverrides: { root: { borderRadius: radius.small } },
    },
  },
});

// 舊名稱保留：頁面仍以 `muiTheme`／`enterpriseTheme` 匯入，三個名字指向同一個 theme。
export const muiTheme = appTheme;
export const enterpriseTheme = appTheme;

// ========================================================================
// V2 Design Token（依《民宿 AI 客服暨營運後台 V2》§7）
//
// 這是全站唯一的顏色／字級／圓角／陰影來源。MUI theme（muiTheme.ts）與 Tailwind
// （tailwind.config.js）都從這裡取值，兩套元件並存期間色系才會一致；新頁面一律用
// theme token，不要自己寫死色碼。
//
// 色彩原則：semantic 色只用在狀態／警告／錯誤／成功／重要操作，不當裝飾。
// ========================================================================

// 主色：沉穩自然色系（稻田、民宿、穩定）
export const primary = {
  50: '#F2F6F4',
  100: '#EAF1EE',  // 規格 Primary 100：淡底、選中態
  200: '#CFDFD8',
  300: '#A9C4B9',
  400: '#7A9E90',
  500: '#4F7D6B',  // 規格 Primary 500
  600: '#3F6B5A',  // 規格 Primary 600：主色
  700: '#345849',
  800: '#2A473B',
  900: '#21382F',
} as const;

// 中性色：背景／表面／邊框／文字三階
export const neutral = {
  background: '#F7F8FA',
  surface: '#FFFFFF',
  border: '#E6E8EC',
  text900: '#1F2937',
  text600: '#667085',
  text400: '#98A2B3',
} as const;

export const gray = {
  50: '#F7F8FA',
  100: '#F0F2F5',
  200: '#E6E8EC',
  300: '#D0D5DD',
  400: '#98A2B3',
  500: '#667085',
  600: '#475467',
  700: '#344054',
  800: '#1F2937',
  900: '#101828',
} as const;

export const success = { 50: '#EEF6F2', 100: '#D6EBE0', 500: '#2E7D5B', 600: '#2E7D5B', 700: '#25664A' } as const;
export const warning = { 50: '#FBF5EA', 100: '#F5E6C8', 500: '#B7791F', 600: '#B7791F', 700: '#9A651A' } as const;
export const danger  = { 50: '#FBF1F0', 100: '#F6DDDB', 500: '#C2413B', 600: '#C2413B', 700: '#A83730' } as const;
export const info    = { 50: '#EFF4FA', 100: '#DCE7F4', 500: '#3B6FB6', 600: '#3B6FB6', 700: '#315E9A' } as const;

// 字體：中文優先 Noto Sans TC，英數 Inter
export const fontFamily = 'Inter, "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

// 字級（px / 行高 / 字重）
export const typeScale = {
  pageTitle:    { size: 24, lineHeight: 32, weight: 600 },
  sectionTitle: { size: 18, lineHeight: 28, weight: 600 },
  cardTitle:    { size: 15, lineHeight: 24, weight: 600 },
  body:         { size: 14, lineHeight: 22, weight: 400 },
  small:        { size: 13, lineHeight: 20, weight: 400 },
  caption:      { size: 12, lineHeight: 18, weight: 400 },
} as const;

// 圓角：不要全面 20/24
export const radius = { small: 6, input: 8, card: 10, modal: 12 } as const;

// 陰影：主要靠邊框分層，這個只給卡片一點浮起；大型浮層（Dialog／Drawer）才用明顯陰影
export const shadow = {
  card: '0 1px 2px rgba(16,24,40,.04), 0 1px 3px rgba(16,24,40,.06)',
  overlay: '0 8px 24px rgba(16,24,40,.12), 0 2px 6px rgba(16,24,40,.06)',
} as const;

// 外殼尺寸
export const layout = {
  sidebarWidth: 248,
  sidebarCollapsedWidth: 72,
  topbarHeight: 60,
} as const;

// RWD 斷點（§16）。MUI 的 breakpoints.values 直接用這組。
export const breakpoints = { xs: 0, sm: 480, md: 768, lg: 1024, xl: 1440 } as const;

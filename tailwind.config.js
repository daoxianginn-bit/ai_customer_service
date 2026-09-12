/** @type {import('tailwindcss').Config} */
// 色票對映到 V2 Design Token（src/app/tokens.ts）。舊頁面用的是 Tailwind 的 green/gray/red/amber
// 語意名稱；這裡把那些名稱重新指到 V2 的色階，沒搬到 MUI 的舊頁就自動跟上新色系，
// 不用逐頁改 class。新頁面請用 MUI 元件與 theme token，不要再寫 Tailwind 顏色。
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        green: {
          50: '#F2F6F4', 100: '#EAF1EE', 200: '#CFDFD8', 300: '#A9C4B9', 400: '#7A9E90',
          500: '#4F7D6B', 600: '#3F6B5A', 700: '#345849', 800: '#2A473B', 900: '#21382F',
        },
        gray: {
          50: '#F7F8FA', 100: '#F0F2F5', 200: '#E6E8EC', 300: '#D0D5DD', 400: '#98A2B3',
          500: '#667085', 600: '#475467', 700: '#344054', 800: '#1F2937', 900: '#101828',
        },
        red: { 50: '#FBF1F0', 100: '#F6DDDB', 500: '#C2413B', 600: '#C2413B', 700: '#A83730' },
        amber: { 50: '#FBF5EA', 100: '#F5E6C8', 600: '#B7791F', 700: '#9A651A', 800: '#7D5215' },
        blue: { 50: '#EFF4FA', 100: '#DCE7F4', 600: '#3B6FB6', 700: '#315E9A', 800: '#284D7E' },
      },
      fontFamily: {
        sans: ['Inter', '"Noto Sans TC"', '"PingFang TC"', '"Microsoft JhengHei"', 'sans-serif'],
      },
      borderRadius: { DEFAULT: '6px', lg: '8px', xl: '10px', '2xl': '12px' },
    },
  },
  plugins: [],
}

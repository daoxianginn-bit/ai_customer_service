// ESLint 設定。package.json 一直有 lint script、devDependencies 也裝好了全部的 plugin，
// 但設定檔從來沒進版控，所以 `npm run lint` 一執行就報「找不到設定檔」。這份把它補回來。
//
// 幾條規則刻意放寬，對齊這個專案既有的寫法，而不是反過來要求改幾百處程式碼：
//   no-explicit-any        Supabase client 沒有產生型別，資料列一律當 any 收，全專案 400 多處
//   no-irregular-whitespace 全形空格（　）是中文排版用的分隔，出現在 LINE 訊息與畫面文字裡，不是打錯字
//   no-empty (catch)       `catch {}` 是「盡力而為、失敗就算了」的既定寫法（推播失敗不該中斷主流程）
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs', 'postcss.config.js', 'tailwind.config.js'],
  // plugins 保留 react-refresh：規則雖然關掉，但拿掉 plugin 會讓上面那行設定變成錯誤
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true, skipComments: true, skipJSXText: true }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    // 底線開頭的參數代表「這裡用不到，但簽章需要它」
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // Provider 元件與它的 useXxx hook 放同一個檔案是這個專案（也是 React 社群）的慣用寫法。
    // 這條規則只影響 HMR 的熱更新粒度，不是正確性問題，為了它把檔案拆開並不划算。
    'react-refresh/only-export-components': 'off',
  },
  overrides: [
    {
      // Netlify Functions 跑在 Node，不是瀏覽器
      files: ['netlify/**/*.ts'],
      env: { node: true, browser: false },
    },
  ],
};

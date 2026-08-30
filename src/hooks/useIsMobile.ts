import { useEffect, useState } from 'react';

/**
 * 視窗是否窄於指定寬度。預設 768px 是 Tailwind 的 md 斷點，
 * 跟頁面內容裡的 md:* class 對齊，才不會出現「JS 覺得是手機、CSS 覺得是桌機」的錯位。
 *
 * 這裡跟外殼（Layout）用的 900px 刻意不同，不是漏改：
 * 側欄要讓出 240px，所以得更早收起來；表格則是只要放得下就該用表格。
 */
export function useIsMobile(maxWidth = 768): boolean {
  // 斷點用 max-width 表示要減掉一點，否則剛好等於 768px 時會同時符合
  // md:* （min-width:768px）和這裡的判斷，兩邊打架。
  const query = `(max-width:${maxWidth - 0.05}px)`;

  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    // 訂閱前先同步一次：從掛載到這裡之間視窗可能已經變了。
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return isMobile;
}

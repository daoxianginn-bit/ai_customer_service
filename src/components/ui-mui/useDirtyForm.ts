import { useCallback, useEffect, useMemo, useState } from 'react';

// ========================================================================
// 表單「有沒有改過」的追蹤，供 FormPanel 的未儲存防呆使用。
//
// 判斷方式是拿目前值跟初始值做深度比較，而不是「使用者有沒有打過字」——
// 後者會把「改了又改回原值」誤判成有變更，使用者會覺得系統在亂攔。
//
// 另外掛上 beforeunload：直接關分頁/重新整理時，瀏覽器會跳原生的離開確認。
// 這個只能擋瀏覽器層級的離開，元件內的關閉由 FormPanel 自己處理。
// ========================================================================

function stableStringify(value: any): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // 物件的 key 順序不該影響「有沒有改過」的判斷
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

export function useDirtyForm<T>(initial: T) {
  const [baseline, setBaseline] = useState<T>(initial);
  const [value, setValue] = useState<T>(initial);

  const dirty = useMemo(() => stableStringify(value) !== stableStringify(baseline), [value, baseline]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  /** 重新開啟表單時呼叫：同時重設目前值與比較基準 */
  const reset = useCallback((next: T) => {
    setBaseline(next);
    setValue(next);
  }, []);

  /** 儲存成功後呼叫：把目前值變成新的比較基準，dirty 歸零 */
  const commit = useCallback(() => setBaseline(value), [value]);

  return { value, setValue, dirty, reset, commit };
}

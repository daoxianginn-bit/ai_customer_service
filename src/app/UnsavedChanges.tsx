import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConfirm } from '../components/ui-mui/ConfirmDialogProvider';

// ========================================================================
// 未儲存離開防護（V2 §123、§129-9）。
//
// 頁面用 useUnsavedChanges(dirty) 登記「我有沒改過還沒存」；AppLayout 在捕獲階段攔下所有站內連結
// （側欄、頁籤、麵包屑、內文連結）的點擊，dirty 時先問「要放棄變更嗎？」再走。
// 為什麼不用 react-router 的 useBlocker：那需要 createBrowserRouter（data router），這個專案用
// BrowserRouter；換 router 影響整個 App.tsx 的路由宣告方式，不值得為這一件事動。
// 瀏覽器層級的離開（重新整理、關分頁）另外由各頁的 beforeunload 處理；上一頁／下一頁攔不到，接受。
// ========================================================================

interface Ctx {
  dirty: boolean;
  setDirty: (v: boolean) => void;
  /** 有未儲存變更時先確認，回傳 true 代表可以離開 */
  confirmLeave: () => Promise<boolean>;
}

const UnsavedContext = createContext<Ctx | null>(null);

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false);
  const confirm = useConfirm();
  const location = useLocation();
  // 換頁後一定歸零：舊頁面 unmount 時會自己清，這是保險
  useEffect(() => { setDirty(false); }, [location.pathname]);

  const confirmLeave = useCallback(async () => {
    if (!dirty) return true;
    return confirm({ title: '尚未儲存的變更', message: '離開這一頁會放棄目前的修改，確定要離開嗎？', confirmLabel: '放棄變更', danger: true, cancelLabel: '留在這頁' });
  }, [dirty, confirm]);

  return <UnsavedContext.Provider value={{ dirty, setDirty, confirmLeave }}>{children}</UnsavedContext.Provider>;
}

/** 頁面呼叫：dirty 變化時同步到外殼；unmount 時清掉。 */
export function useUnsavedChanges(dirty: boolean) {
  const ctx = useContext(UnsavedContext);
  const set = ctx?.setDirty;
  useEffect(() => {
    set?.(dirty);
    return () => set?.(false);
  }, [dirty, set]);
}

export function useConfirmLeave(): () => Promise<boolean> {
  const ctx = useContext(UnsavedContext);
  return ctx?.confirmLeave ?? (async () => true);
}

/**
 * 掛在外殼根節點：攔截站內 <a href> 的點擊。只處理「同源、非新分頁、非修飾鍵」的普通左鍵點擊，
 * 其他一律放行（開新分頁本來就不會丟失變更）。
 */
export function useInterceptInternalLinks() {
  const ctx = useContext(UnsavedContext);
  const navigate = useNavigate();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  return useCallback(async (e: React.MouseEvent) => {
    const c = ctxRef.current;
    if (!c?.dirty) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin) return;
    if (url.pathname === window.location.pathname && url.search === window.location.search) return;
    e.preventDefault();
    e.stopPropagation();
    if (await c.confirmLeave()) {
      c.setDirty(false);
      navigate(url.pathname + url.search + url.hash);
    }
  }, [navigate]);
}

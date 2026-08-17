import { useCallback, useEffect, useRef, useState } from 'react';

// ========================================================================
// 查詢競態防護（規範：「請求具備 AbortController 防競態」）。
//
// 問題情境：使用者在篩選卡快速改條件，送出 A、B 兩次查詢，若 A 比 B 晚回來，
// 畫面就會顯示 A 的結果、但篩選條件顯示的是 B——資料跟條件對不起來，而且
// 使用者完全看不出哪裡怪。
//
// Supabase 的 JS client 沒有統一的 abort 介面（各 builder 支援程度不一），
// 所以這裡用「請求世代編號」實作：每次查詢遞增 seq，回來時若不是最新的一次就整包丟棄。
// 同時把 AbortSignal 一併交給呼叫端，需要真正中止 fetch 的地方（例如 Netlify function）
// 可以直接用。
// ========================================================================

interface State<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
}

// Supabase 丟出來的是 PostgrestError 這種「長得像錯誤但不是 Error 實例」的普通物件，
// 直接 String(e) 會變成 "[object Object]"，錯誤訊息整個消失、頁面上只看得到一句
// 「查詢失敗：[object Object]」。這裡把常見的 message/error_description 撈出來。
function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === 'object') {
    const o = e as Record<string, any>;
    const msg = o.message || o.error_description || o.error || o.details || o.hint;
    if (msg) {
      const err = new Error(String(msg));
      // 保留原始欄位，呼叫端要判斷 code（例如 23505 重複鍵）時還拿得到
      Object.assign(err, o);
      return err;
    }
  }
  return new Error(String(e));
}

export function useAbortableQuery<T>(initialData?: T) {
  const [state, setState] = useState<State<T>>({ data: initialData, loading: false, error: null });
  const seqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  const run = useCallback(async (fetcher: (signal: AbortSignal) => Promise<T>) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const seq = ++seqRef.current;

    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetcher(controller.signal);
      // 過期的回應直接丟棄，不要覆蓋比較新的結果
      if (seq !== seqRef.current || !mountedRef.current) return;
      setState({ data, loading: false, error: null });
    } catch (e: any) {
      if (seq !== seqRef.current || !mountedRef.current) return;
      if (e?.name === 'AbortError') return;
      setState((s) => ({ ...s, loading: false, error: toError(e) }));
    }
  }, []);

  return { ...state, run };
}

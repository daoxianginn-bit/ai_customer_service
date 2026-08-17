import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, TextField, Typography,
} from '@mui/material';

// ========================================================================
// 二次確認對話框：以 Promise Hook 形式提供，呼叫端寫起來像 window.confirm()，
// 但外觀是 MUI 對話框、而且支援「重要資源要輸入名稱才能刪除」。
//
//   const confirm = useConfirm();
//   if (!(await confirm({ title: '刪除房型', danger: true }))) return;
//
// 為什麼做成 Promise 而不是傳 onConfirm callback：頁面上每多一個可刪除的東西，
// callback 寫法就要多一組 useState（開/關、目標物件、處理中），CRUD 頁面很快就被
// 這些狀態淹沒。改成 await 之後，刪除邏輯可以直接寫在事件處理函式裡，順著讀下來。
// ========================================================================

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破壞性操作：確認鈕轉紅色（規範要求 color="error"） */
  danger?: boolean;
  /**
   * 重要資源的雙重確認：填入資源名稱後，使用者必須一字不差輸入該名稱才能按下確認。
   * 用在「刪掉會連帶影響其他資料」的對象（房型、流程），一般資料不要用，會變成干擾。
   */
  requireTypedText?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm() 必須放在 <ConfirmDialogProvider> 底下使用');
  return ctx;
}

export default function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState('');
  // resolve 存在 ref 而不是 state：它只是「這次對話框關閉時要呼叫誰」，
  // 放進 state 會多觸發一次沒有意義的重繪。
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    setOptions(opts);
    setTyped('');
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const close = (result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
    setTyped('');
  };

  const needsTyping = !!options?.requireTypedText;
  const canConfirm = !needsTyping || typed.trim() === options?.requireTypedText;

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={!!options}
        onClose={() => close(false)}
        maxWidth="xs"
        fullWidth
        // 需要打字確認時不允許點背景關閉，避免使用者以為自己按到取消
        disableEscapeKeyDown={needsTyping}
      >
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>{options?.title}</DialogTitle>
        <DialogContent>
          {options?.message && (
            typeof options.message === 'string'
              ? <DialogContentText sx={{ fontSize: 14 }}>{options.message}</DialogContentText>
              : options.message
          )}
          {needsTyping && (
            <>
              <Typography variant="body2" sx={{ mt: 2, mb: 1 }}>
                請輸入 <strong>{options?.requireTypedText}</strong> 以確認：
              </Typography>
              <TextField
                autoFocus
                fullWidth
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={options?.requireTypedText}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canConfirm) close(true);
                }}
              />
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button variant="outlined" color="inherit" onClick={() => close(false)}>
            {options?.cancelLabel || '取消'}
          </Button>
          <Button
            variant="contained"
            color={options?.danger ? 'error' : 'primary'}
            disabled={!canConfirm}
            onClick={() => close(true)}
          >
            {options?.confirmLabel || '確認'}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** 便利包裝：刪除單筆資料的標準確認文案，避免每個頁面各寫一套說法。 */
export function useConfirmDelete() {
  const confirm = useConfirm();
  return useCallback(
    (name: string, extra?: ReactNode, requireTyped = false) =>
      confirm({
        title: `確定要刪除「${name}」嗎？`,
        message: extra ?? '刪除後無法復原。',
        confirmLabel: '刪除',
        danger: true,
        requireTypedText: requireTyped ? name : undefined,
      }),
    [confirm]
  );
}

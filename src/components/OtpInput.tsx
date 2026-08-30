import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Box, TextField } from '@mui/material';

// ========================================================================
// 6 格一次性驗證碼輸入元件。
//
// 行為需求（依規格）：
//   - 6 格獨立輸入框、純數字（手機要跳數字鍵盤 → inputMode="numeric"）
//   - 輸入自動跳下一格
//   - Backspace 智慧退格：本格有值先清本格，本格已空才退到上一格
//   - 支援整串貼上（從簡訊/驗證器複製 6 碼直接貼進來，不用一格一格填）
//   - 填滿 6 碼自動觸發 onComplete，不用再按一次按鈕
// ========================================================================

interface OtpInputProps {
  length?: number;
  onComplete: (code: string) => void;
  disabled?: boolean;
  /** 驗證失敗時傳 true：會清空並把游標移回第一格，讓使用者直接重打 */
  resetSignal?: number;
  autoFocus?: boolean;
  error?: boolean;
}

export default function OtpInput({
  length = 6,
  onComplete,
  disabled,
  resetSignal = 0,
  autoFocus = true,
  error,
}: OtpInputProps) {
  const [values, setValues] = useState<string[]>(() => Array(length).fill(''));
  const inputsRef = useRef<(HTMLInputElement | null)[]>([]);
  // 避免同一組驗證碼重複觸發 onComplete（例如 React 重繪或使用者改了又改回來）
  const lastSubmitted = useRef<string>('');

  useEffect(() => {
    if (resetSignal === 0) return;
    setValues(Array(length).fill(''));
    lastSubmitted.current = '';
    inputsRef.current[0]?.focus();
  }, [resetSignal, length]);

  useEffect(() => {
    if (autoFocus) inputsRef.current[0]?.focus();
  }, [autoFocus]);

  const commit = (next: string[]) => {
    setValues(next);
    const code = next.join('');
    if (code.length === length && !next.includes('') && code !== lastSubmitted.current) {
      lastSubmitted.current = code;
      onComplete(code);
    }
  };

  const handleChange = (index: number, raw: string) => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) return;

    const next = [...values];
    // 一次輸入多個字元（例如貼上或注音輸入法整串送出）時，從目前這格往後依序填入
    for (let i = 0; i < digits.length && index + i < length; i++) {
      next[index + i] = digits[i];
    }
    commit(next);

    const nextFocus = Math.min(index + digits.length, length - 1);
    inputsRef.current[nextFocus]?.focus();
    inputsRef.current[nextFocus]?.select();
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const next = [...values];
      if (next[index]) {
        // 本格有值：只清本格，游標留在原地（使用者通常是要改這一格）
        next[index] = '';
        setValues(next);
        lastSubmitted.current = '';
        return;
      }
      // 本格已空：退到上一格並清掉它
      if (index > 0) {
        next[index - 1] = '';
        setValues(next);
        lastSubmitted.current = '';
        inputsRef.current[index - 1]?.focus();
      }
      return;
    }

    if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      inputsRef.current[index - 1]?.focus();
    }
    if (e.key === 'ArrowRight' && index < length - 1) {
      e.preventDefault();
      inputsRef.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!digits) return;
    const next = Array(length).fill('');
    for (let i = 0; i < digits.length; i++) next[i] = digits[i];
    commit(next);
    inputsRef.current[Math.min(digits.length, length - 1)]?.focus();
  };

  return (
    <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }} onPaste={handlePaste}>
      {values.map((value, index) => (
        <TextField
          key={index}
          value={value}
          disabled={disabled}
          error={error}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onFocus={(e) => e.target.select()}
          inputRef={(el) => { inputsRef.current[index] = el; }}
          inputProps={{
            inputMode: 'numeric',
            // 讓 iOS/Android 的簡訊自動填入能認得這是一次性驗證碼
            autoComplete: index === 0 ? 'one-time-code' : 'off',
            maxLength: length, // 允許整串貼上後由 handleChange 拆開，不是限制成 1
            'aria-label': `驗證碼第 ${index + 1} 碼`,
            style: { textAlign: 'center', fontSize: 24, fontWeight: 600, padding: '12px 0' },
          }}
          sx={{ width: 52 }}
        />
      ))}
    </Box>
  );
}

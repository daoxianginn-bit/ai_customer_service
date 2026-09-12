import { useState } from 'react';
import { IconButton, InputAdornment, TextField, Tooltip, type TextFieldProps } from '@mui/material';
import { useSnackbar } from 'notistack';
import { Copy, Eye, EyeOff } from 'lucide-react';

// ========================================================================
// 敏感欄位（V2 §57）：API Key、LINE Secret、服務帳號金鑰。
// 預設遮罩，提供 [顯示] [複製]。不把金鑰明文長期顯示在畫面上（§129-12）。
// ========================================================================
export default function SecretField(props: TextFieldProps) {
  const [visible, setVisible] = useState(false);
  const { enqueueSnackbar } = useSnackbar();
  const value = String(props.value ?? '');

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      enqueueSnackbar('已複製', { variant: 'success', autoHideDuration: 1500 });
    } catch {
      enqueueSnackbar('無法存取剪貼簿', { variant: 'warning' });
    }
  };

  // password 型別的 input 不能多行：金鑰 JSON 這種長內容遮罩時先用單行顯示點點，按「顯示」才展開成多行
  return (
    <TextField
      {...props}
      multiline={visible ? props.multiline : false}
      minRows={visible ? props.minRows : undefined}
      type={visible ? 'text' : 'password'}
      autoComplete="off"
      InputProps={{
        ...props.InputProps,
        endAdornment: (
          <InputAdornment position="end">
            <Tooltip title={visible ? '隱藏' : '顯示'}>
              <IconButton onClick={() => setVisible((v) => !v)} edge="end" aria-label={visible ? '隱藏' : '顯示'} size="small">
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
              </IconButton>
            </Tooltip>
            <Tooltip title="複製">
              <span>
                <IconButton onClick={copy} edge="end" aria-label="複製" size="small" disabled={!value}><Copy size={16} /></IconButton>
              </span>
            </Tooltip>
          </InputAdornment>
        ),
      }}
    />
  );
}

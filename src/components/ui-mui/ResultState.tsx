import type { ReactNode } from 'react';
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { Ban, FileQuestion, Inbox, ServerCrash } from 'lucide-react';

// ========================================================================
// 規範回饋機制的最高層：中斷性重大錯誤（403/404/500）用全頁狀態卡呈現，
// 附帶重試與返回按鈕——這類錯誤下畫面沒有任何可用內容，用 Toast 提示等於
// 讓使用者盯著一片空白猜發生什麼事。
//
// 順便涵蓋 empty（查無資料），它雖然不是錯誤，但同樣需要「一個圖示 + 一句說明 +
// 一個下一步動作」的版面，共用同一個元件比較不會長出兩套風格。
// ========================================================================

export type ResultStatus = 403 | 404 | 500 | 'empty';

const PRESET: Record<string, { icon: ReactNode; title: string; description: string }> = {
  403: {
    icon: <Ban size={40} />,
    title: '權限不足',
    description: '你的帳號沒有檢視這個頁面的權限，如需存取請聯繫管理員。',
  },
  404: {
    icon: <FileQuestion size={40} />,
    title: '找不到資料',
    description: '這筆資料可能已被刪除，或網址不正確。',
  },
  500: {
    icon: <ServerCrash size={40} />,
    title: '伺服器發生錯誤',
    description: '系統暫時無法處理這個請求，請稍後再試一次。',
  },
  empty: {
    icon: <Inbox size={40} />,
    title: '沒有資料',
    description: '目前查詢條件下沒有任何資料。',
  },
};

interface ResultStateProps {
  status: ResultStatus;
  title?: string;
  description?: ReactNode;
  /** 提供重試行為時才顯示「重新載入」 */
  onRetry?: () => void;
  /** 預設回首頁；傳 false 可隱藏返回鈕（例如就地顯示的空狀態） */
  backTo?: string | false;
  action?: ReactNode;
}

export default function ResultState({ status, title, description, onRetry, backTo = '/', action }: ResultStateProps) {
  const navigate = useNavigate();
  const preset = PRESET[String(status)];
  const isError = status !== 'empty';

  return (
    <Paper variant="outlined" sx={{ p: 6 }}>
      <Stack alignItems="center" spacing={1.5} textAlign="center">
        <Box sx={{ color: isError ? 'error.main' : 'text.disabled', display: 'flex' }}>{preset.icon}</Box>
        <Typography variant="h6">{title ?? preset.title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>
          {description ?? preset.description}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ pt: 1 }}>
          {onRetry && <Button variant="contained" onClick={onRetry}>重新載入</Button>}
          {backTo !== false && (
            <Button variant="outlined" color="inherit" onClick={() => navigate(backTo)}>返回</Button>
          )}
          {action}
        </Stack>
      </Stack>
    </Paper>
  );
}

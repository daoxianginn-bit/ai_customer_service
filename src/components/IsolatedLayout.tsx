import { Box, Card, CardContent, Stack, Typography } from '@mui/material';
import { Settings } from 'lucide-react';
import type { ReactNode } from 'react';

// ========================================================================
// 封閉式佈局：2FA 綁定與驗證頁專用。
//
// 依規格「禁止出現任何後台業務功能或選單」——這不只是視覺上的乾淨，而是安全設計：
// 這些頁面出現時，使用者的 session 還是 aal1（尚未通過第二因素），如果畫面上還留著
// 側邊欄或麵包屑，就等於給了他一條「不完成 2FA 直接點進後台」的路。
//
// 實際的資料防線仍在 RLS（aal1 讀不到任何一張表），這一層是避免使用者看到
// 點了會出錯的東西、以及避免誤以為自己已經登入完成。
// ========================================================================

interface IsolatedLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** 卡片底部的次要動作，例如「改用其他帳號登入」 */
  footer?: ReactNode;
  maxWidth?: number;
}

export default function IsolatedLayout({ title, subtitle, children, footer, maxWidth = 460 }: IsolatedLayoutProps) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'background.default',
        p: 2,
      }}
    >
      <Card sx={{ width: '100%', maxWidth, borderRadius: 3 }} elevation={3}>
        <CardContent sx={{ p: 4 }}>
          <Stack spacing={1} alignItems="center" sx={{ mb: 3 }}>
            <Box
              sx={{
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                borderRadius: 2,
                width: 52,
                height: 52,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                mb: 1,
              }}
            >
              <Settings size={26} />
            </Box>
            <Typography variant="h6" fontWeight={700} textAlign="center">{title}</Typography>
            {subtitle && (
              <Typography variant="body2" color="text.secondary" textAlign="center">
                {subtitle}
              </Typography>
            )}
          </Stack>

          {children}

          {footer && <Box sx={{ mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>{footer}</Box>}
        </CardContent>
      </Card>
    </Box>
  );
}

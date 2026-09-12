import type { ReactNode } from 'react';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { Box, Button, Card, CardContent, Divider, Skeleton, Stack, Typography } from '@mui/material';
import ResultState from './ResultState';
import { useSnackbar } from 'notistack';
import { Save } from 'lucide-react';
import { useBreakpoint } from '../../app/useBreakpoint';
import PageHeaderV2 from './PageHeaderV2';

// ========================================================================
// 設定頁外殼（V2 §81–82 Save Pattern）。
//
// 長設定頁不把「儲存」放在頁首：改成底部固定的儲存列，只在有未儲存變更時出現，
// 上面寫「尚有未儲存變更」，右邊 [取消變更] [儲存]。手機固定底部只留 [儲存]。
// 頁面內容用 SettingsSection 分區，每區一張卡片、一個標題、一句說明。
// ========================================================================

interface SettingsShellProps {
  loading: boolean;
  /** 讀取失敗的訊息；有值時顯示錯誤狀態與重試（§77） */
  loadError?: string | null;
  onRetry?: () => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onDiscard: () => void;
  /** 儲存成功的提示文字 */
  savedMessage?: string;
  title?: string;
  description?: string;
  /** 頁首右側的次要操作（例如「測試連線」） */
  headerSecondary?: ReactNode;
  children: ReactNode;
}

export default function SettingsShell({ loading, loadError, onRetry, dirty, saving, onSave, onDiscard, savedMessage = '設定已儲存', title, description, headerSecondary, children }: SettingsShellProps) {
  useUnsavedChanges(!!dirty && !saving);
  const { enqueueSnackbar } = useSnackbar();
  const { isMobile } = useBreakpoint();

  const save = async () => {
    const r = await onSave();
    if (r.ok) enqueueSnackbar(savedMessage, { variant: 'success' });
    else enqueueSnackbar(`儲存失敗：${r.error}`, { variant: 'error' });
  };

  return (
    <Box sx={{ pb: dirty ? 10 : 0 }}>
      <PageHeaderV2 title={title} description={description} secondary={headerSecondary} />

      {!loading && loadError ? (
        <ResultState status={500} title="無法載入設定" description={`系統暫時無法取得資料。${loadError}`} onRetry={onRetry} backTo={false} />
      ) : loading ? (
        <Stack spacing={2}>
          {[0, 1].map((i) => (
            <Card key={i}><CardContent><Skeleton width={160} height={24} /><Skeleton height={40} sx={{ mt: 1 }} /><Skeleton height={40} /></CardContent></Card>
          ))}
        </Stack>
      ) : (
        <Stack spacing={2.5}>{children}</Stack>
      )}

      {/* 底部儲存列：只在有變更時出現 */}
      {dirty && !loading && (
        <Box
          sx={{
            position: 'fixed', left: { xs: 0, lg: 'var(--sidebar-offset, 0px)' }, right: 0, bottom: 0, zIndex: (t) => t.zIndex.appBar,
            bgcolor: 'background.paper', borderTop: '1px solid', borderColor: 'divider',
            px: { xs: 1.5, md: 3 }, py: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2,
            boxShadow: '0 -4px 12px rgba(16,24,40,.06)',
          }}
        >
          {!isMobile && <Typography variant="body2" color="text.secondary">尚有未儲存變更</Typography>}
          <Stack direction="row" spacing={1} sx={{ ml: 'auto', width: isMobile ? '100%' : 'auto' }}>
            {!isMobile && <Button variant="outlined" onClick={onDiscard} disabled={saving}>取消變更</Button>}
            <Button variant="contained" onClick={save} disabled={saving} startIcon={<Save size={16} />} fullWidth={isMobile}>
              {saving ? '儲存中…' : '儲存'}
            </Button>
          </Stack>
        </Box>
      )}
    </Box>
  );
}

// 設定區塊：標題 + 說明 + 內容。每區一張卡片。
export function SettingsSection({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Card>
      <CardContent sx={{ p: { xs: 2, md: 3 }, '&:last-child': { pb: { xs: 2, md: 3 } } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: description ? 0.5 : 2 }}>
          <Typography variant="h6">{title}</Typography>
          {action}
        </Box>
        {description && <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{description}</Typography>}
        <Divider sx={{ mb: 2.5 }} />
        {children}
      </CardContent>
    </Card>
  );
}

import { Outlet, Link as RouterLink, useLocation } from 'react-router-dom';
import { Box, Tab, Tabs } from '@mui/material';
import { usePermissions } from '../app/PermissionContext';
import { resolveNav } from '../app/navigation';

// ========================================================================
// 模組外殼：第二層頁籤（V2 §4、§9-1）。
//
// 側欄只到第一層，每個模組（訂房營運、客服與 AI…）進來後，上方一排頁籤切換第二層頁面。
// 頁籤從 navigation.ts 的 children 讀，依權限過濾；手機可橫向捲動（§133）。
// 詳情頁（/bookings/:id）沒有對應頁籤時仍顯示頁籤列，方便回到列表。
// ========================================================================
export default function ModuleShell() {
  const location = useLocation();
  const { hasPermission } = usePermissions();
  const resolved = resolveNav(location.pathname);
  const tabs = (resolved?.item.children || []).filter((c) => hasPermission(c.permission));

  // 只有一個頁籤（或沒有）就不顯示頁籤列，畫面留給內容
  if (tabs.length <= 1) return <Outlet />;

  const current = tabs.find((t) => t.path === location.pathname)?.path
    ?? tabs.find((t) => t.path !== resolved?.item.path && location.pathname.startsWith(t.path + '/'))?.path
    ?? (location.pathname.startsWith(resolved!.item.path) ? tabs[0].path : false);

  return (
    <Box>
      <Tabs
        value={current}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        sx={{ mb: 2, borderBottom: '1px solid', borderColor: 'divider', '& .MuiTabs-scrollButtons.Mui-disabled': { opacity: 0.3 } }}
      >
        {tabs.map((t) => (
          <Tab key={t.path} value={t.path} label={t.label} component={RouterLink} to={t.path} />
        ))}
      </Tabs>
      <Outlet />
    </Box>
  );
}

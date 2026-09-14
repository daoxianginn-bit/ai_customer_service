import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { SnackbarProvider } from 'notistack';
import { appTheme } from './muiTheme';
import ConfirmDialogProvider from './components/ui-mui/ConfirmDialogProvider';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { PermissionProvider, usePermissions } from './app/PermissionContext';
import ResultState from './components/ui-mui/ResultState';
import { canAccessRoute, defaultRouteFor } from './lib/permissions';
import { LEGACY_REDIRECTS } from './app/navigation';
import AppLayout from './layouts/AppLayout';
import ModuleShell from './layouts/ModuleShell';

// 登入與 2FA
import Login from './pages/Login';
import InviteVerify from './pages/auth/InviteVerify';
import Setup2FA from './pages/auth/Setup2FA';
import Verify2FA from './pages/auth/Verify2FA';

// 工作台
import DashboardPage from './features/dashboard/DashboardPage';
import ProcessPage from './features/process/ProcessPage';
// 訂房營運
import BookingListPage from './features/booking/BookingListPage';
import BookingDetailPage from './features/booking/BookingDetailPage';
import BookingConflictsPage from './features/booking/BookingConflictsPage';
import TaskCenterPage from './features/tasks/TaskCenterPage';
import RoomCalendar from './pages/RoomCalendar';
// 客服與 AI
import ServiceWorkbenchPage from './features/service/ServiceWorkbenchPage';
import HandoverHistoryPage from './features/service/HandoverHistoryPage';
import StandardMessages from './pages/StandardMessages';
import KnowledgeBase from './pages/KnowledgeBase';
import HandoverRules from './pages/service/HandoverRules';
// 客戶與行銷
import CustomerListPage from './features/customers/CustomerListPage';
import CustomerDetailPage from './features/customers/CustomerDetailPage';
import CustomMessageSending from './pages/CustomMessageSending';
// 房務
import LinenManagement from './pages/LinenManagement';
import HousekeepingOverviewPage from './features/housekeeping/HousekeepingOverviewPage';
import LaundryPage from './features/housekeeping/LaundryPage';
// 房型與空間
import RoomSpaceManagement from './pages/RoomSpaceManagement';
// 價格中心
import PricingOverview from './pages/pricing/Overview';
import FormulaSettings from './pages/pricing/FormulaSettings';
import QuoteCalculator from './pages/pricing/QuoteCalculator';
// 串接管理
import LineChannels from './pages/integrations/LineChannels';
import OtaChannels from './pages/integrations/OtaChannels';
import GoogleCalendarSettings from './pages/integrations/GoogleCalendarSettings';
import NotificationGroups from './pages/integrations/NotificationGroups';
// 自動化
import ScheduledTasks from './pages/ScheduledTasks';
import AutomationHistory from './pages/automation/AutomationHistory';
// 系統管理
import PropertySettings from './pages/admin/PropertySettings';
import AiEngineSettings from './pages/admin/AiEngineSettings';
import BookingRulesSettings from './pages/admin/BookingRulesSettings';
import UsersPage from './features/admin/UsersPage';
import UserDetailPage from './features/admin/UserDetailPage';
import RolesPage from './features/admin/RolesPage';
import RoleEditorPage from './features/admin/RoleEditorPage';
import SecuritySettings from './pages/admin/SecuritySettings';
// 帳號與權限／參數設定／紀錄：2026-09 從系統管理拆出來的獨立入口
import ParametersPage from './features/parameters/ParametersPage';
import LogsPage from './features/activity-log/LogsPage';

const envMissing = !import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL.includes('placeholder');

// 半受保護路由：只有處在對應 2FA 階段的人才會被導到這裡
const PRE_AUTH_PATHS = ['/auth/setup-2fa', '/auth/verify-2fa'];
// 完全公開路由：不需要任何 session
const PUBLIC_PATHS = ['/login', '/auth/invite-verify'];

function FullScreenSpinner({ message }: { message: string }) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Stack spacing={2} alignItems="center">
        <CircularProgress />
        <Typography variant="body2" color="text.secondary">{message}</Typography>
      </Stack>
    </Box>
  );
}

/**
 * 路徑層級的權限守衛（只在使用者已完成 2FA、進到後台之後才會用到）。
 * 權限從 app/navigation.ts 的宣告取（見 lib/permissions.ts 的 canAccessRoute），
 * 沒權限的人靜靜導回自己進得去的頁面。
 *
 * 這只是介面層的引導，不是安全防線。真正擋住資料的是資料庫的 RLS（§74、§129-13）。
 */
function RequireAccess({ children }: { children: ReactNode }) {
  const { permissions } = usePermissions();
  const location = useLocation();
  // 直接輸入網址沒權限：明確顯示 403，不要默默導回首頁（權限管理 V2 §30）
  if (!canAccessRoute(permissions, location.pathname)) {
    return (
      <ResultState
        status={403}
        title="您沒有權限查看此頁面"
        description="如需使用此功能，請聯絡系統管理員調整角色權限。"
        backTo={defaultRouteFor(permissions)}
      />
    );
  }
  return <>{children}</>;
}

const guarded = (el: ReactNode) => <RequireAccess>{el}</RequireAccess>;

function AppRoutes() {
  const { phase } = useAuth();
  const { loaded: permissionsLoaded } = usePermissions();
  const location = useLocation();
  const path = location.pathname;

  if (phase === 'loading') return <FullScreenSpinner message="系統載入中..." />;
  if (phase === 'accepting-invite') return <FullScreenSpinner message="確認邀請資格中..." />;
  // 權限還沒取回前不畫側欄：避免先顯示全部入口再逐一消失（§72）
  if (phase === 'ready' && !permissionsLoaded) return <FullScreenSpinner message="驗證帳號與權限..." />;

  if (phase === 'anonymous' || phase === 'blocked') {
    if (!PUBLIC_PATHS.includes(path)) return <Navigate to="/login" replace />;
  }
  if (phase === 'needs-mfa-setup' && path !== '/auth/setup-2fa') return <Navigate to="/auth/setup-2fa" replace />;
  if (phase === 'needs-mfa-verify' && path !== '/auth/verify-2fa') return <Navigate to="/auth/verify-2fa" replace />;
  if (phase === 'ready' && (PUBLIC_PATHS.includes(path) || PRE_AUTH_PATHS.includes(path))) return <Navigate to="/" replace />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/invite-verify" element={<InviteVerify />} />
      <Route path="/auth/setup-2fa" element={<Setup2FA />} />
      <Route path="/auth/verify-2fa" element={<Verify2FA />} />

      <Route element={<AppLayout />}>
        {/* 工作台 */}
        <Route path="/" element={guarded(<DashboardPage />)} />

        {/* 營運 */}
        <Route path="/bookings" element={<ModuleShell />}>
          <Route path="process" element={guarded(<ProcessPage />)} />
          <Route index element={guarded(<BookingListPage />)} />
          <Route path="calendar" element={guarded(<RoomCalendar />)} />
          <Route path="tasks" element={guarded(<TaskCenterPage />)} />
          <Route path="conflicts" element={guarded(<BookingConflictsPage />)} />
          <Route path=":id" element={guarded(<BookingDetailPage />)} />
        </Route>
        <Route path="/service" element={<ModuleShell />}>
          <Route index element={guarded(<ServiceWorkbenchPage />)} />
          <Route path="handovers" element={guarded(<HandoverHistoryPage />)} />
          <Route path="flows" element={guarded(<StandardMessages />)} />
          <Route path="knowledge" element={guarded(<KnowledgeBase />)} />
          <Route path="rules" element={guarded(<HandoverRules />)} />
        </Route>
        <Route path="/customers" element={<ModuleShell />}>
          <Route index element={guarded(<CustomerListPage />)} />
          <Route path=":id" element={guarded(<CustomerDetailPage />)} />
        </Route>
        <Route path="/marketing" element={<ModuleShell />}>
          <Route path="send" element={guarded(<CustomMessageSending />)} />
        </Route>
        <Route path="/housekeeping" element={<ModuleShell />}>
          <Route index element={guarded(<HousekeepingOverviewPage />)} />
          <Route path="linens" element={guarded(<LinenManagement view="items" />)} />
          <Route path="laundry" element={guarded(<LaundryPage />)} />
          <Route path="consumables" element={guarded(<LinenManagement view="consumables" />)} />
          <Route path="statistics" element={guarded(<LinenManagement view="report" />)} />
        </Route>

        {/* 商品 */}
        <Route path="/inventory" element={<ModuleShell />}>
          <Route path="rooms" element={guarded(<RoomSpaceManagement view="rooms" />)} />
          <Route path="spaces" element={guarded(<RoomSpaceManagement view="spaces" />)} />
        </Route>
        <Route path="/pricing" element={<ModuleShell />}>
          <Route index element={guarded(<PricingOverview />)} />
          <Route path="settings" element={guarded(<FormulaSettings />)} />
          <Route path="simulator" element={guarded(<QuoteCalculator />)} />
        </Route>

        {/* 自動化 */}
        <Route path="/integrations" element={<ModuleShell />}>
          <Route path="line" element={guarded(<LineChannels />)} />
          <Route path="ota" element={guarded(<OtaChannels />)} />
          <Route path="google-calendar" element={guarded(<GoogleCalendarSettings />)} />
          <Route path="notifications" element={guarded(<NotificationGroups />)} />
        </Route>
        <Route path="/automation" element={<ModuleShell />}>
          <Route path="rules" element={guarded(<ScheduledTasks />)} />
          <Route path="history" element={guarded(<AutomationHistory />)} />
        </Route>

        {/* 管理 */}
        <Route path="/admin" element={<ModuleShell />}>
          <Route path="property" element={guarded(<PropertySettings />)} />
          <Route path="ai" element={guarded(<AiEngineSettings />)} />
          <Route path="booking-rules" element={guarded(<BookingRulesSettings />)} />
          <Route path="security" element={guarded(<SecuritySettings />)} />
        </Route>
        <Route path="/access" element={<ModuleShell />}>
          <Route path="users" element={guarded(<UsersPage />)} />
          <Route path="users/:id" element={guarded(<UserDetailPage />)} />
          <Route path="roles" element={guarded(<RolesPage />)} />
          <Route path="roles/new" element={guarded(<RoleEditorPage />)} />
          <Route path="roles/:id" element={guarded(<RoleEditorPage />)} />
        </Route>
        <Route path="/parameters" element={guarded(<ParametersPage />)} />
        <Route path="/audit" element={guarded(<LogsPage />)} />
        <Route path="/errors" element={guarded(<LogsPage preset={{ level: 'error' }} />)} />

        {/* 舊網址與模組入口轉址（§160）：書籤、圖文選單裡的連結不會壞 */}
        {Object.entries(LEGACY_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  if (envMissing) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white shadow-xl rounded-2xl p-8 text-center border border-red-100">
          <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">!</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">設定未完成</h1>
          <p className="text-gray-600 mb-6 text-sm leading-relaxed">
            系統初始化失敗：請確保 Netlify 中的 VITE_SUPABASE_URL 與 VITE_SUPABASE_ANON_KEY 已正確填寫。
          </p>
          <div className="bg-gray-50 p-4 rounded-lg text-left text-xs font-mono text-gray-500 break-all mb-6">
            網址: {window.location.origin}
          </div>
          <button onClick={() => window.location.reload()} className="w-full bg-green-600 text-white py-2 rounded-lg font-semibold hover:bg-green-700 transition-colors">
            重新整理頁面
          </button>
        </div>
      </div>
    );
  }

  return (
    <ThemeProvider theme={appTheme}>
    <CssBaseline />
    {/* 輕量非阻塞回饋層：右上角浮動 Toast、3 秒自動消失（§79） */}
    <SnackbarProvider maxSnack={3} autoHideDuration={3000} anchorOrigin={{ vertical: 'top', horizontal: 'right' }}>
    {/* 二次確認對話框：Promise 形式提供給各頁（useConfirm），放在 Router 外層 */}
    <ConfirmDialogProvider>
    <AuthProvider>
    <PermissionProvider>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
    </PermissionProvider>
    </AuthProvider>
    </ConfirmDialogProvider>
    </SnackbarProvider>
    </ThemeProvider>
  );
}

export default App;

import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { SnackbarProvider } from 'notistack';
import { enterpriseTheme } from './muiTheme';
import ConfirmDialogProvider from './components/ui-mui/ConfirmDialogProvider';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { canAccessRoute, defaultRouteFor } from './lib/permissions';
import Login from './pages/Login';
import InviteVerify from './pages/auth/InviteVerify';
import Setup2FA from './pages/auth/Setup2FA';
import Verify2FA from './pages/auth/Verify2FA';
import Overview from './pages/Overview';
import SystemSettings from './pages/SystemSettings';
import KnowledgeBase from './pages/KnowledgeBase';
import AiServiceCenter from './pages/AiServiceCenter';
import AdminAccounts from './pages/AdminAccounts';
import PricingOverview from './pages/pricing/Overview';
import FormulaSettings from './pages/pricing/FormulaSettings';
import StandardMessages from './pages/StandardMessages';
import MessageVariables from './pages/MessageVariables';
import CustomMessageSending from './pages/CustomMessageSending';
import OrderManagement from './pages/OrderManagement';
import OperationLogs from './pages/OperationLogs';
import RoomCalendar from './pages/RoomCalendar';
import RoomSpaceManagement from './pages/RoomSpaceManagement';
import LinenManagement from './pages/LinenManagement';
import ScheduledTasks from './pages/ScheduledTasks';
import CustomerDirectory from './pages/CustomerDirectory';
import Layout from './components/Layout';

const envMissing = !import.meta.env.VITE_SUPABASE_URL || import.meta.env.VITE_SUPABASE_URL.includes('placeholder');


// 半受保護路由：只有處在對應 2FA 階段的人才會被導到這裡（見下方 AppRoutes 的說明）
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
 * 路徑層級的角色守衛（只在使用者已經完成 2FA、進到後台之後才會用到）。
 * 沒權限的人靜靜導回自己進得去的頁面——選單本來就會依角色隱藏，
 * 會走到這裡通常是手動輸入網址或用了舊書籤。
 *
 * 注意：這只是介面層的引導，不是安全防線。真正擋住資料的是資料庫的 RLS。
 */
function RequireAccess({ children }: { children: ReactNode }) {
  const { role } = useAuth();
  const location = useLocation();
  if (!canAccessRoute(role, location.pathname)) {
    return <Navigate to={defaultRouteFor(role)} replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  const { phase } = useAuth();
  const location = useLocation();
  const path = location.pathname;

  if (phase === 'loading') return <FullScreenSpinner message="系統載入中..." />;
  if (phase === 'accepting-invite') return <FullScreenSpinner message="確認邀請資格中..." />;

  // 未登入／被擋下：只能待在公開頁
  if (phase === 'anonymous' || phase === 'blocked') {
    if (!PUBLIC_PATHS.includes(path)) return <Navigate to="/login" replace />;
  }

  // 已通過 Google 但還沒完成 2FA：強制留在對應的 2FA 頁面。
  // 這是規格「半受保護路由」的實作——除了 2FA 相關頁面，哪裡都去不了，
  // 也看不到任何後台選單（那些頁面用的是 IsolatedLayout）。
  if (phase === 'needs-mfa-setup' && path !== '/auth/setup-2fa') {
    return <Navigate to="/auth/setup-2fa" replace />;
  }
  if (phase === 'needs-mfa-verify' && path !== '/auth/verify-2fa') {
    return <Navigate to="/auth/verify-2fa" replace />;
  }

  // 已完成 2FA 的人不需要再看到登入頁或 2FA 頁
  if (phase === 'ready' && (PUBLIC_PATHS.includes(path) || PRE_AUTH_PATHS.includes(path))) {
    return <Navigate to="/" replace />;
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/invite-verify" element={<InviteVerify />} />
      <Route path="/auth/setup-2fa" element={<Setup2FA />} />
      <Route path="/auth/verify-2fa" element={<Verify2FA />} />

      <Route element={<Layout />}>
        <Route path="/" element={<RequireAccess><Overview /></RequireAccess>} />
        <Route path="/ai-service-center" element={<RequireAccess><AiServiceCenter /></RequireAccess>} />
        <Route path="/standard-messages" element={<RequireAccess><StandardMessages /></RequireAccess>} />
        <Route path="/message-variables" element={<RequireAccess><MessageVariables /></RequireAccess>} />
        <Route path="/broadcast" element={<RequireAccess><CustomMessageSending /></RequireAccess>} />
        <Route path="/orders" element={<RequireAccess><OrderManagement /></RequireAccess>} />
        <Route path="/operation-logs" element={<RequireAccess><OperationLogs /></RequireAccess>} />
        <Route path="/room-calendar" element={<RequireAccess><RoomCalendar /></RequireAccess>} />
        <Route path="/room-spaces" element={<RequireAccess><RoomSpaceManagement /></RequireAccess>} />
        <Route path="/room-pricing" element={<RequireAccess><PricingOverview /></RequireAccess>} />
        {/* 試算報價改成「計價公式設定」標題列的一顆按鈕（開在對話框裡），不再是獨立頁面。
            舊路徑保留轉址，避免書籤失效。 */}
        <Route path="/room-pricing/quote" element={<Navigate to="/room-pricing/formula" replace />} />
        <Route path="/room-pricing/formula" element={<RequireAccess><FormulaSettings /></RequireAccess>} />
        <Route path="/linens" element={<RequireAccess><LinenManagement /></RequireAccess>} />
        {/* 舊路徑（改版前「耗材維護」獨立頁面）保留轉址，避免書籤失效 */}
        <Route path="/consumables" element={<Navigate to="/linens" replace />} />
        <Route path="/scheduled-tasks" element={<RequireAccess><ScheduledTasks /></RequireAccess>} />
        <Route path="/customers" element={<RequireAccess><CustomerDirectory /></RequireAccess>} />
        <Route path="/knowledge-base" element={<RequireAccess><KnowledgeBase /></RequireAccess>} />
        <Route path="/system-settings" element={<RequireAccess><SystemSettings /></RequireAccess>} />
        {/* 舊路徑（改版前 AI 引擎設定／LINE 串接設定／轉接規則三個獨立頁面）保留轉址，避免書籤失效 */}
        <Route path="/ai-settings" element={<Navigate to="/system-settings" replace />} />
        <Route path="/line-settings" element={<Navigate to="/system-settings" replace />} />
        <Route path="/handover-rules" element={<Navigate to="/system-settings" replace />} />
        <Route path="/accounts" element={<RequireAccess><AdminAccounts /></RequireAccess>} />
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
          <button
            onClick={() => window.location.reload()}
            className="w-full bg-green-600 text-white py-2 rounded-lg font-semibold hover:bg-green-700 transition-colors"
          >
            重新整理頁面
          </button>
        </div>
      </div>
    );
  }

  return (
    <ThemeProvider theme={enterpriseTheme}>
    {/* CssBaseline 會套用 theme 的 background.default 到 body，並正規化瀏覽器預設樣式。
        注意 index.css 仍負責 #root 撐滿寬高——那是 Vite 範本殘留的 body flex 造成的問題，
        CssBaseline 不會處理，兩者各司其職。 */}
    <CssBaseline />
    {/* 規範的「輕量非阻塞」回饋層：右上角浮動 Toast、3 秒自動消失 */}
    <SnackbarProvider
      maxSnack={3}
      autoHideDuration={3000}
      anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
    >
    {/* 二次確認對話框：以 Promise Hook 形式提供給各頁（useConfirm），
        放在 Router 外層，任何頁面都拿得到同一個實例 */}
    <ConfirmDialogProvider>
    <AuthProvider>
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
    </AuthProvider>
    </ConfirmDialogProvider>
    </SnackbarProvider>
    </ThemeProvider>
  );
}

export default App;

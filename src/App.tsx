import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { SnackbarProvider } from 'notistack';
import { enterpriseTheme } from './muiTheme';
import ConfirmDialogProvider from './components/ui-mui/ConfirmDialogProvider';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { canAccessRoute, defaultRouteFor } from './lib/permissions';
import Login from './pages/Login';
import SetPassword from './pages/SetPassword';
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

function FullScreenSpinner({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-screen bg-white">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-4 border-green-600 border-t-transparent rounded-full animate-spin"></div>
        <p className="text-gray-500 font-medium">{message}</p>
      </div>
    </div>
  );
}

/**
 * 路徑層級的權限守衛。沒權限的人直接導回自己進得去的頁面，而不是顯示「無權限」畫面——
 * 選單本來就會依角色隱藏，會走到這裡通常是手動輸入網址或用了舊書籤，靜靜導開比較不擾人。
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
  const { session, profile, loading } = useAuth();

  // session 或 profile 還沒確定時不要渲染路由：這時候還不知道使用者是什麼角色，
  // 先渲染會閃過一瞬間不該看到的選單，也可能誤把已登入的人導去登入頁。
  if (loading) return <FullScreenSpinner message="系統載入中..." />;

  const authed = !!session && !!profile;

  return (
    <Routes>
      <Route path="/login" element={!authed ? <Login /> : <Navigate to="/" replace />} />
      {/* 邀請信／重設密碼信的落地頁。刻意放在登入守衛之外：此時使用者已經拿到 session
          （所以 authed 會是 true），但他還沒有密碼，必須先設定完才放他進後台。 */}
      <Route path="/set-password" element={<SetPassword />} />
      <Route element={authed ? <Layout /> : <Navigate to="/login" replace />}>
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

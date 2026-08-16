import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { SnackbarProvider } from 'notistack';
import { enterpriseTheme } from './muiTheme';
import { supabase } from './lib/supabase';
import Login from './pages/Login';
import Overview from './pages/Overview';
import SystemSettings from './pages/SystemSettings';
import KnowledgeBase from './pages/KnowledgeBase';
import AiServiceCenter from './pages/AiServiceCenter';
import AdminAccounts from './pages/AdminAccounts';
import PricingOverview from './pages/pricing/Overview';
import QuoteCalculator from './pages/pricing/QuoteCalculator';
import FormulaSettings from './pages/pricing/FormulaSettings';
import StandardMessages from './pages/StandardMessages';
import MessageVariables from './pages/MessageVariables';
import CustomMessageSending from './pages/CustomMessageSending';
import OrderManagement from './pages/OrderManagement';
import RoomCalendar from './pages/RoomCalendar';
import RoomSpaceManagement from './pages/RoomSpaceManagement';
import LinenManagement from './pages/LinenManagement';
import ScheduledTasks from './pages/ScheduledTasks';
import CustomerDirectory from './pages/CustomerDirectory';
import Layout from './components/Layout';

function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    async function initSession() {
      try {
        // 檢查是否有無效的 placeholder 設定
        if (import.meta.env.VITE_SUPABASE_URL?.includes('placeholder') || !import.meta.env.VITE_SUPABASE_URL) {
          throw new Error('環境變數尚未設定');
        }

        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;
        setSession(session);
      } catch (err: any) {
        console.error('Initialization error:', err);
        setInitError('系統初始化失敗：請確保 Netlify 中的 VITE_SUPABASE_URL 與 VITE_SUPABASE_ANON_KEY 已正確填寫。');
      } finally {
        setLoading(false);
      }
    }

    initSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-white">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-green-600 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-500 font-medium">系統載入中...</p>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 p-6">
        <div className="max-w-md w-full bg-white shadow-xl rounded-2xl p-8 text-center border border-red-100">
          <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">!</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">設定未完成</h1>
          <p className="text-gray-600 mb-6 text-sm leading-relaxed">{initError}</p>
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
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={!session ? <Login /> : <Navigate to="/" />} />
        <Route element={session ? <Layout /> : <Navigate to="/login" />}>
          <Route path="/" element={<Overview />} />
          <Route path="/ai-service-center" element={<AiServiceCenter />} />
          <Route path="/standard-messages" element={<StandardMessages />} />
          <Route path="/message-variables" element={<MessageVariables />} />
          <Route path="/broadcast" element={<CustomMessageSending />} />
          <Route path="/orders" element={<OrderManagement />} />
          <Route path="/room-calendar" element={<RoomCalendar />} />
          <Route path="/room-spaces" element={<RoomSpaceManagement />} />
          <Route path="/room-pricing" element={<PricingOverview />} />
          <Route path="/room-pricing/quote" element={<QuoteCalculator />} />
          <Route path="/room-pricing/formula" element={<FormulaSettings />} />
          <Route path="/linens" element={<LinenManagement />} />
          {/* 舊路徑（改版前「耗材維護」獨立頁面）保留轉址，避免書籤失效 */}
          <Route path="/consumables" element={<Navigate to="/linens" replace />} />
          <Route path="/scheduled-tasks" element={<ScheduledTasks />} />
          <Route path="/customers" element={<CustomerDirectory />} />
          <Route path="/knowledge-base" element={<KnowledgeBase />} />
          <Route path="/system-settings" element={<SystemSettings />} />
          {/* 舊路徑（改版前 AI 引擎設定／LINE 串接設定／轉接規則三個獨立頁面）保留轉址，避免書籤失效 */}
          <Route path="/ai-settings" element={<Navigate to="/system-settings" replace />} />
          <Route path="/line-settings" element={<Navigate to="/system-settings" replace />} />
          <Route path="/handover-rules" element={<Navigate to="/system-settings" replace />} />
          <Route path="/accounts" element={<AdminAccounts />} />
        </Route>
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </BrowserRouter>
    </SnackbarProvider>
    </ThemeProvider>
  );
}

export default App;

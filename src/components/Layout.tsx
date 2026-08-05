import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import {
  LayoutDashboard,
  MessageSquare,
  LogOut,
  Settings,
  UserCheck,
  Bot,
  ClipboardList,
  MessageCircle,
  Users,
  ChevronDown,
  Calculator,
  Send,
  Workflow,
} from 'lucide-react';

const topItems = [
  { to: '/', label: '總覽', icon: LayoutDashboard },
  { to: '/knowledge-base', label: '知識庫管理', icon: ClipboardList },
  { to: '/booking', label: '試算報價', icon: Calculator },
  { to: '/broadcast', label: '客製訊息發送', icon: Send },
  { to: '/agent', label: '真人客服', icon: UserCheck },
  { to: '/conversations', label: '對話紀錄', icon: MessageSquare },
];

const settingsItems = [
  { to: '/ai-settings', label: 'AI 引擎設定', icon: Bot },
  { to: '/line-settings', label: 'LINE 串接設定', icon: MessageCircle },
  { to: '/handover-rules', label: '轉接規則', icon: UserCheck },
  { to: '/booking-flow', label: '訂房流程設定', icon: Workflow },
  { to: '/accounts', label: '帳號管理', icon: Users },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isInSettings = settingsItems.some((item) => item.to === location.pathname);
  const [settingsOpen, setSettingsOpen] = useState(isInSettings);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  const linkClass = (to: string) => {
    const isActive = location.pathname === to;
    return `flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
      isActive ? 'bg-blue-50 text-blue-600 font-medium' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-600'
    }`;
  };

  return (
    <div className="flex min-h-screen bg-gray-50 w-full">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b">
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Settings className="w-6 h-6 text-blue-600" />
            AI 客服後台
          </h1>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {topItems.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={linkClass(to)}>
              <Icon className="w-5 h-5" />
              {label}
            </Link>
          ))}

          <div className="pt-1">
            <button
              onClick={() => setSettingsOpen((prev) => !prev)}
              className={`flex items-center justify-between w-full gap-3 px-4 py-2 rounded-lg transition-colors ${
                isInSettings ? 'text-blue-600 font-medium' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-600'
              }`}
            >
              <span className="flex items-center gap-3">
                <Settings className="w-5 h-5" />
                系統設定
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${settingsOpen ? 'rotate-180' : ''}`} />
            </button>

            {settingsOpen && (
              <div className="mt-1 ml-4 pl-3 border-l border-gray-200 space-y-1">
                {settingsItems.map(({ to, label, icon: Icon }) => (
                  <Link key={to} to={to} className={linkClass(to)}>
                    <Icon className="w-4 h-4" />
                    <span className="text-sm">{label}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="p-4 border-t">
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-4 py-2 w-full text-left text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <LogOut className="w-5 h-5" />
            登出
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 p-8 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

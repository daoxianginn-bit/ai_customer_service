import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import {
  LayoutDashboard,
  LogOut,
  Settings,
  UserCheck,
  Bot,
  ClipboardList,
  MessageCircle,
  Users,
  UserCog,
  ChevronDown,
  Calculator,
  Send,
  Headphones,
  MessageSquareText,
  CalendarDays,
  BookOpen,
} from 'lucide-react';

const topItems = [
  { to: '/', label: '首頁總覽', icon: LayoutDashboard },
  { to: '/ai-service-center', label: 'AI客服中心', icon: Headphones },
  { to: '/standard-messages', label: '公版訊息管理', icon: MessageSquareText },
  { to: '/broadcast', label: '客製訊息發送', icon: Send },
  { to: '/orders', label: '訂單管理', icon: ClipboardList },
  { to: '/room-calendar', label: '房況/行事曆', icon: CalendarDays },
  { to: '/room-pricing', label: '房型與報價', icon: Calculator },
  { to: '/customers', label: '客戶資料', icon: Users },
  { to: '/knowledge-base', label: 'AI知識庫', icon: BookOpen },
];

const settingsItems = [
  { to: '/ai-settings', label: 'AI 引擎設定', icon: Bot },
  { to: '/line-settings', label: 'LINE 串接設定', icon: MessageCircle },
  { to: '/handover-rules', label: '轉接規則', icon: UserCheck },
  { to: '/accounts', label: '帳號管理', icon: UserCog },
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
      isActive ? 'bg-green-50 text-green-700 font-medium' : 'text-gray-700 hover:bg-green-50 hover:text-green-700'
    }`;
  };

  return (
    <div className="flex min-h-screen bg-gray-50 w-full">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-6 border-b">
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Settings className="w-6 h-6 text-green-600" />
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
                isInSettings ? 'text-green-700 font-medium' : 'text-gray-700 hover:bg-green-50 hover:text-green-700'
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

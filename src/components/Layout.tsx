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
} from 'lucide-react';

const menuItems = [
  { to: '/', label: '總覽', icon: LayoutDashboard },
  { to: '/ai-settings', label: 'AI 引擎設定', icon: Bot },
  { to: '/knowledge-base', label: '知識庫管理', icon: ClipboardList },
  { to: '/line-settings', label: 'LINE 串接設定', icon: MessageCircle },
  { to: '/handover-rules', label: '轉接規則', icon: UserCheck },
  { to: '/agent', label: '真人客服', icon: UserCheck },
  { to: '/conversations', label: '對話紀錄', icon: MessageSquare },
  { to: '/accounts', label: '帳號管理', icon: Users },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
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
          {menuItems.map(({ to, label, icon: Icon }) => {
            const isActive = location.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                className={`flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
                  isActive ? 'bg-blue-50 text-blue-600 font-medium' : 'text-gray-700 hover:bg-blue-50 hover:text-blue-600'
                }`}
              >
                <Icon className="w-5 h-5" />
                {label}
              </Link>
            );
          })}
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

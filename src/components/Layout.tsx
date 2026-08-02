import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { LayoutDashboard, LogOut, Settings, UserCheck, CalendarRange, ChevronDown, Workflow, DollarSign, Send } from 'lucide-react';

const BOOKING_PATHS = ['/booking', '/booking/flow', '/booking/messages'];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const isBookingSection = BOOKING_PATHS.includes(location.pathname);
  const [bookingMenuOpen, setBookingMenuOpen] = useState(isBookingSection);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  const linkClass = (path: string) =>
    `flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
      location.pathname === path ? 'bg-purple-50 text-purple-600' : 'text-gray-700 hover:bg-purple-50 hover:text-purple-600'
    }`;

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

        <nav className="flex-1 p-4 space-y-2">
          <Link to="/" className="flex items-center gap-3 px-4 py-2 text-gray-700 hover:bg-blue-50 hover:text-blue-600 rounded-lg transition-colors">
            <LayoutDashboard className="w-5 h-5" />
            系統設定
          </Link>
          <Link to="/agent" className="flex items-center gap-3 px-4 py-2 text-gray-700 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors">
            <UserCheck className="w-5 h-5" />
            專人客服
          </Link>

          <div>
            <button
              type="button"
              onClick={() => setBookingMenuOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-3 px-4 py-2 text-gray-700 hover:bg-purple-50 hover:text-purple-600 rounded-lg transition-colors"
            >
              <span className="flex items-center gap-3">
                <CalendarRange className="w-5 h-5" />
                訂房設定
              </span>
              <ChevronDown className={`w-4 h-4 transition-transform ${bookingMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {bookingMenuOpen && (
              <div className="mt-1 ml-4 pl-4 border-l border-gray-200 space-y-1">
                <Link to="/booking/flow" className={linkClass('/booking/flow')}>
                  <Workflow className="w-4 h-4" />
                  流程設定
                </Link>
                <Link to="/booking" className={linkClass('/booking')}>
                  <DollarSign className="w-4 h-4" />
                  報價設定
                </Link>
                <Link to="/booking/messages" className={linkClass('/booking/messages')}>
                  <Send className="w-4 h-4" />
                  客製訊息發送
                </Link>
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

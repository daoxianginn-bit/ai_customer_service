import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import {
  LayoutDashboard,
  LogOut,
  Settings,
  ClipboardList,
  Users,
  UserCog,
  ChevronDown,
  Calculator,
  Send,
  Headphones,
  MessageSquareText,
  CalendarDays,
  BookOpen,
  Variable,
  DoorOpen,
  Shirt,
  Clock,
  SlidersHorizontal,
  Sparkles,
  Percent,
} from 'lucide-react';

type NavLink = { to: string; label: string; icon: any };
type NavGroup = { key: string; label: string; icon: any; children: NavLink[] };
type NavEntry = ({ kind: 'link' } & NavLink) | ({ kind: 'group' } & NavGroup);

// 選單依業務功能分區：獨立項目維持扁平，關聯性高的項目收進可展開群組（仿照原本「系統設定」的做法）。
const navEntries: NavEntry[] = [
  { kind: 'link', to: '/', label: '首頁總覽', icon: LayoutDashboard },
  { kind: 'link', to: '/orders', label: '訂單管理', icon: ClipboardList },
  {
    kind: 'group',
    key: 'rooms',
    label: '房型管理',
    icon: DoorOpen,
    children: [
      { to: '/room-spaces', label: '房型與空間維護', icon: DoorOpen },
      { to: '/room-calendar', label: '房況/行事曆', icon: CalendarDays },
    ],
  },
  {
    kind: 'group',
    key: 'pricing',
    label: '價格設定',
    icon: Calculator,
    children: [
      { to: '/room-pricing', label: '價格總覽', icon: LayoutDashboard },
      { to: '/room-pricing/quote', label: '試算報價', icon: Calculator },
      { to: '/room-pricing/formula', label: '計價公式設定', icon: SlidersHorizontal },
      { to: '/room-pricing/date-ranges', label: '旺季/連假日期', icon: CalendarDays },
      { to: '/room-pricing/special-dates', label: '特殊日期價格', icon: Sparkles },
      { to: '/room-pricing/discounts', label: '促銷與折扣', icon: Percent },
    ],
  },
  {
    kind: 'group',
    key: 'ai-line',
    label: 'AI 與 LINE 對話',
    icon: Headphones,
    children: [
      { to: '/ai-service-center', label: 'AI客服中心', icon: Headphones },
      { to: '/standard-messages', label: 'LINE 自定訊息流程', icon: MessageSquareText },
      { to: '/message-variables', label: '訊息變數資料維護', icon: Variable },
      { to: '/knowledge-base', label: 'AI知識庫', icon: BookOpen },
    ],
  },
  {
    kind: 'group',
    key: 'customers',
    label: '顧客與行銷',
    icon: Users,
    children: [
      { to: '/customers', label: '客戶資料', icon: Users },
      { to: '/broadcast', label: '客製訊息發送', icon: Send },
    ],
  },
  { kind: 'link', to: '/linens', label: '備品管理', icon: Shirt },
  {
    kind: 'group',
    key: 'system',
    label: '系統設定',
    icon: Settings,
    children: [
      { to: '/system-settings', label: '基本設定', icon: SlidersHorizontal },
      { to: '/scheduled-tasks', label: '排程管理', icon: Clock },
      { to: '/accounts', label: '帳號管理', icon: UserCog },
    ],
  },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();

  const groupContainsPath = (group: NavGroup) => group.children.some((c) => c.to === location.pathname);

  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const entry of navEntries) {
      if (entry.kind === 'group' && groupContainsPath(entry)) initial.add(entry.key);
    }
    return initial;
  });

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
          {navEntries.map((entry) => {
            if (entry.kind === 'link') {
              const Icon = entry.icon;
              return (
                <Link key={entry.to} to={entry.to} className={linkClass(entry.to)}>
                  <Icon className="w-5 h-5" />
                  {entry.label}
                </Link>
              );
            }

            const GroupIcon = entry.icon;
            const isOpen = openGroups.has(entry.key);
            const isActive = groupContainsPath(entry);
            return (
              <div key={entry.key} className="pt-1">
                <button
                  onClick={() => toggleGroup(entry.key)}
                  className={`flex items-center justify-between w-full gap-3 px-4 py-2 rounded-lg transition-colors ${
                    isActive ? 'text-green-700 font-medium' : 'text-gray-700 hover:bg-green-50 hover:text-green-700'
                  }`}
                >
                  <span className="flex items-center gap-3">
                    <GroupIcon className="w-5 h-5" />
                    {entry.label}
                  </span>
                  <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>

                {isOpen && (
                  <div className="mt-1 ml-4 pl-3 border-l border-gray-200 space-y-1">
                    {entry.children.map(({ to, label, icon: Icon }) => (
                      <Link key={to} to={to} className={linkClass(to)}>
                        <Icon className="w-4 h-4" />
                        <span className="text-sm">{label}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
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

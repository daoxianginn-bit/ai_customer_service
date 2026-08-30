import { useMemo, useState } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar, Box, Breadcrumbs, Collapse, Divider, Drawer, IconButton, Link, List, ListItemButton,
  ListItemIcon, ListItemText, Toolbar, Tooltip, Typography,
} from '@mui/material';
import { styled, type CSSObject, type Theme } from '@mui/material/styles';
import { useAuth } from '../lib/AuthContext';
import { canAccessRoute, canWrite, roleLabel } from '../lib/permissions';
import {
  LayoutDashboard, LogOut, Settings, ClipboardList, Users, UserCog, ChevronDown, Calculator,
  Send, Headphones, MessageSquareText, CalendarDays, BookOpen, Variable, DoorOpen, Shirt,
  Clock, SlidersHorizontal, PanelLeftClose, PanelLeftOpen, ScrollText, Eye,
} from 'lucide-react';

// 規範指定的外殼尺寸：左側導航 240px（摺疊 64px）、頂部狀態列 64px。
const DRAWER_WIDTH = 240;
const DRAWER_WIDTH_COLLAPSED = 64;
const APPBAR_HEIGHT = 64;

// 收合側欄採 MUI 官方 MiniDrawer 的 styled() 寫法。展開 240px／收合 64px，
// 外層容器與 paper 兩邊都要給寬度：paper 是 position:fixed，只縮外層的話 paper 會蓋住內容區。
const openedMixin = (theme: Theme, width: number): CSSObject => ({
  width,
  transition: theme.transitions.create('width', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.enteringScreen,
  }),
  overflowX: 'hidden',
});

const closedMixin = (theme: Theme, width: number): CSSObject => ({
  width,
  transition: theme.transitions.create('width', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  overflowX: 'hidden',
});

const MiniDrawer = styled(Drawer, {
  shouldForwardProp: (prop) => prop !== 'open',
})<{ open: boolean }>(({ theme, open }) => ({
  width: open ? DRAWER_WIDTH : DRAWER_WIDTH_COLLAPSED,
  flexShrink: 0,
  whiteSpace: 'nowrap',
  boxSizing: 'border-box',
  ...(open
    ? { ...openedMixin(theme, DRAWER_WIDTH), '& .MuiDrawer-paper': openedMixin(theme, DRAWER_WIDTH) }
    : { ...closedMixin(theme, DRAWER_WIDTH_COLLAPSED), '& .MuiDrawer-paper': closedMixin(theme, DRAWER_WIDTH_COLLAPSED) }),
  '& .MuiDrawer-paper': {
    ...(open ? openedMixin(theme, DRAWER_WIDTH) : closedMixin(theme, DRAWER_WIDTH_COLLAPSED)),
    borderRight: '1px solid',
    borderColor: theme.palette.divider,
    boxSizing: 'border-box',
  },
}));

type NavLink = { to: string; label: string; icon: any };
type NavGroup = { key: string; label: string; icon: any; children: NavLink[] };
type NavEntry = ({ kind: 'link' } & NavLink) | ({ kind: 'group' } & NavGroup);

// 選單依業務功能分區：獨立項目維持扁平，關聯性高的項目收進可展開群組。
const navEntries: NavEntry[] = [
  { kind: 'link', to: '/', label: '首頁總覽', icon: LayoutDashboard },
  { kind: 'link', to: '/orders', label: '訂單管理', icon: ClipboardList },
  { kind: 'link', to: '/room-calendar', label: '行事曆', icon: CalendarDays },
  {
    kind: 'group',
    key: 'pricing',
    label: '價格設定',
    icon: Calculator,
    children: [
      { to: '/room-pricing', label: '價格總覽', icon: LayoutDashboard },
      { to: '/room-pricing/formula', label: '計價公式設定', icon: SlidersHorizontal },
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
      // 房型與空間維護原本是側欄的獨立項目，但它本質上是「一次設定好就很少再動」的
      // 基礎資料維護，跟每天要用的訂單/行事曆不同層級，收進系統設定比較合理。
      { to: '/room-spaces', label: '房型與空間維護', icon: DoorOpen },
      { to: '/scheduled-tasks', label: '排程管理', icon: Clock },
      { to: '/accounts', label: '帳號管理', icon: UserCog },
      { to: '/operation-logs', label: '操作紀錄', icon: ScrollText },
    ],
  },
];

// 麵包屑用的路徑 → 標題對照。從 navEntries 攤平產生，新增頁面時不用兩邊各維護一份。
function buildTitleMap(): Map<string, { label: string; group?: string }> {
  const map = new Map<string, { label: string; group?: string }>();
  for (const entry of navEntries) {
    if (entry.kind === 'link') map.set(entry.to, { label: entry.label });
    else for (const c of entry.children) map.set(c.to, { label: c.label, group: entry.label });
  }
  return map;
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const titleMap = useMemo(buildTitleMap, []);
  const { role, profile, signOut } = useAuth();

  const [collapsed, setCollapsed] = useState(false);

  // 依角色過濾選單：進不去的頁面就不顯示，避免使用者點了才發現被導開。
  // 群組內的子項全被濾掉時整個群組也要拿掉，否則會留下一個點開是空的群組。
  const visibleEntries = useMemo(() => {
    const result: NavEntry[] = [];
    for (const entry of navEntries) {
      if (entry.kind === 'link') {
        if (canAccessRoute(role, entry.to)) result.push(entry);
        continue;
      }
      const children = entry.children.filter((c) => canAccessRoute(role, c.to));
      if (children.length) result.push({ ...entry, children });
    }
    return result;
  }, [role]);

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
    await signOut();
    navigate('/login');
  };

  const current = titleMap.get(location.pathname);

  // 收合狀態下只剩圖示，展開群組沒有意義（沒有空間顯示子項文字），改成直接顯示子項圖示。
  const renderNav = () => (
    <List sx={{ px: collapsed ? 0.5 : 1, py: 1 }} dense>
      {visibleEntries.map((entry) => {
        if (entry.kind === 'link') {
          const Icon = entry.icon;
          const selected = location.pathname === entry.to;
          return (
            <Tooltip key={entry.to} title={collapsed ? entry.label : ''} placement="right">
              <ListItemButton
                component={RouterLink}
                to={entry.to}
                selected={selected}
                sx={navItemSx(collapsed)}
              >
                <ListItemIcon sx={iconSx(collapsed)}><Icon size={18} /></ListItemIcon>
                {!collapsed && <ListItemText primary={entry.label} primaryTypographyProps={{ fontSize: 14 }} />}
              </ListItemButton>
            </Tooltip>
          );
        }

        const GroupIcon = entry.icon;
        const isOpen = openGroups.has(entry.key);
        const isActive = groupContainsPath(entry);

        if (collapsed) {
          return entry.children.map(({ to, label, icon: Icon }) => (
            <Tooltip key={to} title={`${entry.label} / ${label}`} placement="right">
              <ListItemButton component={RouterLink} to={to} selected={location.pathname === to} sx={navItemSx(true)}>
                <ListItemIcon sx={iconSx(true)}><Icon size={18} /></ListItemIcon>
              </ListItemButton>
            </Tooltip>
          ));
        }

        return (
          <Box key={entry.key}>
            <ListItemButton onClick={() => toggleGroup(entry.key)} sx={navItemSx(false)}>
              <ListItemIcon sx={iconSx(false)}><GroupIcon size={18} /></ListItemIcon>
              <ListItemText
                primary={entry.label}
                primaryTypographyProps={{ fontSize: 14, fontWeight: isActive ? 600 : 400 }}
              />
              <ChevronDown
                size={14}
                style={{ transition: 'transform .2s', transform: isOpen ? 'rotate(180deg)' : 'none' }}
              />
            </ListItemButton>
            <Collapse in={isOpen} unmountOnExit>
              <List dense disablePadding sx={{ ml: 2.5, pl: 1, borderLeft: '1px solid', borderColor: 'divider' }}>
                {entry.children.map(({ to, label, icon: Icon }) => (
                  <ListItemButton key={to} component={RouterLink} to={to} selected={location.pathname === to} sx={navItemSx(false)}>
                    <ListItemIcon sx={iconSx(false)}><Icon size={16} /></ListItemIcon>
                    <ListItemText primary={label} primaryTypographyProps={{ fontSize: 13 }} />
                  </ListItemButton>
                ))}
              </List>
            </Collapse>
          </Box>
        );
      })}
    </List>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          height: APPBAR_HEIGHT,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: '1px solid',
          borderColor: 'divider',
          zIndex: (t) => t.zIndex.drawer + 1,
        }}
      >
        <Toolbar sx={{ minHeight: `${APPBAR_HEIGHT}px !important`, gap: 2 }}>
          <IconButton onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? '展開側欄' : '收合側欄'}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>

          <Typography variant="h6" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
            AI 客服後台
          </Typography>

          {/* 麵包屑：規範要求的第二層導航，讓使用者知道自己在哪一區 */}
          <Breadcrumbs sx={{ flex: 1, fontSize: 13 }} aria-label="breadcrumb">
            <Link component={RouterLink} to="/" underline="hover" color="text.secondary">
              首頁
            </Link>
            {current?.group && <Typography color="text.secondary" fontSize={13}>{current.group}</Typography>}
            {current && location.pathname !== '/' && (
              <Typography color="text.primary" fontSize={13} fontWeight={600}>{current.label}</Typography>
            )}
          </Breadcrumbs>

          {/* 顯示目前登入者與角色：多人共用同一台電腦時，能一眼確認現在是誰在操作 */}
          {profile && (
            <Box sx={{ textAlign: 'right', display: { xs: 'none', sm: 'block' }, lineHeight: 1.3 }}>
              <Typography fontSize={13} fontWeight={600} noWrap>
                {profile.display_name || profile.email}
              </Typography>
              <Typography fontSize={11} color="text.secondary" noWrap>
                {roleLabel(role)}
              </Typography>
            </Box>
          )}

          <Tooltip title="登出">
            <IconButton onClick={handleLogout} sx={{ color: 'error.main' }} aria-label="登出">
              <LogOut size={18} />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>

      <MiniDrawer variant="permanent" open={!collapsed}>
        <Toolbar sx={{ minHeight: `${APPBAR_HEIGHT}px !important` }} />
        <Box sx={{ overflowY: 'auto', overflowX: 'hidden', flex: 1 }}>{renderNav()}</Box>
        <Divider />
      </MiniDrawer>

      {/* 內容區：滿版填滿剩餘寬度。minWidth:0 是必要的——flex 子項預設 min-width:auto，
          內含寬表格時會把整個版面撐開而不是讓表格自己捲動。 */}
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Toolbar sx={{ minHeight: `${APPBAR_HEIGHT}px !important` }} />
        {/* 唯讀角色的畫面上仍然看得到各種編輯按鈕（那些按鈕沒有逐一依角色停用），
            但實際送出時會被資料庫的 RLS 擋下。先講清楚，使用者才不會以為是系統故障。 */}
        {!canWrite(role) && (
          <Box sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            px: 3, py: 1, bgcolor: 'warning.light', color: 'warning.contrastText',
            borderBottom: '1px solid', borderColor: 'divider',
          }}>
            <Eye size={15} />
            <Typography fontSize={13}>
              目前是唯讀模式，可以查看資料但無法新增或修改。需要調整權限請聯繫管理員。
            </Typography>
          </Box>
        )}
        <Box sx={{ p: 3, flex: 1 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}

const navItemSx = (collapsed: boolean) => ({
  borderRadius: 1,
  mb: 0.25,
  minHeight: 38,
  justifyContent: collapsed ? 'center' : 'flex-start',
  px: collapsed ? 1 : 1.5,
  '&.Mui-selected': {
    bgcolor: 'primary.light',
    color: 'primary.dark',
    '& .MuiListItemIcon-root': { color: 'primary.dark' },
    '&:hover': { bgcolor: 'primary.light' },
  },
});

const iconSx = (collapsed: boolean) => ({
  minWidth: collapsed ? 0 : 30,
  justifyContent: 'center',
  color: 'text.secondary',
});

import { useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AppBar, Avatar, Box, Breadcrumbs, Divider, Drawer, IconButton, Link, List, ListItemButton,
  ListItemIcon, ListItemText, ListSubheader, Menu, MenuItem, Toolbar, Tooltip, Typography,
} from '@mui/material';
import { styled, type CSSObject, type Theme } from '@mui/material/styles';
import { ChevronLeft, LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, Eye } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { canWrite, roleLabel } from '../lib/permissions';
import { hasPermission } from '../app/permissions';
import { navigation, resolveNav, type NavItem } from '../app/navigation';
import { layout as L } from '../app/tokens';
import { useBreakpoint } from '../app/useBreakpoint';

// ========================================================================
// 全域外殼（V2 §8–11）：側欄 + 頂欄 + 內容區。
//
// 側欄只顯示第一層入口（§9-1），依分區分組，當前頁用淡色底 + 左側 3px 指示條。
// 桌機（≥1024）常駐可收合（248 / 72px）；平板與手機改成蓋在內容上的抽屜（§17）。
// 頂欄：左邊是側欄開關 + 麵包屑（手機只留「‹ 上一層」與頁名），右邊是帳號選單。
// 全域搜尋、系統警示、通知中心屬第二階段（§75、§85），這裡先留位置不做假按鈕。
// ========================================================================

const openedMixin = (theme: Theme): CSSObject => ({
  width: L.sidebarWidth,
  transition: theme.transitions.create('width', { easing: theme.transitions.easing.sharp, duration: theme.transitions.duration.enteringScreen }),
  overflowX: 'hidden',
});
const closedMixin = (theme: Theme): CSSObject => ({
  width: L.sidebarCollapsedWidth,
  transition: theme.transitions.create('width', { easing: theme.transitions.easing.sharp, duration: theme.transitions.duration.leavingScreen }),
  overflowX: 'hidden',
});

const MiniDrawer = styled(Drawer, { shouldForwardProp: (prop) => prop !== 'open' })<{ open: boolean }>(({ theme, open }) => ({
  flexShrink: 0,
  whiteSpace: 'nowrap',
  boxSizing: 'border-box',
  ...(open ? openedMixin(theme) : closedMixin(theme)),
  '& .MuiDrawer-paper': {
    ...(open ? openedMixin(theme) : closedMixin(theme)),
    borderRight: `1px solid ${theme.palette.divider}`,
    boxSizing: 'border-box',
    backgroundColor: theme.palette.background.paper,
  },
}));

const SIDEBAR_STORAGE_KEY = 'v2.sidebar.collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'; } catch { return false; }
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { role, profile, signOut } = useAuth();
  const { isDesktop, isMobile } = useBreakpoint();

  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, v ? '1' : '0'); } catch { /* 無痕模式等情況忽略 */ }
  };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountAnchor, setAccountAnchor] = useState<null | HTMLElement>(null);

  // 依權限過濾：進不去的入口不顯示（§9-4）；整區都沒有可見入口時分區標題也拿掉
  const visibleSections = useMemo(
    () => navigation
      .map((s) => ({ ...s, items: s.items.filter((i) => hasPermission(role, i.permission)) }))
      .filter((s) => s.items.length > 0),
    [role]
  );

  const resolved = resolveNav(location.pathname);
  const activeKey = resolved?.item.key;

  const closeDrawer = () => setDrawerOpen(false);
  const handleLogout = async () => { await signOut(); navigate('/login'); };

  const renderItem = (item: NavItem, compact: boolean) => {
    const Icon = item.icon;
    const selected = item.key === activeKey;
    const button = (
      <ListItemButton
        component={RouterLink}
        to={item.path}
        selected={selected}
        onClick={closeDrawer}
        sx={{
          minHeight: 40,
          px: compact ? 0 : 1.5,
          justifyContent: compact ? 'center' : 'flex-start',
          position: 'relative',
          color: selected ? 'primary.dark' : 'text.primary',
          '&.Mui-selected': { bgcolor: 'primary.light', '&:hover': { bgcolor: 'primary.light' } },
          // 左側 3px 指示條（§9-2）
          '&.Mui-selected::before': {
            content: '""', position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2, bgcolor: 'primary.main',
          },
        }}
      >
        <ListItemIcon sx={{ minWidth: compact ? 0 : 32, justifyContent: 'center', color: selected ? 'primary.dark' : 'text.secondary' }}>
          <Icon size={18} />
        </ListItemIcon>
        {!compact && <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14, fontWeight: selected ? 600 : 500 }} />}
      </ListItemButton>
    );
    return compact ? <Tooltip key={item.key} title={item.label} placement="right">{button}</Tooltip> : <Box key={item.key}>{button}</Box>;
  };

  const sidebarContent = (compact: boolean) => (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Logo 區 */}
      <Box sx={{ height: L.topbarHeight, display: 'flex', alignItems: 'center', px: compact ? 0 : 2, justifyContent: compact ? 'center' : 'flex-start', gap: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ width: 28, height: 28, borderRadius: 1.5, bgcolor: 'primary.main', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
          禾
        </Box>
        {!compact && <Typography sx={{ fontWeight: 700, fontSize: 15 }} noWrap>營運管理平台</Typography>}
      </Box>

      <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', py: 1 }}>
        {visibleSections.map((section, i) => (
          <List
            key={section.section ?? '_top'}
            dense
            disablePadding
            sx={{ px: compact ? 1 : 1.5, mb: 0.5 }}
            subheader={
              section.section && !compact ? (
                <ListSubheader disableSticky sx={{ lineHeight: '28px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: 'text.disabled', bgcolor: 'transparent', px: 1.5, mt: i === 0 ? 0 : 1 }}>
                  {section.section}
                </ListSubheader>
              ) : section.section && compact ? <Divider sx={{ my: 1 }} /> : undefined
            }
          >
            {section.items.map((item) => renderItem(item, compact))}
          </List>
        ))}
      </Box>

      {/* 底部：登入帳號與角色（§9） */}
      <Divider />
      <Box sx={{ p: compact ? 1 : 1.5, display: 'flex', alignItems: 'center', gap: 1.25, justifyContent: compact ? 'center' : 'flex-start' }}>
        <Avatar sx={{ width: 30, height: 30, fontSize: 13, bgcolor: 'primary.light', color: 'primary.dark', fontWeight: 600 }}>
          {(profile?.display_name || profile?.email || '?').slice(0, 1).toUpperCase()}
        </Avatar>
        {!compact && (
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography fontSize={13} fontWeight={600} noWrap>{profile?.display_name || profile?.email}</Typography>
            <Typography fontSize={11} color="text.secondary" noWrap>{roleLabel(role)}</Typography>
          </Box>
        )}
        {!compact && (
          <Tooltip title="登出">
            <IconButton onClick={handleLogout} aria-label="登出" sx={{ color: 'text.secondary' }}><LogOut size={16} /></IconButton>
          </Tooltip>
        )}
      </Box>
    </Box>
  );

  // 麵包屑：分區 / 入口 / 頁籤（§11）。手機改成「‹ 上一層」＋頁名。
  const crumbs: { label: string; to?: string }[] = [];
  if (resolved) {
    if (resolved.section.section) crumbs.push({ label: resolved.section.section });
    crumbs.push({ label: resolved.item.label, to: resolved.item.path });
    if (resolved.child && resolved.child.path !== resolved.item.path) crumbs.push({ label: resolved.child.label, to: resolved.child.path });
    // 詳情頁（/bookings/:id）：路徑比頁籤深一層，最後一段當作「目前項目」
    if (!resolved.child || (resolved.child.path !== location.pathname && resolved.item.path !== location.pathname)) {
      const tail = location.pathname.split('/').filter(Boolean).pop();
      if (tail && !crumbs.some((c) => c.to === location.pathname)) crumbs.push({ label: '詳情' });
    }
  }
  const pageTitle = resolved?.child?.label || resolved?.item.label || '';
  const backTarget = crumbs.length >= 2 ? crumbs[crumbs.length - 2].to : undefined;

  const topbar: ReactNode = (
    <AppBar position="fixed" elevation={0} sx={{ height: L.topbarHeight, bgcolor: 'background.paper', color: 'text.primary', borderBottom: '1px solid', borderColor: 'divider', zIndex: (t) => t.zIndex.drawer + 1, left: { lg: collapsed ? L.sidebarCollapsedWidth : L.sidebarWidth }, width: { lg: `calc(100% - ${collapsed ? L.sidebarCollapsedWidth : L.sidebarWidth}px)` }, transition: 'left .2s, width .2s' }}>
      <Toolbar sx={{ minHeight: `${L.topbarHeight}px !important`, gap: 1, px: { xs: 1, md: 2 } }}>
        {isDesktop ? (
          <IconButton onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? '展開側欄' : '收合側欄'}>
            {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </IconButton>
        ) : (
          <IconButton onClick={() => setDrawerOpen((o) => !o)} aria-label="開啟選單" edge="start"><MenuIcon size={20} /></IconButton>
        )}

        {isMobile ? (
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {backTarget && (
              <IconButton component={RouterLink} to={backTarget} aria-label="上一層" size="small"><ChevronLeft size={18} /></IconButton>
            )}
            <Typography sx={{ fontWeight: 600, fontSize: 15 }} noWrap>{pageTitle}</Typography>
          </Box>
        ) : (
          <Breadcrumbs sx={{ flex: 1, fontSize: 13, '& .MuiBreadcrumbs-separator': { mx: 0.75 } }} aria-label="breadcrumb">
            {crumbs.map((c, i) =>
              c.to && i < crumbs.length - 1 ? (
                <Link key={i} component={RouterLink} to={c.to} underline="hover" color="text.secondary">{c.label}</Link>
              ) : (
                <Typography key={i} color={i === crumbs.length - 1 ? 'text.primary' : 'text.secondary'} fontSize={13} fontWeight={i === crumbs.length - 1 ? 600 : 400}>{c.label}</Typography>
              )
            )}
          </Breadcrumbs>
        )}

        {/* 帳號選單：手機側欄底部看不到時，這裡也能登出 */}
        <IconButton onClick={(e) => setAccountAnchor(e.currentTarget)} aria-label="帳號選單">
          <Avatar sx={{ width: 28, height: 28, fontSize: 12, bgcolor: 'primary.light', color: 'primary.dark', fontWeight: 600 }}>
            {(profile?.display_name || profile?.email || '?').slice(0, 1).toUpperCase()}
          </Avatar>
        </IconButton>
        <Menu anchorEl={accountAnchor} open={!!accountAnchor} onClose={() => setAccountAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
          <Box sx={{ px: 2, py: 1 }}>
            <Typography fontSize={13} fontWeight={600}>{profile?.display_name || profile?.email}</Typography>
            <Typography fontSize={12} color="text.secondary">{profile?.email} · {roleLabel(role)}</Typography>
          </Box>
          <Divider />
          <MenuItem onClick={handleLogout} sx={{ fontSize: 14, color: 'error.main' }}><LogOut size={16} style={{ marginRight: 8 }} />登出</MenuItem>
        </Menu>
      </Toolbar>
    </AppBar>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {topbar}

      {isDesktop ? (
        <MiniDrawer variant="permanent" open={!collapsed}>{sidebarContent(collapsed)}</MiniDrawer>
      ) : (
        <Drawer variant="temporary" open={drawerOpen} onClose={closeDrawer} ModalProps={{ keepMounted: true }} sx={{ '& .MuiDrawer-paper': { width: L.sidebarWidth, boxSizing: 'border-box' } }}>
          {sidebarContent(false)}
        </Drawer>
      )}

      {/* minWidth:0 是必要的——flex 子項預設 min-width:auto，內含寬表格時會把版面撐開而不是讓表格自己捲動 */}
      {/* --sidebar-offset 給頁面內 position:fixed 的元素（設定頁底部儲存列）避開側欄用 */}
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', '--sidebar-offset': isDesktop ? `${collapsed ? L.sidebarCollapsedWidth : L.sidebarWidth}px` : '0px' } as any}>
        <Toolbar sx={{ minHeight: `${L.topbarHeight}px !important` }} />
        {!canWrite(role) && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: { xs: 1.5, md: 3 }, py: 1, bgcolor: 'warning.light', color: 'warning.dark', borderBottom: '1px solid', borderColor: 'divider' }}>
            <Eye size={15} style={{ flexShrink: 0 }} />
            <Typography fontSize={13}>目前是唯讀模式，可以查看資料但無法新增或修改。需要調整權限請聯繫管理員。</Typography>
          </Box>
        )}
        <Box sx={{ p: { xs: 1.5, md: 2.5, lg: 3 }, flex: 1, minWidth: 0 }}>
          <Outlet />
        </Box>
      </Box>
    </Box>
  );
}

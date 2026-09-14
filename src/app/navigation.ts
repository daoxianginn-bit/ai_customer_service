// ========================================================================
// 導航設定（V2 §3–4、§131）：全站唯一的資訊架構定義。
//
// 側邊欄、麵包屑、模組頁籤、路由守衛都從這裡讀，新增頁面只改這一個檔案。
// 結構：分區（營運／商品／自動化／管理）→ 第一層入口（最多 9 個）→ 第二層頁籤。
// 側邊欄只顯示到第一層（§9-1），第二層以頁籤呈現在模組頁內。
//
// 每個入口與頁籤都宣告 permission，選單依角色過濾、路由守衛依同一份判斷，兩邊不會不一致。
// ========================================================================

import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard, ClipboardList, Headphones, Users, Shirt, DoorOpen, Coins, Plug, Zap, Settings, ShieldCheck, SlidersHorizontal, ScrollText, AlertTriangle,
} from 'lucide-react';
import type { Permission } from './permissions';

export interface NavChild {
  label: string;
  path: string;
  permission: Permission;
  /** 頁首說明（§12） */
  description?: string;
}

export interface NavItem {
  key: string;
  label: string;
  /** 入口路徑。有 children 時，入口本身通常是第一個頁籤或轉址目標 */
  path: string;
  icon: LucideIcon;
  permission: Permission;
  description?: string;
  children?: NavChild[];
}

export interface NavSection {
  /** null＝不顯示分區標題（工作台） */
  section: string | null;
  items: NavItem[];
}

export const navigation: NavSection[] = [
  {
    section: null,
    items: [
      { key: 'dashboard', label: '工作台', path: '/', icon: LayoutDashboard, permission: 'dashboard.view', description: '今天的營運狀況與需要處理的事項' },
    ],
  },
  {
    section: '營運',
    items: [
      {
        key: 'bookings', label: '訂房營運', path: '/bookings/process', icon: ClipboardList, permission: 'booking.view',
        children: [
          { label: '訂單處理', path: '/bookings/process', permission: 'booking.view', description: '輪到人動手的訂單：核對訂金、收尾款、退押金、退款、入住密碼；確認後直接通知客人' },
          { label: '訂單', path: '/bookings', permission: 'booking.view', description: '查看、搜尋及處理所有訂房' },
          { label: '房況行事曆', path: '/bookings/calendar', permission: 'calendar.view', description: '每個色塊是一筆訂單，點選可查看詳情' },
          { label: '待辦事項', path: '/bookings/tasks', permission: 'conflict.view', description: '所有需要人工處理的事項：核款、尾款、退款、押金、撞期、轉接' },
          { label: '候補／衝突', path: '/bookings/conflicts', permission: 'conflict.view', description: 'OTA 房況衝突、系統攔下的撞期、候補中的詢問' },
        ],
      },
      {
        key: 'service', label: '客服與 AI', path: '/service', icon: Headphones, permission: 'service.view',
        children: [
          { label: '客服工作台', path: '/service', permission: 'service.view', description: '對話清單、對話內容與客戶脈絡；接手或轉回 AI、直接回覆客人' },
          { label: '轉接紀錄', path: '/service/handovers', permission: 'service.view', description: '客人呼叫真人客服與客服接手的紀錄' },
          { label: '對話流程', path: '/service/flows', permission: 'flow.view', description: '客人傳訊息時，依關鍵字啟動的自動對話流程' },
          { label: 'AI 知識庫', path: '/service/knowledge', permission: 'knowledge.view', description: 'AI 回答問題時依據的民宿資訊' },
          { label: '客服規則', path: '/service/rules', permission: 'service_rule.view', description: '真人客服轉接的關鍵字、逾時與通知對象' },
        ],
      },
      {
        key: 'customers', label: '客戶與行銷', path: '/customers', icon: Users, permission: 'customer.view',
        children: [
          { label: '客戶資料', path: '/customers', permission: 'customer.view', description: '所有跟官方帳號互動過的聯絡人' },
          { label: '訊息發送', path: '/marketing/send', permission: 'marketing.view', description: '查詢客戶名單、套用範本、批次發送 LINE 訊息' },
        ],
      },
      {
        key: 'housekeeping', label: '房務管理', path: '/housekeeping', icon: Shirt, permission: 'housekeeping.view',
        children: [
          { label: '房務總覽', path: '/housekeeping', permission: 'housekeeping.view', description: '今日退房、今日入住、待洗布巾、低庫存耗材' },
          { label: '布巾', path: '/housekeeping/linens', permission: 'housekeeping.view', description: '重複使用、每次送洗依件計價的布巾' },
          { label: '耗材', path: '/housekeeping/consumables', permission: 'housekeeping.view', description: '會被用掉、需要補貨的耗材' },
          { label: '洗滌', path: '/housekeeping/laundry', permission: 'housekeeping.view', description: '某天入住訂單要交給洗滌廠的布巾清單' },
          { label: '房務統計', path: '/housekeeping/statistics', permission: 'housekeeping.view', description: '洗滌成本統計與核對' },
        ],
      },
    ],
  },
  {
    section: '商品',
    items: [
      {
        key: 'inventory', label: '房型與空間', path: '/inventory/rooms', icon: DoorOpen, permission: 'inventory.view',
        children: [
          { label: '房間', path: '/inventory/rooms', permission: 'inventory.view', description: '會進入計價與訂房的房間' },
          { label: '公共空間', path: '/inventory/spaces', permission: 'inventory.view', description: '客廳、廚房等設施，不進入房價計算' },
        ],
      },
      {
        key: 'pricing', label: '價格中心', path: '/pricing', icon: Coins, permission: 'pricing.view',
        children: [
          { label: '價格總覽', path: '/pricing', permission: 'pricing.view', description: '目前價格設定的摘要' },
          { label: '價格設定', path: '/pricing/settings', permission: 'pricing.view', description: '基礎價格、日期規則、包棟、加人、連住、促銷' },
          { label: '報價模擬器', path: '/pricing/simulator', permission: 'pricing.view', description: '用目前設定試算，看每一天的價格怎麼來' },
        ],
      },
    ],
  },
  {
    section: '自動化',
    items: [
      {
        key: 'integrations', label: '串接管理', path: '/integrations/line', icon: Plug, permission: 'integration.view',
        children: [
          { label: 'LINE 官方帳號', path: '/integrations/line', permission: 'integration.view', description: '客戶用、廠商用、團隊內部用的官方帳號' },
          { label: 'OTA 平台', path: '/integrations/ota', permission: 'integration.view', description: 'Airbnb、Booking.com 等平台的行事曆同步' },
          { label: 'Google 行事曆', path: '/integrations/google-calendar', permission: 'integration.view', description: '把房況推送到 Google 行事曆' },
          { label: '通知對象', path: '/integrations/notifications', permission: 'integration.view', description: '轉接通知與排程推播的收件名單' },
        ],
      },
      {
        key: 'automation', label: '自動化排程', path: '/automation/rules', icon: Zap, permission: 'automation.view',
        children: [
          { label: '自動化規則', path: '/automation/rules', permission: 'automation.view', description: '系統在背景自動執行的任務' },
          { label: '執行紀錄', path: '/automation/history', permission: 'automation.view', description: '每次排程的執行結果' },
        ],
      },
    ],
  },
  {
    section: '管理',
    items: [
      // 系統管理只留「設定民宿怎麼運作」的頁面；帳號權限、參數、紀錄各自獨立成入口，
      // 九個頁籤擠在一條捲動列裡找不到東西（使用者反映太擁擠）。
      {
        key: 'admin', label: '系統管理', path: '/admin/property', icon: Settings, permission: 'system.view',
        children: [
          { label: '民宿基本資料', path: '/admin/property', permission: 'system.view', description: '民宿名稱、客服 LINE、禮金內容' },
          { label: 'AI 引擎', path: '/admin/ai', permission: 'ai_setting.view', description: 'AI 供應商、模型、金鑰與系統指令' },
          { label: '訂房規則', path: '/admin/booking-rules', permission: 'system.view', description: '訂金、押金、匯款期限、包棟開放' },
          { label: '安全性', path: '/admin/security', permission: 'system.view', description: '登入政策、主帳號、對話紀錄保留' },
        ],
      },
      {
        key: 'access', label: '帳號與權限', path: '/access/users', icon: ShieldCheck, permission: 'account.view',
        children: [
          { label: '使用者', path: '/access/users', permission: 'account.view', description: '邀請同事、指派角色、停權與重置 2FA' },
          { label: '角色與權限', path: '/access/roles', permission: 'role.view', description: '自訂角色、勾選每個角色可以做的事' },
        ],
      },
      { key: 'parameters', label: '參數設定', path: '/parameters', icon: SlidersHorizontal, permission: 'system.view', description: '訊息範本裡的 [變數] 要從訂單、客戶或民宿設定的哪個欄位取值' },
      { key: 'audit', label: '操作紀錄', path: '/audit', icon: ScrollText, permission: 'audit.view', description: '誰在什麼時候、把什麼從什麼改成什麼' },
      { key: 'errors', label: '錯誤紀錄', path: '/errors', icon: AlertTriangle, permission: 'error_log.view', description: 'AI、LINE、OTA 同步、行事曆、排程與後端 API 發生過的錯誤' },
    ],
  },
];

export interface ResolvedNav {
  section: NavSection;
  item: NavItem;
  child?: NavChild;
}

// 路徑 → 所在的分區／入口／頁籤。麵包屑、頁首、模組頁籤的「目前是哪一頁」都用這個。
// 先找完全相符的頁籤；沒有就找「路徑以入口為前綴」的（例如 /bookings/abc-123 屬於訂房營運）。
export function resolveNav(pathname: string): ResolvedNav | null {
  for (const section of navigation) {
    for (const item of section.items) {
      const child = item.children?.find((c) => c.path === pathname);
      if (child) return { section, item, child };
      if (item.path === pathname) return { section, item, child: item.children?.[0] };
    }
  }
  // 子頁面（/admin/roles/:id、/admin/accounts/:id）：先用完整頁籤路徑比對，權限才會跟著頁籤
  // （role.view）而不是模組入口（system.view）——否則有 system.view 的人守衛會放他進角色編輯器
  for (const section of navigation) {
    for (const item of section.items) {
      const child = (item.children || [])
        .filter((c) => c.path !== item.path && pathname.startsWith(c.path + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (child) return { section, item, child };
    }
  }
  // 前綴比對：詳情頁（/bookings/:id、/customers/:id）沒有自己的頁籤，歸到所屬入口
  let best: ResolvedNav | null = null;
  for (const section of navigation) {
    for (const item of section.items) {
      const prefixes = [item.path, ...(item.children?.map((c) => c.path) || [])]
        .map((p) => p.split('/').slice(0, 2).join('/'))
        .filter((p) => p !== '/');
      for (const prefix of new Set(prefixes)) {
        if (pathname.startsWith(prefix + '/') || pathname === prefix) {
          if (!best || prefix.length > best.item.path.length) best = { section, item };
        }
      }
    }
  }
  return best;
}

/** 這條路徑需要的權限。沒登記的路徑回 null，呼叫端預設只給 admin。 */
export function permissionForPath(pathname: string): Permission | null {
  const r = resolveNav(pathname);
  if (!r) return null;
  return r.child?.permission ?? r.item.permission;
}

// 舊網址 → 新網址（§160）。書籤與圖文選單裡的連結不會壞。
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/orders': '/bookings',
  '/room-calendar': '/bookings/calendar',
  '/room-pricing': '/pricing',
  '/room-pricing/formula': '/pricing/settings',
  '/room-pricing/quote': '/pricing/simulator',
  '/ai-service-center': '/service',
  '/service/conversations': '/service',
  '/standard-messages': '/service/flows',
  '/message-variables': '/parameters',
  '/knowledge-base': '/service/knowledge',
  '/broadcast': '/marketing/send',
  '/linens': '/housekeeping/linens',
  '/consumables': '/housekeeping/consumables',
  '/system-settings': '/admin/ai',
  '/ai-settings': '/admin/ai',
  '/line-settings': '/integrations/line',
  '/handover-rules': '/service/rules',
  '/room-spaces': '/inventory/rooms',
  '/scheduled-tasks': '/automation/rules',
  '/accounts': '/access/users',
  '/operation-logs': '/audit',
  // 2026-09 從系統管理拆出去的頁面
  '/admin/accounts': '/access/users',
  '/admin/roles': '/access/roles',
  '/admin/message-variables': '/parameters',
  '/admin/audit': '/audit',
  '/admin/errors': '/errors',
  '/access': '/access/users',
  // 模組入口沒有自己內容的，導到第一個頁籤
  '/inventory': '/inventory/rooms',
  '/integrations': '/integrations/line',
  '/automation': '/automation/rules',
  '/admin': '/admin/property',
  '/marketing': '/marketing/send',
};

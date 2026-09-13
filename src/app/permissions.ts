// ========================================================================
// Permission Registry（權限管理 V2 §57–58）：全系統權限的唯一定義。
//
// 角色是給人看的（管理員可自訂），權限是給程式判斷的（固定 code，只隨版本新增）。
// 這個檔案是前端、Netlify Functions、資料庫 seed（scripts/gen-permission-seed.mjs 產生
// supabase_schema.sql 的 permissions／範本角色區塊）三邊共用的來源——不要在別處手打 code 字串。
//
// 命名：<resource>.<action>；特殊能力用第三段（booking.payment.verify）。
// 粒度：Resource＋業務動作，避免「booking.manage」這種一把抓，也避免「booking.phone.edit」這種太細。
// 安全：這裡只是介面引導與 Functions 的判斷依據之一；資料庫 RLS 的 has_permission() 用同一套 code。
// ========================================================================

export type RiskLevel = 'low' | 'medium' | 'high';

export type PermissionModule =
  | 'dashboard' | 'booking' | 'service' | 'customer' | 'housekeeping' | 'inventory'
  | 'pricing' | 'integration' | 'automation' | 'system' | 'account' | 'audit';

export interface PermissionDef {
  code: string;
  module: PermissionModule;
  name: string;
  description: string;
  risk: RiskLevel;
  /** 勾這個權限時自動帶上的前置權限（例如 edit 需要 view） */
  requires?: string[];
}

export const MODULE_LABELS: Record<PermissionModule, string> = {
  dashboard: '工作台',
  booking: '訂房營運',
  service: '客服與 AI',
  customer: '客戶與行銷',
  housekeeping: '房務管理',
  inventory: '房型與空間',
  pricing: '價格中心',
  integration: '串接管理',
  automation: '自動化排程',
  system: '系統管理',
  account: '帳號與權限',
  audit: '稽核',
};

export const MODULE_ORDER: PermissionModule[] = ['dashboard', 'booking', 'service', 'customer', 'housekeeping', 'inventory', 'pricing', 'integration', 'automation', 'system', 'account', 'audit'];

export const RISK_LABELS: Record<RiskLevel, string> = { low: '一般', medium: '敏感', high: '高風險' };

const P = (code: string, module: PermissionModule, name: string, description: string, risk: RiskLevel = 'low', requires?: string[]): PermissionDef =>
  ({ code, module, name, description, risk, ...(requires?.length ? { requires } : {}) });

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  // ---- 工作台
  P('dashboard.view', 'dashboard', '查看工作台', '首頁的今日 KPI、待辦與未來入住。'),

  // ---- 訂房營運
  P('booking.view', 'booking', '查看訂單', '訂單列表與詳情的基本資料。'),
  P('booking.create', 'booking', '新增訂單', '後台手動建立訂單。', 'low', ['booking.view']),
  P('booking.edit', 'booking', '修改訂單', '修改客人資料、日期、房間、金額與備註。', 'low', ['booking.view']),
  P('booking.cancel', 'booking', '取消訂單', '把訂單改成「取消」，紀錄保留。', 'medium', ['booking.view']),
  P('booking.delete', 'booking', '刪除訂單', '永久刪除訂單，連同房間與布巾用量，無法復原。', 'high', ['booking.view']),
  P('booking.payment.view', 'booking', '查看付款資料', '看得到匯款末五碼與入住密碼。', 'medium', ['booking.view']),
  P('booking.payment.verify', 'booking', '確認付款／推進狀態', '核對訂金或尾款，依流程把訂單推到下一關。', 'medium', ['booking.view', 'booking.payment.view']),
  P('booking.refund.process', 'booking', '處理退款', '把待退款的訂單標記為已退款。會留下操作紀錄。', 'high', ['booking.view', 'booking.payment.view']),
  P('booking.override_conflict', 'booking', '處理撞期／候補', '清除 OTA 撞期旗標、決定系統攔下的撞期訂單怎麼走。', 'high', ['booking.view', 'conflict.view']),
  P('booking.history.view', 'booking', '查看訂單異動紀錄', '訂單詳情的操作紀錄時間軸（誰在何時改了什麼）。', 'low', ['booking.view']),
  P('calendar.view', 'booking', '查看房況行事曆', '月曆與手機列表檢視。'),
  P('calendar.manage', 'booking', '設定旺季／連假', '維護行事曆上的旺季與連假日期。', 'medium', ['calendar.view']),
  P('conflict.view', 'booking', '查看待辦與候補／衝突', '待辦事項中心與候補／衝突頁。', 'low', ['booking.view']),

  // ---- 客服與 AI
  P('service.view', 'service', '查看客服工作台', '對話清單、對話內容與客戶脈絡。'),
  P('service.reply', 'service', '回覆客人', '在工作台直接回覆客人（會用官方帳號推播）。', 'medium', ['service.view']),
  P('service.handover', 'service', '接手／轉回 AI', '把客人切成真人模式、轉回 AI、標記轉接已處理。', 'medium', ['service.view']),
  P('conversation.diagnostic', 'service', '查看 AI 判斷過程', '客人訊息旁的 ⓘ：意圖、抓到的欄位、決策過程與錯誤。', 'low', ['service.view']),
  P('conversation.raw_ai_output', 'service', '查看 AI 原文', 'AI 回覆的原始 JSON／文字（除錯用）。', 'medium', ['service.view', 'conversation.diagnostic']),
  P('flow.view', 'service', '查看對話流程', '對話流程的設定內容。'),
  P('flow.manage', 'service', '編輯對話流程', '新增、修改、刪除對話流程與步驟。改壞會影響客人訂房。', 'medium', ['flow.view']),
  P('flow.test', 'service', '測試對話', '用模擬器測試一句話會被判成什麼（會呼叫 AI）。', 'low', ['flow.view']),
  P('knowledge.view', 'service', '查看知識庫', 'AI 知識庫的條目與檔案。'),
  P('knowledge.manage', 'service', '編輯知識庫', '新增、修改、刪除、啟用／停用知識庫條目。', 'medium', ['knowledge.view']),
  P('knowledge.test', 'service', '測試 AI 回答', '用目前知識庫實際問 AI 一次（會呼叫 AI）。', 'low', ['knowledge.view']),
  P('service_rule.view', 'service', '查看客服規則', '轉接關鍵字、通知對象、逾時設定。'),
  P('service_rule.manage', 'service', '修改客服規則', '修改轉接關鍵字、通知對象、逾時設定。', 'medium', ['service_rule.view']),

  // ---- 客戶與行銷
  P('customer.view', 'customer', '查看客戶', '客戶列表與詳情、訂房紀錄、最近對話。'),
  P('customer.edit', 'customer', '修改客戶', '重新抓取暱稱、行銷拒收開關。', 'low', ['customer.view']),
  P('customer.personal_data.delete', 'customer', '清除客戶個資', '永久刪除客人的聯絡人、對話與轉接紀錄。無法復原，主帳號才可執行。', 'high', ['customer.view']),
  P('marketing.view', 'customer', '查看訊息發送', '訊息發送頁、名單查詢、LINE 額度。'),
  P('marketing.send', 'customer', '發送訊息', '批次推播 LINE 訊息給客人（消耗官方帳號額度）。', 'medium', ['marketing.view']),
  P('marketing.template.manage', 'customer', '管理訊息範本', '新增、修改、刪除訊息範本。', 'low', ['marketing.view']),

  // ---- 房務管理
  P('housekeeping.view', 'housekeeping', '查看房務', '房務總覽、布巾、耗材、洗滌單。'),
  P('housekeeping.manage', 'housekeeping', '維護房務資料', '修改布巾品項、房型預設組合、耗材與庫存。', 'low', ['housekeeping.view']),
  P('linen.cost.view', 'housekeeping', '查看洗滌成本統計', '房務統計的成本報表。', 'low', ['housekeeping.view']),

  // ---- 房型與空間
  P('inventory.view', 'inventory', '查看房型與空間', '房間與公共空間的基本資料。'),
  P('inventory.manage', 'inventory', '維護房型與空間', '新增、修改、刪除房間與空間。影響計價與配房。', 'medium', ['inventory.view']),

  // ---- 價格中心
  P('pricing.view', 'pricing', '查看價格', '價格總覽與目前設定。'),
  P('pricing.manage', 'pricing', '修改價格', '基礎價、日期加價、特殊日期、包棟、加人、連住、促銷。直接影響報價。', 'high', ['pricing.view']),
  P('pricing.simulate', 'pricing', '報價模擬', '用目前設定試算報價。', 'low', ['pricing.view']),

  // ---- 串接管理
  // settings／line_channels 這兩張表的列裡就有金鑰，資料庫層擋不了單一欄位，所以純「查看」讀不到整列；
  // 這三個 *.view 目前是選單與頁籤的入口權限，頁面內容要 manage 或 secret.view 才載得到（詳見 supabase_schema.sql 9.8）。
  P('integration.view', 'integration', '查看串接', 'LINE 官方帳號、OTA、Google 行事曆、通知對象的頁面入口（設定內容需搭配「修改串接」）。'),
  P('integration.manage', 'integration', '修改串接', '新增、修改、停用官方帳號、OTA 頻道、行事曆與通知名單。', 'medium', ['integration.view']),
  P('integration.secret.view', 'integration', '顯示串接金鑰', '看見 LINE Token／Secret 等原文。', 'high', ['integration.view']),
  P('integration.ota.sync', 'integration', '手動同步 OTA／行事曆', '立即抓取第三方行事曆並同步。', 'medium', ['integration.view']),

  // ---- 自動化排程
  P('automation.view', 'automation', '查看排程', '自動化規則與執行結果。'),
  P('automation.manage', 'automation', '修改排程', '新增、修改、停用、刪除排程。排程會自動改訂單狀態與發訊息。', 'high', ['automation.view']),
  P('automation.run', 'automation', '立即執行排程', '不等排程時間直接跑一次。', 'high', ['automation.view']),

  // ---- 系統管理
  P('system.view', 'system', '查看系統設定', '民宿基本資料、訂房規則、安全性、進階設定的頁面入口（設定內容需搭配「修改系統設定」）。'),
  P('system.manage', 'system', '修改系統設定', '修改民宿基本資料、訂房規則、安全性、訊息變數。', 'medium', ['system.view']),
  P('ai_setting.view', 'system', '查看 AI 引擎設定', 'AI 引擎頁的入口（設定內容需搭配「修改 AI 引擎設定」）。'),
  P('ai_setting.manage', 'system', '修改 AI 引擎設定', '切換供應商、模型、金鑰、參數、系統指令。', 'medium', ['ai_setting.view']),
  P('ai_setting.test', 'system', '測試 AI 連線', '用畫面上的模型與金鑰實際呼叫一次。', 'low', ['ai_setting.view']),
  P('ai_setting.secret.view', 'system', '顯示 AI 金鑰', '看見 OpenAI／Gemini API Key 原文。', 'high', ['ai_setting.view']),

  // ---- 帳號與權限
  P('account.view', 'account', '查看使用者', '使用者清單、狀態、2FA、最後登入。'),
  P('account.invite', 'account', '邀請使用者', '寄送邀請並指定角色。', 'medium', ['account.view']),
  P('account.edit', 'account', '修改使用者', '改顯示名稱、停權與恢復。', 'medium', ['account.view']),
  P('account.reset_mfa', 'account', '重置 2FA', '移除他人的驗證器，對方下次登入要重新綁定。', 'high', ['account.view']),
  P('account.delete', 'account', '移除使用者', '把使用者從系統移除。', 'high', ['account.view']),
  P('role.view', 'account', '查看角色與權限', '角色清單與各角色的權限。'),
  P('role.manage', 'account', '建立／修改角色', '新增角色、勾選權限、停用或刪除角色。只能授予自己擁有的權限。', 'high', ['role.view']),
  P('role.assign', 'account', '指派角色', '把角色指派給使用者或移除。', 'high', ['role.view', 'account.view']),
  P('primary_admin.manage', 'account', '設定主帳號', '指定誰是主帳號（老闆本人）。', 'high', ['account.view']),

  // ---- 稽核
  P('audit.view', 'audit', '查看操作紀錄', '誰在何時把什麼從什麼改成什麼。'),
  P('error_log.view', 'audit', '查看錯誤紀錄', '系統錯誤與 AI 呼叫失敗。'),
];

/** 權限 code。用 string 而不是字面量聯集：code 的存在由測試（tests/booking-flow/permissions.test.ts）把關，導覽設定與按鈕才不用每加一個就改型別。 */
export type Permission = string;

export const PERMISSIONS: readonly string[] = PERMISSION_CATALOG.map((p) => p.code);
const CATALOG_BY_CODE = new Map(PERMISSION_CATALOG.map((p) => [p.code, p]));
export const permissionDef = (code: string): PermissionDef | undefined => CATALOG_BY_CODE.get(code);
export const permissionName = (code: string): string => CATALOG_BY_CODE.get(code)?.name || code;

// 需要真正寫入的權限（判斷「唯讀」提示列用）：只要有其中一個就不算唯讀
const READ_LIKE = /(\.view|\.simulate|\.test|\.diagnostic|\.raw_ai_output)$/;
export const WRITE_PERMISSIONS: readonly string[] = PERMISSION_CATALOG.filter((p) => !READ_LIKE.test(p.code)).map((p) => p.code);

// ------------------------------------------------------------------------
// 相依：勾 edit 自動帶 view（§20）。closure 回傳含所有前置權限的集合。
// ------------------------------------------------------------------------
export function withDependencies(codes: Iterable<string>): Set<string> {
  const out = new Set<string>();
  const visit = (c: string) => {
    if (out.has(c)) return;
    out.add(c);
    for (const r of CATALOG_BY_CODE.get(c)?.requires || []) visit(r);
  };
  for (const c of codes) visit(c);
  return out;
}

/** 取消某權限時，會連帶失效（依賴它）的其他已勾權限 */
export function dependentsOf(code: string, selected: Iterable<string>): string[] {
  const sel = new Set(selected);
  const out: string[] = [];
  const stack = [code];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const p of PERMISSION_CATALOG) {
      if (sel.has(p.code) && p.requires?.includes(cur) && !out.includes(p.code) && p.code !== code) {
        out.push(p.code);
        stack.push(p.code);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------------
// 模組快速 Preset（§21）：僅查看／日常操作（不含高風險）／完整管理
// ------------------------------------------------------------------------
export type PresetKind = 'view' | 'daily' | 'full';
export const PRESET_LABELS: Record<PresetKind, string> = { view: '僅查看', daily: '日常操作', full: '完整管理' };

export function modulePreset(module: PermissionModule, kind: PresetKind): string[] {
  const inModule = PERMISSION_CATALOG.filter((p) => p.module === module);
  if (kind === 'view') return inModule.filter((p) => p.code.endsWith('.view') && p.risk === 'low').map((p) => p.code);
  if (kind === 'daily') return [...withDependencies(inModule.filter((p) => p.risk !== 'high').map((p) => p.code))];
  return inModule.map((p) => p.code);
}

// ------------------------------------------------------------------------
// 範本角色（附錄 A、§60–65）。code 固定，名稱可在後台改；資料庫 seed 由這裡產生。
// super_admin 是不可刪除、不可停用的系統角色，永遠擁有全部權限。
// ------------------------------------------------------------------------
export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
}

const ALL = PERMISSION_CATALOG.map((p) => p.code);
const OWNER_ONLY = ['customer.personal_data.delete', 'primary_admin.manage'];

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  { code: 'super_admin', name: 'Super Admin', description: '系統最高權限，不可刪除、不可停用。只給老闆本人與備援帳號。', isSystem: true, permissions: ALL },
  { code: 'sys_admin', name: '系統管理員', description: '完整管理：設定、價格、串接、帳號都能改；不含清除客戶個資與設定主帳號。', isSystem: false, permissions: ALL.filter((c) => !OWNER_ONLY.includes(c)) },
  {
    code: 'staff', name: '客服人員', description: '訂單、確認付款、房況、客服對話與客戶；價格與房型只能看，不能改系統設定。', isSystem: false,
    permissions: [...withDependencies([
      'dashboard.view', 'booking.view', 'booking.create', 'booking.edit', 'booking.cancel', 'booking.payment.view', 'booking.payment.verify', 'booking.history.view',
      'calendar.view', 'conflict.view',
      'service.view', 'service.reply', 'service.handover', 'conversation.diagnostic',
      'customer.view', 'customer.edit', 'marketing.view', 'marketing.send', 'marketing.template.manage',
      'housekeeping.view', 'housekeeping.manage', 'linen.cost.view',
      'inventory.view', 'pricing.view', 'pricing.simulate',
    ])],
  },
  {
    code: 'housekeeping', name: '房務人員', description: '房況、訂單查看、房務、布巾、耗材與洗滌單。', isSystem: false,
    permissions: [...withDependencies(['dashboard.view', 'calendar.view', 'booking.view', 'housekeeping.view', 'housekeeping.manage', 'linen.cost.view', 'inventory.view'])],
  },
  {
    code: 'accounting', name: '會計', description: '訂單查看、付款確認、退款處理、洗滌成本。', isSystem: false,
    permissions: [...withDependencies(['dashboard.view', 'booking.view', 'booking.payment.view', 'booking.payment.verify', 'booking.refund.process', 'booking.history.view', 'customer.view', 'linen.cost.view'])],
  },
  {
    code: 'marketing', name: '行銷人員', description: '客戶資料、訊息發送與範本、知識庫查看。', isSystem: false,
    permissions: [...withDependencies(['dashboard.view', 'customer.view', 'marketing.view', 'marketing.send', 'marketing.template.manage', 'knowledge.view'])],
  },
  {
    code: 'viewer', name: '唯讀主管', description: '只看不改：工作台、訂單、房況、客戶、價格、房務、排程狀態與操作紀錄。', isSystem: false,
    permissions: [...withDependencies(['dashboard.view', 'booking.view', 'booking.history.view', 'calendar.view', 'conflict.view', 'customer.view', 'pricing.view', 'housekeeping.view', 'linen.cost.view', 'inventory.view', 'automation.view', 'audit.view'])],
  },
];

// 舊三角色 → 範本角色（§75 Phase 2、§76）。還沒被指派任何角色的帳號用這個對照取得權限；
// 資料庫的 has_permission() 與 Functions 的 requirePermission() 都用同一份對照。
export type LegacyRole = 'admin' | 'staff' | 'viewer';
export const LEGACY_ROLE_TEMPLATE: Record<LegacyRole, string> = { admin: 'sys_admin', staff: 'staff', viewer: 'viewer' };

export function legacyRolePermissions(role: string | null | undefined): readonly string[] {
  const code = LEGACY_ROLE_TEMPLATE[role as LegacyRole];
  return ROLE_TEMPLATES.find((t) => t.code === code)?.permissions || [];
}

/** 從一組角色的權限（含停用角色要先排除）算出有效權限：聯集（§10，不做 Deny）。 */
export function effectivePermissions(roles: { isActive: boolean; permissions: readonly string[] }[]): Set<string> {
  const out = new Set<string>();
  for (const r of roles) if (r.isActive) for (const c of r.permissions) out.add(c);
  return out;
}

/** 防止權限提升（§40）：只能授予自己擁有的權限；主帳號／Super Admin 例外。 */
export function grantableBy(callerPermissions: ReadonlySet<string>, callerIsOwner: boolean): Set<string> {
  if (callerIsOwner) return new Set(ALL);
  return new Set(ALL.filter((c) => callerPermissions.has(c)));
}

/**
 * 從有效權限反推舊的三級角色，寫回 admin_profiles.role 給還沒改成 has_permission() 的舊邏輯
 * （is_owner() 要求 admin、Functions 的 requireRole）用。過渡期結束後可移除。
 */
export function legacyRoleFromPermissions(codes: ReadonlySet<string>): LegacyRole {
  if (codes.has('system.manage') || codes.has('role.manage') || codes.has('account.edit')) return 'admin';
  if (WRITE_PERMISSIONS.some((c) => codes.has(c))) return 'staff';
  return 'viewer';
}

// ------------------------------------------------------------------------
// 純函式版的判斷（給沒有 React context 的地方：路由守衛、Functions）
// ------------------------------------------------------------------------
export function hasPermission(granted: ReadonlySet<string> | readonly string[] | null | undefined, permission: string): boolean {
  if (!granted) return false;
  return granted instanceof Set ? granted.has(permission) : (granted as readonly string[]).includes(permission);
}

export function hasAnyPermission(granted: ReadonlySet<string> | readonly string[] | null | undefined, permissions: readonly string[]): boolean {
  return permissions.some((p) => hasPermission(granted, p));
}

export function hasAllPermissions(granted: ReadonlySet<string> | readonly string[] | null | undefined, permissions: readonly string[]): boolean {
  return permissions.every((p) => hasPermission(granted, p));
}

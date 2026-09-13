// 權限管理 V2：Permission Registry 的完整性，以及相依／Preset／防提升／舊角色對照等純函式。
// 這些函式前端、Functions、資料庫 seed 三邊共用，壞了就是整個後台的授權都會歪掉。
import {
  MODULE_ORDER, PERMISSION_CATALOG, PERMISSIONS, ROLE_TEMPLATES, WRITE_PERMISSIONS,
  dependentsOf, effectivePermissions, grantableBy, legacyRoleFromPermissions, legacyRolePermissions, modulePreset, withDependencies,
} from '../../src/app/permissions';
import { navigation } from '../../src/app/navigation';
import { canAccessRoute, defaultRouteFor } from '../../src/lib/permissions';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const codes = new Set(PERMISSIONS);

// ---- 目錄完整性
t('權限 code 不重複', codes.size === PERMISSION_CATALOG.length, PERMISSION_CATALOG.length);
t('code 命名為 <resource>.<action>（小寫、底線、點）', PERMISSION_CATALOG.every((p) => /^[a-z_]+(\.[a-z_]+){1,2}$/.test(p.code)), PERMISSION_CATALOG.filter((p) => !/^[a-z_]+(\.[a-z_]+){1,2}$/.test(p.code)).map((p) => p.code));
t('每個權限都有名稱與說明', PERMISSION_CATALOG.every((p) => p.name && p.description));
t('模組都在 MODULE_ORDER 裡', PERMISSION_CATALOG.every((p) => MODULE_ORDER.includes(p.module)));
const badRequires = PERMISSION_CATALOG.flatMap((p) => (p.requires || []).filter((r) => !codes.has(r)).map((r) => `${p.code} -> ${r}`));
t('requires 指到的權限都存在', badRequires.length === 0, badRequires);
const sameModule = PERMISSION_CATALOG.flatMap((p) => (p.requires || []).filter((r) => PERMISSION_CATALOG.find((x) => x.code === r)?.module !== p.module).map((r) => `${p.code} -> ${r}`));
t('相依只在同一模組內（矩陣的模組全選／取消才不會跨模組連動）', sameModule.length === 0, sameModule);
const writeWithoutView = PERMISSION_CATALOG.filter((p) => !/\.view$/.test(p.code) && p.code !== 'dashboard.view' && !(p.requires || []).some((r) => /\.view$/.test(r)));
t('非 view 的權限都要求同資源的某個 view', writeWithoutView.length === 0, writeWithoutView.map((p) => p.code));
t('高風險權限有標 risk=high（刪除訂單、清除個資、主帳號）', ['booking.delete', 'customer.personal_data.delete', 'primary_admin.manage', 'account.delete'].every((c) => PERMISSION_CATALOG.find((p) => p.code === c)?.risk === 'high'));
t('WRITE_PERMISSIONS 不含 view／simulate／test', WRITE_PERMISSIONS.every((c) => !/(\.view|\.simulate|\.test|\.diagnostic|\.raw_ai_output)$/.test(c)));

// ---- 側欄／路由宣告的 code 都存在（打錯字 = 那一頁永遠進不去）
const navCodes = navigation.flatMap((s) => s.items.flatMap((i) => [i.permission, ...(i.children || []).map((c) => c.permission)]));
t('navigation.ts 的 permission 都在目錄裡', navCodes.every((c) => codes.has(c)), navCodes.filter((c) => !codes.has(c)));

// ---- 相依
t('withDependencies：payment.verify 帶出 booking.view 與 payment.view', (() => { const s = withDependencies(['booking.payment.verify']); return s.has('booking.view') && s.has('booking.payment.view') && s.size === 3; })());
t('withDependencies：conversation.raw_ai_output 帶出 diagnostic 與 service.view', withDependencies(['conversation.raw_ai_output']).size === 3);
t('dependentsOf：取消 booking.view 會連帶 booking.edit／payment.verify（遞迴）', (() => {
  const d = dependentsOf('booking.view', ['booking.view', 'booking.edit', 'booking.payment.view', 'booking.payment.verify', 'calendar.view']);
  return d.includes('booking.edit') && d.includes('booking.payment.view') && d.includes('booking.payment.verify') && !d.includes('calendar.view') && !d.includes('booking.view');
})());
t('dependentsOf：沒有人依賴時回空陣列', dependentsOf('booking.edit', ['booking.view', 'booking.edit']).length === 0);

// ---- Preset
const bView = modulePreset('booking', 'view');
t('僅查看：只有一般風險的 .view', bView.length > 0 && bView.every((c) => c.endsWith('.view')) && !bView.includes('booking.payment.view'), bView);
const bDaily = modulePreset('booking', 'daily');
t('日常操作：不含高風險，且相依完整', !bDaily.includes('booking.delete') && bDaily.includes('booking.payment.verify') && bDaily.includes('booking.payment.view'), bDaily);
const bFull = modulePreset('booking', 'full');
t('完整管理：模組全部', bFull.length === PERMISSION_CATALOG.filter((p) => p.module === 'booking').length);

// ---- 範本角色
t('範本 code 不重複、super_admin 是唯一系統角色', new Set(ROLE_TEMPLATES.map((r) => r.code)).size === ROLE_TEMPLATES.length && ROLE_TEMPLATES.filter((r) => r.isSystem).map((r) => r.code).join() === 'super_admin');
t('super_admin 擁有全部權限', ROLE_TEMPLATES.find((r) => r.code === 'super_admin')!.permissions.length === PERMISSION_CATALOG.length);
const closedTemplates = ROLE_TEMPLATES.filter((r) => withDependencies(r.permissions).size !== r.permissions.length);
t('範本的權限相依都已補齊', closedTemplates.length === 0, closedTemplates.map((r) => r.code));
t('sys_admin 不含主帳號專屬權限', (() => { const p = ROLE_TEMPLATES.find((r) => r.code === 'sys_admin')!.permissions; return !p.includes('customer.personal_data.delete') && !p.includes('primary_admin.manage') && p.includes('role.manage'); })());
t('viewer 沒有任何寫入權限', !ROLE_TEMPLATES.find((r) => r.code === 'viewer')!.permissions.some((c) => WRITE_PERMISSIONS.includes(c)));
t('staff 不能改系統設定、不能刪訂單', (() => { const p = ROLE_TEMPLATES.find((r) => r.code === 'staff')!.permissions; return !p.includes('system.manage') && !p.includes('booking.delete') && p.includes('booking.payment.verify'); })());

// ---- 舊角色對照（升級過渡）
t('舊 admin → sys_admin 範本', legacyRolePermissions('admin').length === ROLE_TEMPLATES.find((r) => r.code === 'sys_admin')!.permissions.length);
t('舊 staff → staff 範本、viewer → viewer 範本、未知 → 空', legacyRolePermissions('staff').includes('service.reply') && legacyRolePermissions('viewer').includes('audit.view') && legacyRolePermissions('xxx').length === 0);
t('反推：有 role.manage → admin；只有寫入 → staff；只讀 → viewer', legacyRoleFromPermissions(new Set(['role.manage'])) === 'admin' && legacyRoleFromPermissions(new Set(['booking.view', 'booking.edit'])) === 'staff' && legacyRoleFromPermissions(new Set(['booking.view'])) === 'viewer');
t('反推範本本身：sys_admin→admin、staff→staff、viewer→viewer', legacyRoleFromPermissions(new Set(legacyRolePermissions('admin'))) === 'admin' && legacyRoleFromPermissions(new Set(legacyRolePermissions('staff'))) === 'staff' && legacyRoleFromPermissions(new Set(legacyRolePermissions('viewer'))) === 'viewer');

// ---- 聯集與防提升
t('effectivePermissions：停用角色排除、其餘聯集', (() => {
  const s = effectivePermissions([{ isActive: true, permissions: ['a.view'] }, { isActive: false, permissions: ['b.view'] }, { isActive: true, permissions: ['a.view', 'c.view'] }]);
  return s.size === 2 && s.has('a.view') && s.has('c.view') && !s.has('b.view');
})());
t('grantableBy：主帳號全部；一般帳號只有自己有的', grantableBy(new Set(), true).size === PERMISSION_CATALOG.length && grantableBy(new Set(['booking.view', 'nope']), false).size === 1);

// ---- 路由守衛
t('canAccessRoute：有 role.view 才能進 /admin/roles 與 /admin/roles/:id', canAccessRoute(new Set(['role.view']), '/admin/roles') && canAccessRoute(new Set(['role.view']), '/admin/roles/abc') && !canAccessRoute(new Set(['system.view']), '/admin/roles/abc'));
t('canAccessRoute：沒登記的路徑 default deny，只有 system.manage 能進', !canAccessRoute(new Set(['booking.view']), '/nowhere') && canAccessRoute(new Set(['system.manage']), '/nowhere'));
t('canAccessRoute：/bookings/:id 用 booking.view', canAccessRoute(new Set(['booking.view']), '/bookings/123') && !canAccessRoute(new Set(['calendar.view']), '/bookings/123'));
t('defaultRouteFor：沒有工作台就落到第一個進得去的入口', defaultRouteFor(new Set(['dashboard.view'])) === '/' && defaultRouteFor(new Set(['housekeeping.view'])).startsWith('/housekeeping'));

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

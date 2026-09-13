// 把 src/app/permissions.ts（Permission Registry）產生成 supabase_schema.sql 裡的 seed 區塊。
// 用法：node scripts/gen-permission-seed.mjs   （改過 registry 之後跑一次，再 commit schema）
// 只改寫 -- BEGIN GENERATED PERMISSIONS ... -- END GENERATED PERMISSIONS 之間的內容，其餘不動。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const outDir = join(tmpdir(), 'perm-registry');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'permissions.cjs');
buildSync({ entryPoints: ['src/app/permissions.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: outFile, logLevel: 'silent' });
const reg = createRequire(import.meta.url)(outFile);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lines = [];
lines.push('-- （由 scripts/gen-permission-seed.mjs 從 src/app/permissions.ts 產生，不要手改）');
lines.push('INSERT INTO public.permissions (code, module, resource, action, name, description, risk_level, sort_order, is_active) VALUES');
lines.push(reg.PERMISSION_CATALOG.map((p, i) => {
  const [resource, ...rest] = p.code.split('.');
  return `  (${q(p.code)}, ${q(p.module)}, ${q(resource)}, ${q(rest.join('.'))}, ${q(p.name)}, ${q(p.description)}, ${q(p.risk)}, ${i + 1}, true)`;
}).join(',\n'));
lines.push('ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, resource = EXCLUDED.resource, action = EXCLUDED.action, name = EXCLUDED.name, description = EXCLUDED.description, risk_level = EXCLUDED.risk_level, sort_order = EXCLUDED.sort_order, is_active = true;');
lines.push(`-- 不在 registry 裡的舊權限停用（不刪：role_permissions 的歷史還在）`);
lines.push(`UPDATE public.permissions SET is_active = false WHERE code NOT IN (${reg.PERMISSION_CATALOG.map((p) => q(p.code)).join(', ')});`);
lines.push('');
lines.push('-- 範本角色：名稱與說明只在第一次建立時寫入（管理員之後可以改名），is_system 每次同步。');
lines.push('INSERT INTO public.roles (code, name, description, is_system, sort_order) VALUES');
lines.push(reg.ROLE_TEMPLATES.map((r, i) => `  (${q(r.code)}, ${q(r.name)}, ${q(r.description)}, ${r.isSystem}, ${(i + 1) * 10})`).join(',\n'));
lines.push('ON CONFLICT (code) DO UPDATE SET is_system = EXCLUDED.is_system;');
lines.push('');
lines.push('-- 範本角色的權限：角色剛建立（還沒有任何權限列）時才套範本，之後由後台維護，重跑不會蓋掉管理員的調整。');
lines.push('-- super_admin 例外：每次都補齊全部啟用中的權限。');
lines.push('DO $seed_roles$');
lines.push('DECLARE r_id UUID;');
lines.push('BEGIN');
for (const r of reg.ROLE_TEMPLATES) {
  lines.push(`  SELECT id INTO r_id FROM public.roles WHERE code = ${q(r.code)};`);
  if (r.isSystem) {
    lines.push(`  INSERT INTO public.role_permissions (role_id, permission_id) SELECT r_id, p.id FROM public.permissions p WHERE p.is_active ON CONFLICT DO NOTHING;`);
  } else {
    lines.push(`  IF NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role_id = r_id) THEN`);
    lines.push(`    INSERT INTO public.role_permissions (role_id, permission_id) SELECT r_id, p.id FROM public.permissions p WHERE p.code IN (${r.permissions.map(q).join(', ')}) ON CONFLICT DO NOTHING;`);
    lines.push(`  END IF;`);
  }
}
lines.push('END');
lines.push('$seed_roles$;');

const schemaPath = 'supabase_schema.sql';
const schema = readFileSync(schemaPath, 'utf8');
const begin = '-- BEGIN GENERATED PERMISSIONS';
const end = '-- END GENERATED PERMISSIONS';
const a = schema.indexOf(begin);
const b = schema.indexOf(end);
if (a < 0 || b < 0) { console.error('找不到 GENERATED PERMISSIONS 標記'); process.exit(1); }
const next = schema.slice(0, a + begin.length) + '\n' + lines.join('\n') + '\n' + schema.slice(b);
writeFileSync(schemaPath, next);
console.log(`permissions: ${reg.PERMISSION_CATALOG.length}, roles: ${reg.ROLE_TEMPLATES.length} → ${schemaPath}`);

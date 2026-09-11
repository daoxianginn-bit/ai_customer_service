// 訂房對話流程的測試執行器。
//
// 專案沒有測試框架，這裡用既有的 esbuild 把每個 *.test.ts 打包成一支 Node 腳本直接跑：
// 外部依賴（Supabase、LINE SDK、OpenAI、node-fetch）用 stubs/ 底下的記憶體假件取代，
// 所以測的是 line-webhook.ts 裡真實的編排程式碼，只有最外層的 I/O 是假的。
//
//   npm run test:flow
//
// 每個測試檔自己印 ✓/✗ 並以 exit code 回報；任何一支失敗整體就失敗。
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = mkdtempSync(join(tmpdir(), 'booking-flow-tests-'));
const stubs = (name) => join(here, 'stubs', name);

const files = readdirSync(here).filter((f) => f.endsWith('.test.ts'));
let failed = 0;

for (const file of files) {
  const outfile = join(outDir, file.replace(/\.ts$/, '.js'));
  await build({
    entryPoints: [join(here, file)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile,
    logLevel: 'error',
    external: ['@netlify/functions'],
    alias: {
      '@supabase/supabase-js': stubs('supabase.ts'),
      '@line/bot-sdk': stubs('line.ts'),
      openai: stubs('openai.ts'),
      'node-fetch': stubs('node-fetch.ts'),
    },
  });

  console.log(`\n=== ${file} ===`);
  const r = spawnSync(process.execPath, [outfile], {
    stdio: 'inherit',
    env: { ...process.env, SUPABASE_URL: 'http://test', SUPABASE_SERVICE_ROLE_KEY: 'test' },
  });
  if (r.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed} 個測試檔失敗`);
  process.exit(1);
}
console.log('\n全部通過');

import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { runTaskNow } from './scheduled-tasks-run';

// ========================================================================
// 「立即執行」專用端點（排程管理頁的測試按鈕、房況行事曆的「手動整合第三方」）
//
// 為什麼不直接打 scheduled-tasks-run：那支在 netlify.toml 裡設了 schedule，是 Netlify 的
// 「排程函式」，而排程函式在正式站上不能用 HTTP 叫起來（Netlify 文件原話：You can't invoke
// scheduled functions directly with a URL），POST 過去拿到的是一個沒有內容的回應。前端因此
// 一律報「伺服器沒有回應內容，可能是資料量較大而逾時」——那個猜測是錯的，任何排程、任何資料量
// 都一樣失敗，因為請求根本沒進到函式裡。
//
// 所以手動執行要有自己的一支「一般函式」（這支沒有 schedule，可以用 HTTP 呼叫），
// 實際邏輯仍是 scheduled-tasks-run 的 runTaskNow()，兩條路徑跑的是同一份程式碼。
//
// 注意：一般函式有 10 秒的執行上限，排程函式沒有。訂單量大的時候「行事曆整合同步」按立即執行
// 仍可能中斷（那時候「資料量較大」才是真的原因），但排程自己跑的那條路不受影響。
// ========================================================================

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: '只接受 POST' }) };
  }
  let body: any = null;
  try { body = JSON.parse(event.body || ''); } catch { body = null; }
  if (!body?.taskId) {
    return { statusCode: 400, body: JSON.stringify({ error: '缺少 taskId' }) };
  }
  return runTaskNow(event, body.taskId);
};

export const handler: Handler = withErrorLogging(supabase, 'run-task-now', rawHandler);

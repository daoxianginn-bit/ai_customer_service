import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requirePermission } from '../../src/lib/requireRole';
import { simulateFlowTurn } from './line-webhook';

const supabaseAdmin = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// 流程測試模擬器（V2 §36）：「對話流程」頁右側的測試對話。
// 把一句話丟進跟正式對話同一套意圖分類／欄位擷取，回報判斷結果，不寫任何正式資料。
// 只有管理員能用（會消耗 AI 呼叫）。
// ========================================================================
const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const guard = await requirePermission(supabaseAdmin, event as any, 'flow.test');
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }
  const message = String(body.message || '').trim();
  if (!message) return { statusCode: 400, body: JSON.stringify({ error: '請輸入要測試的訊息' }) };

  const result = await simulateFlowTurn({
    message,
    flowId: body.flowId || null,
    phase: ['collecting', 'awaiting_confirmation', 'awaiting_remittance'].includes(body.phase) ? body.phase : 'collecting',
    collected: body.collected && typeof body.collected === 'object' ? body.collected : {},
    recentMessages: Array.isArray(body.recentMessages) ? body.recentMessages.slice(-6) : [],
  });
  return { statusCode: 200, body: JSON.stringify(result) };
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'flow-test', rawHandler);

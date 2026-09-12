import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';
import { callGPT, callGemini } from './line-webhook';

const supabaseAdmin = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_SERVICE_ROLE_KEY || '');

// ========================================================================
// 知識庫「測試 AI 回答」（V2 §38）：用目前啟用中的知識庫與 AI 設定，回答一句測試問題。
// 走的是 line-webhook 一般問答同一支 callGPT／callGemini，所以答出來的就是客人會看到的；
// 不帶對話歷史、不寫 conversations、不推播。只有管理員能用（會消耗 AI 呼叫）。
// ========================================================================
const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ error: guard.error.body }) };

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ error: '請求格式錯誤' }) }; }
  const message = String(body.message || '').trim();
  if (!message) return { statusCode: 400, body: JSON.stringify({ error: '請輸入要測試的問題' }) };

  const [{ data: settings }, { data: kbItems }] = await Promise.all([
    supabaseAdmin.from('settings').select('*').single(),
    supabaseAdmin.from('knowledge_base_items').select('*').eq('is_active', true),
  ]);
  if (!settings) return { statusCode: 500, body: JSON.stringify({ error: '讀取系統設定失敗' }) };

  const startedAt = Date.now();
  try {
    const reply = settings.active_ai === 'gpt'
      ? (await callGPT(settings, message, kbItems || [], undefined, [], null)).text
      : await callGemini(settings, message, kbItems || [], undefined, [], null);
    return { statusCode: 200, body: JSON.stringify({ reply, provider: settings.active_ai, model: settings.active_ai === 'gpt' ? settings.gpt_model_name : settings.gemini_model_name, knowledgeCount: (kbItems || []).length, latency_ms: Date.now() - startedAt }) };
  } catch (e: any) {
    return { statusCode: 502, body: JSON.stringify({ error: `AI 呼叫失敗：${e.message}`, latency_ms: Date.now() - startedAt }) };
  }
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'knowledge-test', rawHandler);

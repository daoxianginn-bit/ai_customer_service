import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';
import { requireRole } from '../../src/lib/requireRole';
import { callGPT, callGemini } from './line-webhook';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// ========================================================================
// 系統設定頁的「測試連線」：用畫面上填的模型與金鑰實際呼叫一次，回報能不能用。
//
// 模型名稱是自由輸入的文字，程式只照名字決定走哪條 API（含 gpt-5 走 Responses API、
// o1/o3 走推理版參數、其餘走 chat/completions），名字對不對只有 OpenAI／Google 自己知道。
// 以前要等客人真的來聊天、客服收到「AI 呼叫失敗」通知才發現名字打錯或金鑰失效，
// 現在存檔前就能按一下確認。
//
// 走的是 line-webhook 裡同一個 callGPT／callGemini，所以測到的就是正式對話會走的那條路、
// 同一組參數（推理力道、verbosity、max tokens）——不是另外寫一份形狀相近的請求。
//
// 測的是「畫面上目前填的值」（由前端帶上來），不是資料庫裡已存的，這樣可以先測再存。
// 金鑰本來就已經在管理員的瀏覽器表單裡，送回自己的後端不會多暴露什麼；只有管理員能呼叫。
// ========================================================================

const rawHandler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const guard = await requireRole(supabaseAdmin, event as any, ['admin']);
  if ('error' in guard) return { statusCode: guard.error.statusCode, body: JSON.stringify({ ok: false, error: guard.error.body }) };

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: JSON.stringify({ ok: false, error: '請求格式錯誤' }) }; }

  const provider: 'gpt' | 'gemini' = body.active_ai === 'gemini' ? 'gemini' : 'gpt';
  const model = String(provider === 'gpt' ? body.gpt_model_name : body.gemini_model_name || '').trim();
  const apiKey = String(provider === 'gpt' ? body.gpt_api_key : body.gemini_api_key || '').trim();
  if (!model) return { statusCode: 400, body: JSON.stringify({ ok: false, error: '請先填模型名稱' }) };
  if (!apiKey) return { statusCode: 400, body: JSON.stringify({ ok: false, error: '請先填 API Key' }) };

  // 只帶 AI 呼叫會用到的欄位，其他一律不信前端
  const settings = {
    active_ai: provider,
    gpt_model_name: model,
    gpt_api_key: apiKey,
    gpt_reasoning_effort: body.gpt_reasoning_effort || 'none',
    gpt_verbosity: body.gpt_verbosity || 'low',
    gpt_max_tokens: Number(body.gpt_max_tokens) > 0 ? Number(body.gpt_max_tokens) : 200,
    gpt_temperature: Number.isFinite(Number(body.gpt_temperature)) ? Number(body.gpt_temperature) : 0.7,
    gemini_model_name: model,
    gemini_api_key: apiKey,
    gemini_max_tokens: Number(body.gemini_max_tokens) > 0 ? Number(body.gemini_max_tokens) : 200,
    gemini_temperature: Number.isFinite(Number(body.gemini_temperature)) ? Number(body.gemini_temperature) : 0.7,
    gemini_thinking_level: body.gemini_thinking_level || 'low',
    system_prompt: '',
  };

  // 跟意圖分類一樣要求輸出固定 JSON——順便驗證這個模型聽得懂結構化輸出的指令，
  // 這正是訂房流程最依賴的能力。
  const prompt = '你是連線測試。只輸出這段 JSON，不要任何其他文字：{"status":"ok","echo":"稻香"}';
  const startedAt = Date.now();
  try {
    const raw = provider === 'gpt'
      ? (await callGPT(settings, '測試', [], prompt)).text
      : await callGemini(settings, '測試', [], prompt);
    const latencyMs = Date.now() - startedAt;
    let structuredOk = false;
    try {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
      const parsed = JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
      structuredOk = parsed?.status === 'ok';
    } catch { /* 回了東西但不是要求的 JSON，下面照實回報 */ }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, provider, model, latency_ms: latencyMs, reply: raw.slice(0, 300), structured_ok: structuredOk }),
    };
  } catch (e: any) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, provider, model, latency_ms: Date.now() - startedAt, error: e?.message || String(e) }),
    };
  }
};

export const handler: Handler = withErrorLogging(supabaseAdmin, 'ai-test', rawHandler);

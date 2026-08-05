import { Handler } from '@netlify/functions';
import { Client, validateSignature, WebhookEvent } from '@line/bot-sdk';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

async function logConversation(userId: string, nickname: string | null, direction: 'inbound' | 'outbound', content: string, source: string) {
  try {
    await supabase.from('conversations').insert({ line_user_id: userId, nickname, direction, content, source });
  } catch (e) {
    console.error('[Log] Failed to insert conversation:', e);
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { data: settings, error: settingsError } = await supabase.from('settings').select('*').single();
  if (settingsError || !settings) return { statusCode: 500, body: 'Failed to fetch settings' };

  const lineClient = new Client({
    channelAccessToken: settings.line_channel_access_token,
    channelSecret: settings.line_channel_secret,
  });

  const signature = event.headers['x-line-signature'] || '';
  if (!validateSignature(event.body || '', settings.line_channel_secret, signature)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  const events: WebhookEvent[] = JSON.parse(event.body || '').events;

  for (const lineEvent of events) {
    if (lineEvent.type === 'message' && lineEvent.message.type === 'text') {
      const userId = lineEvent.source.userId!;
      const userMessage = (lineEvent.message.text || '').trim();
      const eventId = (lineEvent as any).webhookEventId;

      if (!userMessage || !eventId) continue;

      // 1. 強制去重 (關鍵防禦)
      // 嘗試寫入 event_id，如果重複，資料庫會報錯
      const { error: eventError } = await supabase
        .from('processed_events')
        .insert({ event_id: eventId });

      if (eventError) {
        console.log(`[Dedupe] Skipping already processed event: ${eventId}`);
        continue; // 這是重複請求，直接跳過，不進行任何狀態更新
      }

      // 2. 獲取當前狀態
      const { data: userState } = await supabase.from('user_states').select('*').eq('line_user_id', userId).single();
      let nickname = userState?.nickname || null;

      await logConversation(userId, nickname, 'inbound', userMessage, 'user');

      // 3. 關鍵字偵測
      const handoverKeywords = settings.handover_keywords
        ?.replace(/，/g, ',')
        .split(',')
        .map((k: string) => k.trim())
        .filter((k: string) => k.length > 0) || [];

      const matchedKeyword = handoverKeywords.find((k: string) => {
        if (k.length === 1) return userMessage === k;
        return userMessage.includes(k);
      });

      if (matchedKeyword) {
        console.log(`[Handover] Triggered by keyword: ${matchedKeyword}`);
        try { const p = await lineClient.getProfile(userId); nickname = p.displayName; } catch (e) {}

        const startedAt = new Date().toISOString();

        await supabase.from('user_states').upsert({
          line_user_id: userId,
          nickname,
          is_human_mode: true,
          last_human_interaction: startedAt
        });

        await supabase.from('handover_logs').insert({
          line_user_id: userId,
          nickname,
          triggered_keyword: matchedKeyword,
          started_at: startedAt,
          status: 'open',
        });

        const replyText = '已為您轉接真人客服，請稍候。';
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: replyText });
        await logConversation(userId, nickname, 'outbound', replyText, 'system');

        const agentIds = settings.agent_user_ids?.split(',').map((id: string) => id.trim()).filter(Boolean);
        if (agentIds) {
          for (const id of agentIds) {
            try { await lineClient.pushMessage(id, { type: 'text', text: `🔔 真人通知：【${nickname}】正在呼叫專人。\n觸發字：${matchedKeyword}\n原文：${userMessage}` }); } catch (e) {}
          }
        }
        continue;
      }

      // 4. 真人模式判斷
      if (userState?.is_human_mode) {
        const lastInteraction = new Date(userState.last_human_interaction).getTime();
        const timeoutMs = (settings.handover_timeout_minutes || 30) * 60 * 1000;
        if (new Date().getTime() - lastInteraction < timeoutMs) continue;

        await supabase.from('user_states').update({ is_human_mode: false }).eq('line_user_id', userId);
        await supabase
          .from('handover_logs')
          .update({ status: 'closed', ended_at: new Date().toISOString(), resolved_by: 'timeout_auto' })
          .eq('line_user_id', userId)
          .eq('status', 'open');
      }

      // 5. 呼叫 AI
      if (!settings.is_ai_enabled) continue;

      const { data: kbItemsData } = await supabase.from('knowledge_base_items').select('*').eq('is_active', true);
      const kbItems = kbItemsData || [];

      let aiResult = '';
      try {
        if (settings.active_ai === 'gpt') aiResult = (await callGPT(settings, userMessage, kbItems)).text;
        else aiResult = await callGemini(settings, userMessage, kbItems);
      } catch (e: any) {
        aiResult = `❌ AI 錯誤：\n${e.message}`;
      }

      if (aiResult) {
        await lineClient.replyMessage(lineEvent.replyToken, { type: 'text', text: aiResult });
        await logConversation(userId, nickname, 'outbound', aiResult, settings.active_ai === 'gpt' ? 'ai_gpt' : 'ai_gemini');
      }
    }
  }
  return { statusCode: 200, body: 'OK' };
};

async function callGPT(settings: any, currentMessage: string, kbItems: any[]) {
  const isGPT5 = settings.gpt_model_name.includes('gpt-5');
  const textBlock = kbItems.filter((i) => i.type === 'text' && i.content).map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
  let fileContent = '';
  for (const item of kbItems.filter((i) => i.type === 'file' && i.file_url)) {
    try {
      const r = await fetch(item.file_url);
      if (r.ok) fileContent += `\n\n【${item.title}】\n${await r.text()}`;
    } catch (e) {}
  }
  const systemContent = `${settings.system_prompt}\n\n參考資料：\n${textBlock}${fileContent}`;

  if (isGPT5) {
    const body: any = {
      model: settings.gpt_model_name,
      input: `System: ${systemContent}\nUser: ${currentMessage}`,
      reasoning: { effort: settings.gpt_reasoning_effort || 'none' },
      text: { verbosity: settings.gpt_verbosity || 'medium' }
    };
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.gpt_api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result: any = await res.json();
    if (!res.ok || result.error) throw new Error(result.error?.message || res.statusText);
    return { text: result.output?.text || '' };
  }

  const openai = new OpenAI({ apiKey: settings.gpt_api_key });
  const messages: any[] = [{ role: 'system', content: systemContent }, { role: 'user', content: currentMessage }];
  const params: any = { model: settings.gpt_model_name, messages };
  if (settings.gpt_model_name.startsWith('o1') || settings.gpt_model_name.startsWith('o3')) {
    params.max_completion_tokens = settings.gpt_max_tokens;
  } else {
    params.max_tokens = settings.gpt_max_tokens;
    params.temperature = settings.gpt_temperature;
  }
  const completion = await openai.chat.completions.create(params);
  return { text: completion.choices[0].message.content || '' };
}

async function callGemini(settings: any, currentMessage: string, kbItems: any[]) {
  const textBlock = kbItems.filter((i) => i.type === 'text' && i.content).map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
  const userParts: any[] = [{ text: `System: ${settings.system_prompt}\nReference: ${textBlock}` }];

  for (const item of kbItems.filter((i) => i.type === 'file' && i.file_url)) {
    try {
      const r = await fetch(item.file_url);
      if (r.ok) {
        const b = await r.arrayBuffer();
        userParts.push({ inline_data: { data: Buffer.from(b).toString('base64'), mime_type: item.file_url.endsWith('.pdf') ? 'application/pdf' : 'text/plain' } });
      }
    } catch (e) {}
  }
  userParts.push({ text: `User: ${currentMessage}` });
  const contents = [{ role: 'user', parts: userParts }];
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${settings.gemini_model_name}:generateContent?key=${settings.gemini_api_key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature: 1.0, maxOutputTokens: settings.gemini_max_tokens } })
  });
  const result: any = await res.json();
  if (!res.ok || result.error) throw new Error(result.error?.message || 'Gemini API Error');
  return result.candidates?.[0]?.content?.parts?.find((p: any) => p.text)?.text || '';
}

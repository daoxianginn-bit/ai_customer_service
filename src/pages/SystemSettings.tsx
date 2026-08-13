import { useEffect, useState } from 'react';
import { Save, Bot, MessageCircle, UserCheck, Copy, FileSpreadsheet, Clock, SlidersHorizontal } from 'lucide-react';
import { useSettings } from '../lib/useSettings';
import { PageHeader, Button } from '../components/ui';
import CollapsibleSection from '../components/CollapsibleSection';

// 原本是 AI 引擎設定／LINE 串接設定／轉接規則三個獨立頁面，內容都只是對同一張
// settings 表的單一表單（同一個 useSettings() hook），合成一頁三個收合區塊，
// 選單從 3 條變 1 條。欄位名稱、儲存邏輯、驗證規則完全沒動，純粹是版面搬家。
export default function SystemSettings() {
  const { settings, setSettings, loading, saving, handleSave, handleChange } = useSettings();
  const [webhookUrl, setWebhookUrl] = useState('');

  useEffect(() => {
    setWebhookUrl(window.location.origin + '/.netlify/functions/line-webhook');
  }, []);

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    alert('Webhook URL 已複製');
  };

  if (loading) return <div>載入中...</div>;
  if (!settings) return <div>找不到設定檔</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-20">
      <PageHeader
        icon={<SlidersHorizontal className="w-6 h-6 text-green-600" />}
        title="基本設定"
        description="AI 引擎、LINE 串接與真人轉接規則"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      />

      <CollapsibleSection title="AI 引擎設定" icon={<Bot className="w-5 h-5 text-green-600" />} description="選擇 AI 供應商、模型參數與系統指令" defaultOpen>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <button onClick={() => setSettings({ ...settings, active_ai: 'gpt' })} className={`p-6 rounded-xl border-2 transition-all flex items-center gap-4 ${settings.active_ai === 'gpt' ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
              <div className={`p-3 rounded-lg ${settings.active_ai === 'gpt' ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500'}`}><Bot className="w-6 h-6" /></div>
              <div className="text-left"><h3 className="font-bold">OpenAI GPT</h3><p className="text-sm text-gray-500">使用 GPT-5/4 系列模型</p></div>
            </button>
            <button onClick={() => setSettings({ ...settings, active_ai: 'gemini' })} className={`p-6 rounded-xl border-2 transition-all flex items-center gap-4 ${settings.active_ai === 'gemini' ? 'border-purple-500 bg-purple-50' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
              <div className={`p-3 rounded-lg ${settings.active_ai === 'gemini' ? 'bg-purple-500 text-white' : 'bg-gray-100 text-gray-500'}`}><Bot className="w-6 h-6" /></div>
              <div className="text-left"><h3 className="font-bold">Google Gemini</h3><p className="text-sm text-gray-500">使用 Gemini 1.5 系列</p></div>
            </button>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h4 className="text-sm font-bold text-gray-600">{settings.active_ai === 'gpt' ? 'OpenAI 設定' : 'Gemini 設定'}</h4>
            <div className="grid grid-cols-2 gap-6">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                <input type="password" name={settings.active_ai === 'gpt' ? 'gpt_api_key' : 'gemini_api_key'} value={settings.active_ai === 'gpt' ? (settings.gpt_api_key || '') : (settings.gemini_api_key || '')} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" placeholder="輸入 API 金鑰" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">模型名稱</label>
                <input type="text" name={settings.active_ai === 'gpt' ? 'gpt_model_name' : 'gemini_model_name'} value={settings.active_ai === 'gpt' ? (settings.gpt_model_name || '') : (settings.gemini_model_name || '')} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" placeholder="例如: gpt-4.1-mini, gpt-5.2" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Temperature</label>
                  <input type="number" step="0.1" name={settings.active_ai === 'gpt' ? 'gpt_temperature' : 'gemini_temperature'} value={settings.active_ai === 'gpt' ? settings.gpt_temperature : settings.gemini_temperature} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Max Tokens</label>
                  <input type="number" name={settings.active_ai === 'gpt' ? 'gpt_max_tokens' : 'gemini_max_tokens'} value={settings.active_ai === 'gpt' ? settings.gpt_max_tokens : settings.gemini_max_tokens} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
                </div>
              </div>

              {settings.active_ai === 'gemini' && settings.gemini_model_name?.includes('gemini-3') && (
                <div className="col-span-2 p-4 bg-purple-50 rounded-lg border border-purple-100">
                  <label className="block text-sm font-bold text-purple-800 mb-1">Gemini 3 思考程度 (Thinking Level)</label>
                  <select name="gemini_thinking_level" value={settings.gemini_thinking_level || 'high'} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg bg-white">
                    <option value="minimal">Minimal (不思考/極速 - 僅 Flash 支援)</option>
                    <option value="low">Low (降低延遲)</option>
                    <option value="medium">Medium (平衡 - 僅 Flash 支援)</option>
                    <option value="high">High (預設/深層推理)</option>
                  </select>
                  <p className="text-xs text-purple-600 mt-2">Gemini 3 系列建議 Temperature 保持為 1.0 以獲得最佳推理效果。</p>
                </div>
              )}

              {settings.active_ai === 'gpt' && settings.gpt_model_name?.includes('gpt-5') && (
                <div className="col-span-2 grid grid-cols-2 gap-4 p-4 bg-green-50 rounded-lg border border-green-100">
                  <div>
                    <label className="block text-sm font-bold text-green-800 mb-1">推理力道 (Reasoning Effort)</label>
                    <select name="gpt_reasoning_effort" value={settings.gpt_reasoning_effort || 'none'} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg bg-white">
                      <option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">XHigh</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-green-800 mb-1">詳細程度 (Verbosity)</label>
                    <select name="gpt_verbosity" value={settings.gpt_verbosity || 'medium'} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg bg-white">
                      <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t pt-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">AI 系統指令 (System Prompt)</label>
            <textarea name="system_prompt" value={settings.system_prompt || ''} onChange={handleChange} rows={4} className="w-full px-4 py-2 border rounded-lg" />
            <p className="text-xs text-gray-400 mt-1">參考資料請至「AI知識庫」新增，會自動附加到此指令後方。</p>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="LINE 串接設定" icon={<MessageCircle className="w-5 h-5 text-green-600" />} description="管理 Webhook 與 Channel 憑證">
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Webhook URL</label>
              <div className="flex gap-2 font-mono text-sm">
                <input type="text" readOnly value={webhookUrl} className="flex-1 px-4 py-2 border rounded-lg bg-gray-50" />
                <button onClick={handleCopyWebhook} className="p-2 border rounded-lg hover:bg-gray-100"><Copy className="w-5 h-5" /></button>
              </div>
              <p className="text-xs text-gray-400 mt-1">貼到 LINE Developers Console 的 Webhook URL 欄位，並開啟 "Use webhook"。</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channel Access Token</label>
              <input type="password" name="line_channel_access_token" value={settings.line_channel_access_token || ''} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channel Secret</label>
              <input type="password" name="line_channel_secret" value={settings.line_channel_secret || ''} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
            </div>
          </div>

          <div className="border-t pt-6 space-y-4">
            <h4 className="text-sm font-bold text-gray-600 flex items-center gap-2"><FileSpreadsheet className="w-4 h-4" />「報價」試算表（鏡射備份用）</h4>
            <p className="text-sm text-gray-500">
              訂房紀錄以資料庫為主要來源，這裡設定的試算表只是同步鏡射一份備份，寫入失敗不影響訂房流程本身。
              這份試算表要分享給服務帳號（跟知識庫共用同一組），且權限要設為「編輯者」而不是「檢視者」。
            </p>
            <div className="flex flex-wrap gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">試算表 ID</label>
                <input name="quote_sheet_id" value={settings.quote_sheet_id || ''} onChange={handleChange} className="w-80 px-4 py-2 border rounded-lg" placeholder="Google 試算表網址中 /d/ 後面那一段" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">工作表 GID</label>
                <input name="quote_sheet_gid" value={settings.quote_sheet_gid || '0'} onChange={handleChange} className="w-28 px-4 py-2 border rounded-lg" placeholder="0" />
              </div>
            </div>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection title="轉接規則" icon={<UserCheck className="w-5 h-5 text-green-600" />} description="設定何時將對話轉給真人客服，以及資料保留政策">
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">轉接關鍵字 (逗號隔開)</label>
              <input type="text" name="handover_keywords" value={settings.handover_keywords || ''} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">自動轉回 AI 時間 (分)</label>
              <input type="number" name="handover_timeout_minutes" value={settings.handover_timeout_minutes || 30} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
              <p className="text-xs text-gray-400 mt-1">客人持續傳訊息會一直延後這個時間，真正沒互動滿這個時間才會轉回 AI。</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">訂金匯款截止時間 (小時)</label>
              <input type="number" min={1} name="payment_deadline_hours" value={settings.payment_deadline_hours ?? 10} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
              <p className="text-xs text-gray-400 mt-1">顧客送出訂房確認後幾小時內要匯款，逾時由「排程管理」自動取消。</p>
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">客服專員 LINE IDs (通知用)</label>
              <input type="text" name="agent_user_ids" value={settings.agent_user_ids || ''} onChange={handleChange} placeholder="U123..., U456..." className="w-full px-4 py-2 border rounded-lg" />
            </div>
          </div>

          <div className="border-t pt-6">
            <label className="block text-sm font-medium text-gray-700 mb-1 flex items-center gap-2"><Clock className="w-4 h-4 text-gray-500" />對話紀錄保留天數</label>
            <input type="number" min={1} name="conversation_retention_days" value={settings.conversation_retention_days ?? 3} onChange={handleChange} className="w-40 px-4 py-2 border rounded-lg" />
            <p className="text-xs text-gray-400 mt-1">超過此天數的對話紀錄會由每日排程自動清除，預設 3 天。</p>
          </div>
        </div>
      </CollapsibleSection>
    </div>
  );
}

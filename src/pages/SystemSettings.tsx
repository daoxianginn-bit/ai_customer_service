import { useEffect, useState } from 'react';
import { Save, Bot, MessageCircle, UserCheck, Copy, Clock, SlidersHorizontal, CalendarDays } from 'lucide-react';
import { useSettings } from '../lib/useSettings';
import { PageHeader, Button } from '../components/ui';

// 原本是 AI 引擎設定／LINE 串接設定／轉接規則三個獨立頁面，內容都只是對同一張
// settings 表的單一表單（同一個 useSettings() hook），合成一頁三個分頁籤（比照
// LinenManagement.tsx 既有的多分頁寫法），一次只顯示一個區塊，不用一直往下滾展開/收合。
// 欄位名稱、儲存邏輯、驗證規則完全沒動，純粹是版面搬家。
type Tab = 'ai' | 'line' | 'handover';

const TABS: { key: Tab; label: string; icon: JSX.Element }[] = [
  { key: 'ai', label: 'AI 引擎設定', icon: <Bot className="w-4 h-4" /> },
  { key: 'line', label: 'LINE 串接設定', icon: <MessageCircle className="w-4 h-4" /> },
  { key: 'handover', label: '轉接規則', icon: <UserCheck className="w-4 h-4" /> },
];

export default function SystemSettings() {
  const { settings, setSettings, loading, saving, handleSave, handleChange } = useSettings();
  const [webhookUrl, setWebhookUrl] = useState('');
  const [tab, setTab] = useState<Tab>('ai');

  useEffect(() => {
    setWebhookUrl(window.location.origin + '/.netlify/functions/line-webhook');
  }, []);

  const handleCopyWebhook = () => {
    navigator.clipboard.writeText(webhookUrl);
    alert('Webhook URL 已複製');
  };

  // 訂閱網址帶著 token 當通行碼（行事曆軟體沒辦法帶 Authorization 標頭），所以這串等同密碼。
  const calendarFeedUrl = settings?.calendar_feed_token
    ? `${window.location.origin}/.netlify/functions/calendar-feed?token=${encodeURIComponent(settings.calendar_feed_token)}`
    : '';

  const handleGenerateCalendarToken = () => {
    if (settings?.calendar_feed_token && !confirm('重新產生後，原本已經訂閱舊網址的行事曆會失效，需要重新訂閱一次。確定要繼續嗎？')) return;
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    setSettings({ ...settings, calendar_feed_token: token });
  };

  const handleCopyCalendarUrl = () => {
    navigator.clipboard.writeText(calendarFeedUrl);
    alert('訂閱網址已複製');
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

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="flex border-b overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm whitespace-nowrap border-b-2 transition-colors ${
                tab === t.key ? 'border-green-600 text-green-700 font-medium bg-green-50' : 'border-transparent text-gray-600 hover:bg-gray-50'
              }`}
            >
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {tab === 'ai' && (
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
        )}

        {tab === 'line' && (
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
            <h4 className="text-sm font-bold text-gray-600 flex items-center gap-2"><CalendarDays className="w-4 h-4" />訂房行事曆訂閱</h4>
            <p className="text-sm text-gray-500">
              把這個網址加進 Google 日曆／TimeTree／Apple 行事曆的「訂閱網址」，訂單就會直接顯示在手機日曆上。
              資料直接讀資料庫，跟「訂單管理」「房況行事曆」完全一致。只會列出已鎖房的訂單（待預定～已確認），待報價和已取消的不會出現。
            </p>
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠️ 這個網址包含顧客姓名，且任何人拿到都能直接開啟，等同密碼，請勿外流或貼到公開群組。
            </p>
            {calendarFeedUrl ? (
              <div className="flex gap-2 font-mono text-sm">
                <input type="text" readOnly value={calendarFeedUrl} className="flex-1 px-4 py-2 border rounded-lg bg-gray-50" />
                <button onClick={handleCopyCalendarUrl} className="p-2 border rounded-lg hover:bg-gray-100" title="複製訂閱網址"><Copy className="w-5 h-5" /></button>
              </div>
            ) : (
              <p className="text-sm text-gray-400">尚未啟用。點下方按鈕產生一組通行碼後記得按「儲存設定」。</p>
            )}
            <Button variant="secondary" onClick={handleGenerateCalendarToken}>
              {settings.calendar_feed_token ? '重新產生通行碼' : '產生通行碼並啟用'}
            </Button>
          </div>
        </div>
        )}

        {tab === 'handover' && (
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
        )}
      </div>
    </div>
  );
}

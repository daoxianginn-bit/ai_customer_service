import { useEffect, useState } from 'react';
import { Save, Bot, MessageCircle, UserCheck, Clock, SlidersHorizontal, CalendarDays, CheckCircle2, XCircle } from 'lucide-react';
import { useSettings } from '../lib/useSettings';
import { PageHeader, Button } from '../components/ui';
import LineChannelsPanel from '../components/LineChannelsPanel';
import NotificationGroupsPanel from '../components/NotificationGroupsPanel';
import OtaChannelsPanel from '../components/OtaChannelsPanel';

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
  const [tab, setTab] = useState<Tab>('ai');

  // Webhook 網址現在是「每個官方帳號各一組」，由 LineChannelsPanel 各自產生並提供複製，
  // 不再有全站共用的那一個。

  if (loading) return <div>載入中...</div>;
  if (!settings) return <div>找不到設定檔</div>;

  return (
    <div className="w-full space-y-6 pb-20">
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
          {/* 改版前這裡是單一組 Channel Access Token / Secret（存在 settings 表）。
              現在支援多個官方帳號（客戶用／廠商用／團隊內部用），憑證改存 line_channels 表，
              由下面這個面板管理；settings 的舊欄位保留但已不再被程式讀取。 */}
          <LineChannelsPanel />

          <div className="border-t pt-6">
            <NotificationGroupsPanel />
          </div>

          <div className="border-t pt-6 space-y-4">
            <h4 className="text-sm font-bold text-gray-600 flex items-center gap-2"><CalendarDays className="w-4 h-4" />Google 行事曆同步</h4>
            <p className="text-sm text-gray-500">
              「排程管理」的「行事曆整合同步」排程會把目前所有已鎖房的訂單（不分直接訂房或第三方平台匯入）
              直接寫入下面指定的 Google 行事曆，取代舊版「產生一個訂閱網址、自己貼到 Google/TimeTree/Apple」的做法——
              設定好之後不用手動訂閱，排程跑過就能在 Google 日曆上看到最新狀況。
            </p>
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              一次性設定步驟：(1) 到 Google Cloud Console 建立一個服務帳號、下載金鑰（JSON），貼到下方「服務帳號金鑰」欄位。
              (2) 打開目標 Google 行事曆的設定，把它「分享」給金鑰裡 <code className="font-mono">client_email</code> 那組信箱，權限選「可以變更活動」。
              (3) 到「排程管理」新增一筆「行事曆整合同步」排程。金鑰內容等同密碼，請勿外流。
            </p>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Google 行事曆 ID</label>
              <input
                type="text" name="google_calendar_id" value={settings.google_calendar_id || ''} onChange={handleChange}
                placeholder="例如 abcd1234@group.calendar.google.com，或個人行事曆用你的 Google 帳號 email"
                className="w-full px-4 py-2 border rounded-lg font-mono text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">在 Google 日曆該行事曆的「設定與共用」頁面可以找到「行事曆 ID」。</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">服務帳號金鑰 (JSON)</label>
              <textarea
                name="google_service_account_json" value={settings.google_service_account_json || ''} onChange={handleChange}
                rows={6} placeholder='{"type": "service_account", "client_email": "...", "private_key": "...", ...}'
                className="w-full px-4 py-2 border rounded-lg font-mono text-xs"
              />
            </div>
            {settings.google_calendar_last_synced_at && (
              <p className="flex items-start gap-1.5 text-xs">
                {settings.google_calendar_last_sync_status === 'success' ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                )}
                <span>
                  <span className="text-gray-400">上次同步 {new Date(settings.google_calendar_last_synced_at).toLocaleString('zh-TW')}：</span>
                  <span className="text-gray-600">{settings.google_calendar_last_sync_summary}</span>
                </span>
              </p>
            )}
          </div>

          <div className="border-t pt-6">
            <OtaChannelsPanel />
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

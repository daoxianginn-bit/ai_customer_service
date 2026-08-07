import { Save, Bot } from 'lucide-react';
import { useSettings } from '../lib/useSettings';
import { PageHeader, Button } from '../components/ui';

export default function AiSettings() {
  const { settings, setSettings, loading, saving, handleSave, handleChange } = useSettings();

  if (loading) return <div>載入中...</div>;
  if (!settings) return <div>找不到設定檔</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-20">
      <PageHeader
        icon={<Bot className="w-6 h-6 text-green-600" />}
        title="AI 引擎設定"
        description="選擇 AI 供應商、模型參數與系統指令"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      />

      {/* AI Provider Switch */}
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

      {/* AI Specific Settings */}
      <div className="bg-white p-8 rounded-xl shadow-sm border space-y-6">
        <h3 className="text-lg font-bold border-b pb-4 flex items-center gap-2">
          <Bot className="w-5 h-5 text-green-600" />
          {settings.active_ai === 'gpt' ? 'OpenAI 設定' : 'Gemini 設定'}
        </h3>
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

      {/* System Prompt */}
      <div className="bg-white p-8 rounded-xl shadow-sm border space-y-4">
        <h3 className="text-lg font-bold border-b pb-4">AI 系統指令</h3>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">System Prompt</label>
          <textarea name="system_prompt" value={settings.system_prompt || ''} onChange={handleChange} rows={4} className="w-full px-4 py-2 border rounded-lg" />
          <p className="text-xs text-gray-400 mt-1">參考資料請至「知識庫管理」新增，會自動附加到此指令後方。</p>
        </div>
      </div>
    </div>
  );
}

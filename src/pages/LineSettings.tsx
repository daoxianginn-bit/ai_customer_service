import { useEffect, useState } from 'react';
import { Save, Copy, MessageCircle, FileSpreadsheet } from 'lucide-react';
import { useSettings } from '../lib/useSettings';

export default function LineSettings() {
  const { settings, loading, saving, handleSave, handleChange } = useSettings();
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
    <div className="max-w-4xl mx-auto space-y-8 pb-20">
      <div className="flex justify-between items-center bg-white p-6 rounded-xl shadow-sm border">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">LINE 串接設定</h2>
          <p className="text-gray-500">管理 Webhook 與 Channel 憑證</p>
        </div>
        <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
          <Save className="w-4 h-4" />
          {saving ? '儲存中...' : '儲存變更'}
        </button>
      </div>

      <div className="bg-white p-8 rounded-xl shadow-sm border space-y-6">
        <h3 className="text-lg font-bold border-b pb-4 flex items-center gap-2"><MessageCircle className="w-5 h-5 text-green-500" />LINE Messaging API</h3>
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
      </div>

      <div className="bg-white p-8 rounded-xl shadow-sm border space-y-6">
        <h3 className="text-lg font-bold border-b pb-4 flex items-center gap-2"><FileSpreadsheet className="w-5 h-5 text-green-600" />「報價」試算表（鏡射備份用）</h3>
        <p className="text-sm text-gray-500 -mt-2">
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
  );
}

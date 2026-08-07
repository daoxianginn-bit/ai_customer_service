import { Save, UserCheck, Clock } from 'lucide-react';
import { useSettings } from '../lib/useSettings';
import { PageHeader, Button } from '../components/ui';

export default function HandoverRules() {
  const { settings, loading, saving, handleSave, handleChange } = useSettings();

  if (loading) return <div>載入中...</div>;
  if (!settings) return <div>找不到設定檔</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-20">
      <PageHeader
        icon={<UserCheck className="w-6 h-6 text-green-600" />}
        title="轉接規則"
        description="設定何時將對話轉給真人客服，以及資料保留政策"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      />

      <div className="bg-white p-8 rounded-xl shadow-sm border space-y-6">
        <h3 className="text-lg font-bold border-b pb-4 flex items-center gap-2"><UserCheck className="w-5 h-5 text-red-500" />真人轉接</h3>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">轉接關鍵字 (逗號隔開)</label>
            <input type="text" name="handover_keywords" value={settings.handover_keywords || ''} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">自動轉回 AI 時間 (分)</label>
            <input type="number" name="handover_timeout_minutes" value={settings.handover_timeout_minutes || 30} onChange={handleChange} className="w-full px-4 py-2 border rounded-lg" />
          </div>
          <div className="col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">客服專員 LINE IDs (通知用)</label>
            <input type="text" name="agent_user_ids" value={settings.agent_user_ids || ''} onChange={handleChange} placeholder="U123..., U456..." className="w-full px-4 py-2 border rounded-lg" />
          </div>
        </div>
      </div>

      <div className="bg-white p-8 rounded-xl shadow-sm border space-y-6">
        <h3 className="text-lg font-bold border-b pb-4 flex items-center gap-2"><Clock className="w-5 h-5 text-gray-500" />對話紀錄保留</h3>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">保留天數</label>
          <input type="number" min={1} name="conversation_retention_days" value={settings.conversation_retention_days ?? 3} onChange={handleChange} className="w-40 px-4 py-2 border rounded-lg" />
          <p className="text-xs text-gray-400 mt-1">超過此天數的對話紀錄會由每日排程自動清除，預設 3 天。</p>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, MessageSquare, UserCheck, Activity, Settings, Send, ClipboardList, CalendarDays, Users, BookOpen, Headphones, LayoutDashboard } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSettings } from '../lib/useSettings';
import { PageHeader, Switch } from '../components/ui';

export default function Overview() {
  const { settings, setSettings, loading, saving, handleSave } = useSettings();
  const [pendingHandovers, setPendingHandovers] = useState<number | null>(null);
  const [todayConversations, setTodayConversations] = useState<number | null>(null);
  const [todayHandovers, setTodayHandovers] = useState<number | null>(null);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const [{ count: pending }, { count: convCount }, { count: handoverCount }] = await Promise.all([
      supabase.from('user_states').select('*', { count: 'exact', head: true }).eq('is_human_mode', true),
      supabase.from('conversations').select('*', { count: 'exact', head: true }).gte('created_at', startOfToday.toISOString()),
      supabase.from('handover_logs').select('*', { count: 'exact', head: true }).gte('started_at', startOfToday.toISOString()),
    ]);

    setPendingHandovers(pending ?? 0);
    setTodayConversations(convCount ?? 0);
    setTodayHandovers(handoverCount ?? 0);
  };

  const toggleAiEnabled = async () => {
    const next = !settings.is_ai_enabled;
    setSettings({ ...settings, is_ai_enabled: next });
    await handleSave();
  };

  if (loading) return <div>載入中...</div>;
  if (!settings) return <div>找不到設定檔</div>;

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-20">
      <PageHeader icon={<LayoutDashboard className="w-6 h-6 text-green-600" />} title="首頁總覽" description="AI 客服系統目前運作狀態" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-col gap-2">
          <span className="text-sm text-gray-500 flex items-center gap-1"><Activity className="w-4 h-4" /> AI 客服狀態</span>
          <div className="flex items-center justify-between">
            <span className={`text-lg font-bold ${settings.is_ai_enabled ? 'text-green-600' : 'text-gray-400'}`}>{settings.is_ai_enabled ? '啟用中' : '已停用'}</span>
            <Switch checked={settings.is_ai_enabled} onChange={toggleAiEnabled} disabled={saving} />
          </div>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-col gap-2">
          <span className="text-sm text-gray-500 flex items-center gap-1"><Bot className="w-4 h-4" /> 使用引擎</span>
          <span className="text-lg font-bold text-gray-800">{settings.active_ai === 'gpt' ? 'OpenAI GPT' : 'Google Gemini'}</span>
          <span className="text-xs text-gray-400 truncate">{settings.active_ai === 'gpt' ? settings.gpt_model_name : settings.gemini_model_name}</span>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-col gap-2">
          <span className="text-sm text-gray-500 flex items-center gap-1"><UserCheck className="w-4 h-4" /> 待處理真人轉接</span>
          <span className="text-lg font-bold text-red-600">{pendingHandovers ?? '-'}</span>
        </div>

        <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-col gap-2">
          <span className="text-sm text-gray-500 flex items-center gap-1"><MessageSquare className="w-4 h-4" /> 今日對話則數</span>
          <span className="text-lg font-bold text-gray-800">{todayConversations ?? '-'}</span>
          <span className="text-xs text-gray-400">今日轉接 {todayHandovers ?? '-'} 次</span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Link to="/ai-service-center" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <Headphones className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">AI客服中心</span>
        </Link>
        <Link to="/orders" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <ClipboardList className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">訂單管理</span>
        </Link>
        <Link to="/broadcast" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <Send className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">客製訊息發送</span>
        </Link>
        <Link to="/room-calendar" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <CalendarDays className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">行事曆</span>
        </Link>
        <Link to="/customers" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <Users className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">客戶資料</span>
        </Link>
        <Link to="/knowledge-base" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">AI知識庫</span>
        </Link>
        <Link to="/system-settings" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <Bot className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">基本設定</span>
        </Link>
        <Link to="/accounts" className="bg-white p-5 rounded-xl shadow-sm border hover:border-green-400 hover:bg-green-50 transition-colors flex items-center gap-3">
          <Settings className="w-5 h-5 text-green-600" />
          <span className="font-medium text-gray-700">系統設定</span>
        </Link>
      </div>
    </div>
  );
}

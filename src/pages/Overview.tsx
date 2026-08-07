import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bot, MessageSquare, UserCheck, Activity, Settings, Send, ClipboardList, CalendarDays, Users, BookOpen, Headphones } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSettings } from '../lib/useSettings';

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
      <div className="bg-white p-6 rounded-xl shadow-sm border">
        <h2 className="text-2xl font-bold text-gray-800">首頁總覽</h2>
        <p className="text-gray-500">AI 客服系統目前運作狀態</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-col gap-2">
          <span className="text-sm text-gray-500 flex items-center gap-1"><Activity className="w-4 h-4" /> AI 客服狀態</span>
          <div className="flex items-center justify-between">
            <span className={`text-lg font-bold ${settings.is_ai_enabled ? 'text-green-600' : 'text-gray-400'}`}>{settings.is_ai_enabled ? '啟用中' : '已停用'}</span>
            <button
              onClick={toggleAiEnabled}
              disabled={saving}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${settings.is_ai_enabled ? 'bg-green-500' : 'bg-gray-300'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.is_ai_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
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
        <Link to="/ai-service-center" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <Headphones className="w-5 h-5 text-red-500" />
          <span className="font-medium text-gray-700">AI客服中心</span>
        </Link>
        <Link to="/orders" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <ClipboardList className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">訂單管理</span>
        </Link>
        <Link to="/broadcast" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <Send className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">客製訊息發送</span>
        </Link>
        <Link to="/room-calendar" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <CalendarDays className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">房況/行事曆</span>
        </Link>
        <Link to="/customers" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <Users className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">客戶資料</span>
        </Link>
        <Link to="/knowledge-base" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">AI知識庫</span>
        </Link>
        <Link to="/ai-settings" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <Bot className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">AI 引擎設定</span>
        </Link>
        <Link to="/accounts" className="bg-white p-5 rounded-xl shadow-sm border hover:border-blue-400 hover:bg-blue-50 transition-colors flex items-center gap-3">
          <Settings className="w-5 h-5 text-blue-500" />
          <span className="font-medium text-gray-700">系統設定</span>
        </Link>
      </div>
    </div>
  );
}

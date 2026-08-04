import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Save, Workflow, FileSpreadsheet, MessageSquareText } from 'lucide-react';
import CollapsibleSection from '../components/CollapsibleSection';
import MessageTemplateEditor from '../components/MessageTemplateEditor';

const QUOTE_MESSAGE_PLACEHOLDERS = ['入住日期', '退房日期', '人數', '是否包棟', '總金額'];
const CONFIRM_MESSAGE_PLACEHOLDERS = ['姓名', '入住日期', '退房日期', '是否包棟', '人數', '大人小孩', '總金額', '訂金', '匯款日時間'];

export default function BookingFlowSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  const [bookingTriggerKeywords, setBookingTriggerKeywords] = useState('');
  const [quoteSheetId, setQuoteSheetId] = useState('');
  const [quoteSheetGid, setQuoteSheetGid] = useState('0');
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [quoteMessage, setQuoteMessage] = useState('');
  const [confirmMessage, setConfirmMessage] = useState('');

  useEffect(() => {
    fetchSettings();
  }, []);

  const fetchSettings = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('settings')
      .select('id, booking_trigger_keywords, quote_sheet_id, quote_sheet_gid, booking_welcome_message, booking_quote_message, booking_confirm_message')
      .single();
    setSettingsId(data?.id || null);
    setBookingTriggerKeywords(data?.booking_trigger_keywords ?? '我要訂房,訂房');
    setQuoteSheetId(data?.quote_sheet_id ?? '');
    setQuoteSheetGid(data?.quote_sheet_gid ?? '0');
    setWelcomeMessage(data?.booking_welcome_message ?? '');
    setQuoteMessage(data?.booking_quote_message ?? '');
    setConfirmMessage(data?.booking_confirm_message ?? '');
    setLoading(false);
  };

  const handleSave = async () => {
    if (!settingsId) return;
    setSaving(true);
    try {
      await supabase
        .from('settings')
        .update({
          booking_trigger_keywords: bookingTriggerKeywords,
          quote_sheet_id: quoteSheetId,
          quote_sheet_gid: quoteSheetGid,
          booking_welcome_message: welcomeMessage,
          booking_quote_message: quoteMessage,
          booking_confirm_message: confirmMessage,
        })
        .eq('id', settingsId);
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-wrap justify-between items-start gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
            <Workflow className="w-6 h-6 text-blue-600" />
            流程設定
          </h2>
          <p className="text-gray-500 mt-1">控制 LINE 訂房對話流程的觸發條件、資料寫入的試算表，以及三段可自訂罐頭訊息。</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
        >
          <Save className="w-4 h-4" />
          {saving ? '儲存中...' : '儲存變更'}
        </button>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6">
          <p className="text-sm font-medium text-gray-700 mb-1">觸發關鍵字</p>
          <p className="text-xs text-gray-400 mb-3">
            顧客訊息包含這些關鍵字（逗號分隔）就會開始追蹤訂房詢問狀態，接著送出下方「歡迎詢問」罐頭訊息，
            等顧客填完資料後用程式碼確定性計算晚數與金額（不會交給 AI 自由計算）。
          </p>
          <input
            value={bookingTriggerKeywords}
            onChange={(e) => setBookingTriggerKeywords(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg"
            placeholder="我要訂房,訂房"
          />
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6">
          <h3 className="text-lg font-bold text-gray-800 flex items-center gap-2 mb-1">
            <FileSpreadsheet className="w-5 h-5 text-green-600" />
            「報價」試算表
          </h3>
          <p className="text-xs text-gray-400 mb-3">
            分三個階段自動寫入、更新<strong>同一列</strong>（不會拆成好幾筆）：① 顧客一開始傳觸發關鍵字，先記錄 LINE_USER_ID、LINE_NAME（LINE 暱稱）；
            ② 顧客填完資料、算完報價，補上訂房姓名、入住/退房日期、入住天數、人數、大人小孩、是否包棟、總金額；
            ③ 顧客回「是」確認，補上預定日期（今天）。
            欄位一律照試算表第一列（標題列）的名稱比對寫入，之後想加減欄位、調順序都不會壞掉；<strong>訂金欄位由您自己填寫或用公式從總金額算出</strong>，
            系統不會自動填，顧客回「是」的當下會重新讀一次那一列把訂金帶進付款確認訊息。<br />
            <strong>注意：</strong>這份試算表要分享給服務帳號（跟知識庫共用同一組），且權限要設為「編輯者」而不是「檢視者」，否則系統無法寫入。
          </p>
          <div className="flex flex-wrap gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">試算表 ID</label>
              <input
                value={quoteSheetId}
                onChange={(e) => setQuoteSheetId(e.target.value)}
                className="w-80 px-3 py-2 border rounded-lg"
                placeholder="Google 試算表網址中 /d/ 後面那一段"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">工作表 GID</label>
              <input
                value={quoteSheetGid}
                onChange={(e) => setQuoteSheetGid(e.target.value)}
                className="w-28 px-3 py-2 border rounded-lg"
                placeholder="0"
              />
            </div>
          </div>
        </div>
      </div>

      <CollapsibleSection
        title="罐頭訊息設定"
        icon={<MessageSquareText className="w-5 h-5 text-orange-600" />}
        description="三段訊息都可以自訂文字，方括號 [欄位名稱] 是合併欄位，可以點下方按鈕快速插入，也可以直接在文字裡手打。"
        defaultOpen={true}
      >
        <div className="p-6 border-b">
          <p className="text-sm font-medium text-gray-700 mb-1">① 歡迎詢問（觸發關鍵字後第一句回覆）</p>
          <p className="text-xs text-gray-400 mb-2">這段沒有合併欄位，顧客還沒提供任何資料，純粹是請他們照格式回覆。</p>
          <MessageTemplateEditor value={welcomeMessage} onChange={setWelcomeMessage} placeholders={[]} rows={10} />
        </div>

        <div className="p-6 border-b">
          <p className="text-sm font-medium text-gray-700 mb-1">② 報價確認（顧客填完資料、算完金額後）</p>
          <p className="text-xs text-gray-400 mb-2">送出後會等顧客回覆「是」或「否」。</p>
          <MessageTemplateEditor value={quoteMessage} onChange={setQuoteMessage} placeholders={QUOTE_MESSAGE_PLACEHOLDERS} rows={10} />
        </div>

        <div className="p-6">
          <p className="text-sm font-medium text-gray-700 mb-1">③ 付款確認（顧客回「是」之後）</p>
          <p className="text-xs text-gray-400 mb-2">
            [訂金] 讀自「報價」試算表那一列（顧客回「是」的當下重新讀一次，讓您有時間先在表格裡填好或用公式算好）；
            [匯款日時間] 由系統自動算：目前時間 18:00 前帶入今天 21:00，18:00（含）以後帶入明天 21:00。
          </p>
          <MessageTemplateEditor value={confirmMessage} onChange={setConfirmMessage} placeholders={CONFIRM_MESSAGE_PLACEHOLDERS} rows={14} />
        </div>
      </CollapsibleSection>
    </div>
  );
}

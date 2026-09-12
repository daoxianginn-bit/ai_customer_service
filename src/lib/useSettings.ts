import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from './supabase';
import { logOperation, logUiError } from './logOperation';
import { LOG_FEATURES, diffRecords } from './operationLog';

// ========================================================================
// settings 表（單列）的讀寫。所有設定頁共用：民宿基本資料、AI 引擎、訂房規則、客服規則、
// Google 行事曆、安全性。
//
// dirty：目前值跟上次載入／儲存的快照有沒有差異，設定頁靠它顯示「尚有未儲存變更」與
// 儲存列。判斷方式是深度比較，「改了又改回去」不算有變更。
// handleSave 不再自己跳 alert：回傳結果讓頁面用 snackbar 呈現，避免每頁一種回饋方式。
// ========================================================================

function stableStringify(value: any): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v
  );
}

export function useSettings() {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 上一次從資料庫載入／儲存的內容：儲存時比對出改了哪些欄位寫進操作紀錄，也用來判斷 dirty
  const [snapshot, setSnapshot] = useState<any>(null);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      setSettings(data);
      setSnapshot(data);
    } catch (error: any) {
      console.error('Error fetching settings:', error);
      setLoadError(error?.message || '無法取得設定');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const dirty = useMemo(() => !!settings && !!snapshot && stableStringify(settings) !== stableStringify(snapshot), [settings, snapshot]);

  // 直接關分頁／重新整理時由瀏覽器跳原生確認（§82）
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function handleSave(): Promise<{ ok: true } | { ok: false; error: string }> {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('settings')
        .update({ ...settings, updated_at: new Date().toISOString() })
        .eq('id', settings.id);
      if (error) throw error;

      // 只比對真的有變的欄位。updated_at 每次都不一樣，列進去每一筆紀錄都會多一行雜訊。
      const diff = diffRecords(snapshot, settings, Object.keys(settings).filter((k) => k !== 'id' && k !== 'updated_at' && k !== 'created_at'));
      if (diff.changed) {
        await logOperation({ feature: LOG_FEATURES.systemSettings, action: '修改', target: null, before: diff.before, after: diff.after });
      }
      setSnapshot(settings);
      return { ok: true };
    } catch (error: any) {
      console.error('Error saving settings:', error);
      await logUiError({ feature: LOG_FEATURES.systemSettings, action: '儲存失敗', error });
      return { ok: false, error: error?.message || '未知錯誤' };
    } finally {
      setSaving(false);
    }
  }

  /** 放棄變更：回到上次載入／儲存的內容 */
  const discard = useCallback(() => { if (snapshot) setSettings(snapshot); }, [snapshot]);

  function handleChange(e: any) {
    const { name, value, type, checked } = e.target;
    setSettings((prev: any) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
  }

  /** 直接設一個欄位（MUI Switch／Select 等不方便用 event 的情況） */
  const setField = useCallback((name: string, value: unknown) => {
    setSettings((prev: any) => ({ ...prev, [name]: value }));
  }, []);

  return { settings, setSettings, setField, loading, loadError, saving, dirty, handleSave, discard, handleChange, refetch: fetchSettings };
}

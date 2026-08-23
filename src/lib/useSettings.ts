import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { logOperation } from './logOperation';
import { LOG_FEATURES, diffRecords } from './operationLog';

export function useSettings() {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 上一次從資料庫載入的內容，儲存時比對出這次改了哪些欄位寫進操作紀錄。
  const [snapshot, setSnapshot] = useState<any>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    setLoading(true);
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      setSettings(data);
      setSnapshot(data);
    } catch (error) {
      console.error('Error fetching settings:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const { error } = await supabase
        .from('settings')
        .update({ ...settings, updated_at: new Date().toISOString() })
        .eq('id', settings.id);

      if (error) throw error;

      // 只比對真的有變的欄位。updated_at 每次都不一樣，列進去的話每一筆紀錄都會多一行雜訊。
      const diff = diffRecords(snapshot, settings, Object.keys(settings).filter((k) => k !== 'id' && k !== 'updated_at' && k !== 'created_at'));
      if (diff.changed) {
        await logOperation({
          feature: LOG_FEATURES.systemSettings,
          action: '修改',
          target: null,
          before: diff.before,
          after: diff.after,
        });
      }
      setSnapshot(settings);
      alert('設定已儲存！');
    } catch (error: any) {
      console.error('Error saving settings:', error);
      alert(`儲存失敗：${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  function handleChange(e: any) {
    const { name, value, type, checked } = e.target;
    setSettings((prev: any) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  }

  return { settings, setSettings, loading, saving, handleSave, handleChange, refetch: fetchSettings };
}

import { useEffect, useState } from 'react';
import { supabase } from './supabase';

export function useSettings() {
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    setLoading(true);
    try {
      const { data, error } = await supabase.from('settings').select('*').single();
      if (error) throw error;
      setSettings(data);
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

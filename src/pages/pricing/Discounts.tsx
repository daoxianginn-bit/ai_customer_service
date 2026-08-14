import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import { Percent, Save, Plus, Trash2, Info } from 'lucide-react';
import { PageHeader, Button } from '../../components/ui';

function newId(): string {
  return crypto.randomUUID();
}

function InfoTooltip({ children }: { children: React.ReactNode }) {
  return (
    <span className="group relative inline-flex">
      <Info className="w-3.5 h-3.5 text-gray-400 cursor-help" />
      <span className="hidden group-hover:block absolute z-20 left-0 top-5 w-72 bg-gray-800 text-white text-xs rounded-lg p-3 shadow-lg leading-relaxed">
        {children}
      </span>
    </span>
  );
}

export default function Discounts() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [activePromotionId, setActivePromotionId] = useState<string>('');
  const [promotions, setPromotions] = useState<any[]>([]);
  const [discountCleaning, setDiscountCleaning] = useState(0);
  const [discountNoCleaning, setDiscountNoCleaning] = useState(0);
  const [consecutiveStayDefaultOption, setConsecutiveStayDefaultOption] = useState<'cleaning' | 'no_cleaning'>('no_cleaning');
  const [specialPriceStacksWithDiscounts, setSpecialPriceStacksWithDiscounts] = useState(true);
  const [depositPercent, setDepositPercent] = useState(30);
  // LINE 自動報價已經不分個別租房/包棟，這個欄位現在只給「訂單管理」手動建單勾選「包棟」時的
  // 押金預設值用（人工建單仍保留這個獨立分類，跟自動報價公式無關）。
  const [wholeHouseSecurityDeposit, setWholeHouseSecurityDeposit] = useState(3000);
  const [pendingDeletes, setPendingDeletes] = useState<{ table: string; id: string }[]>([]);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [st, promo] = await Promise.all([
      supabase
        .from('settings')
        .select(
          'id, consecutive_stay_discount_cleaning, consecutive_stay_discount_no_cleaning, consecutive_stay_default_option, active_promotion_id, deposit_percent, whole_house_security_deposit, special_price_stacks_with_discounts'
        )
        .single(),
      supabase.from('promotions').select('*').order('created_at'),
    ]);
    setSettingsId(st.data?.id || null);
    setDiscountCleaning(st.data?.consecutive_stay_discount_cleaning ?? 0);
    setDiscountNoCleaning(st.data?.consecutive_stay_discount_no_cleaning ?? 0);
    setConsecutiveStayDefaultOption(st.data?.consecutive_stay_default_option ?? 'no_cleaning');
    setActivePromotionId(st.data?.active_promotion_id ?? '');
    setDepositPercent(st.data?.deposit_percent ?? 30);
    setWholeHouseSecurityDeposit(st.data?.whole_house_security_deposit ?? 3000);
    setSpecialPriceStacksWithDiscounts(st.data?.special_price_stacks_with_discounts ?? true);
    setPromotions(promo.data || []);
    setPendingDeletes([]);
    setLoading(false);
  };

  const queueDelete = (table: string, id: string) => setPendingDeletes((prev) => [...prev, { table, id }]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (settingsId) {
        await supabase
          .from('settings')
          .update({
            consecutive_stay_discount_cleaning: discountCleaning,
            consecutive_stay_discount_no_cleaning: discountNoCleaning,
            consecutive_stay_default_option: consecutiveStayDefaultOption,
            active_promotion_id: activePromotionId || null,
            deposit_percent: depositPercent,
            whole_house_security_deposit: wholeHouseSecurityDeposit,
            special_price_stacks_with_discounts: specialPriceStacksWithDiscounts,
          })
          .eq('id', settingsId);
      }
      if (promotions.length) await supabase.from('promotions').upsert(promotions);
      for (const del of pendingDeletes) {
        await supabase.from(del.table).delete().eq('id', del.id);
      }
      await fetchAll();
      alert('已儲存！');
    } catch (err: any) {
      alert(`儲存失敗：${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const addPromotion = () => {
    setPromotions([...promotions, { id: newId(), name: '新促銷方案', discount_type: 'percent', discount_percent: 0, discount_amount: 0 }]);
  };

  const updatePromotion = (id: string, field: string, value: any) => {
    setPromotions(promotions.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const deletePromotion = (id: string) => {
    setPromotions(promotions.filter((p) => p.id !== id));
    if (activePromotionId === id) setActivePromotionId('');
    queueDelete('promotions', id);
  };

  if (loading) return <div className="p-8 text-center text-gray-500">載入中...</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <PageHeader
        icon={<Percent className="w-6 h-6 text-amber-600" />}
        title="促銷與折扣"
        description="促銷方案、連住折扣、押金與訂金比例，LINE 自動報價會照這裡的設定套用。"
        action={
          <Button onClick={handleSave} loading={saving} icon={<Save className="w-4 h-4" />}>
            {saving ? '儲存中...' : '儲存變更'}
          </Button>
        }
      />

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="p-6 border-b bg-amber-50">
          <label className="block text-sm font-medium text-gray-700 mb-1">LINE 對話流程目前套用的促銷方案</label>
          <p className="text-xs text-gray-500 mb-2">
            顧客在 LINE 上聊天訂房會自動套用這裡選定的方案，不用顧客自己提、也不會另外詢問。選「無」就跟現在一樣不打折。
            跟「試算報價」選同一個方案時，算出來的金額會完全一致。
          </p>
          <select value={activePromotionId} onChange={(e) => setActivePromotionId(e.target.value)} className="px-3 py-2 border rounded-lg bg-white">
            <option value="">無（不套用促銷）</option>
            {promotions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.discount_type === 'amount' ? `${p.name}（折抵 NT$${(p.discount_amount || 0).toLocaleString()}）` : `${p.name}（${p.discount_percent}%）`}
              </option>
            ))}
          </select>
        </div>

        <div className="p-6 border-b">
          <div className="flex justify-between items-center mb-3">
            <p className="text-sm font-medium text-gray-700">促銷方案清單（名稱 + 打折%／固定金額折抵，只套用在第一晚）</p>
            <button onClick={addPromotion} className="flex items-center gap-1 bg-gray-700 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-gray-800">
              <Plus className="w-4 h-4" /> 新增方案
            </button>
          </div>
          <div className="space-y-2">
            {promotions.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <input value={p.name} onChange={(e) => updatePromotion(p.id, 'name', e.target.value)} className="flex-1 px-2 py-1 border rounded" placeholder="促銷方案名稱" />
                <select value={p.discount_type || 'percent'} onChange={(e) => updatePromotion(p.id, 'discount_type', e.target.value)} className="px-2 py-1 border rounded bg-white">
                  <option value="percent">打折%</option>
                  <option value="amount">固定金額</option>
                </select>
                {p.discount_type === 'amount' ? (
                  <>
                    <input type="number" value={p.discount_amount ?? 0} onChange={(e) => updatePromotion(p.id, 'discount_amount', Number(e.target.value))} className="w-24 px-2 py-1 border rounded" />
                    <span className="text-xs text-gray-400">元折抵</span>
                  </>
                ) : (
                  <>
                    <input type="number" value={p.discount_percent} onChange={(e) => updatePromotion(p.id, 'discount_percent', Number(e.target.value))} className="w-20 px-2 py-1 border rounded" />
                    <span className="text-xs text-gray-400">% 折扣</span>
                  </>
                )}
                <button onClick={() => deletePromotion(p.id)} className="p-1.5 text-red-500 hover:bg-red-50 rounded">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            {promotions.length === 0 && <p className="text-sm text-gray-400">尚未設定促銷方案</p>}
          </div>
        </div>

        <div className="p-6 border-b">
          <p className="text-sm font-medium text-gray-700 mb-3">連住折扣（固定金額，第二晚（含）以後每晚折抵）</p>
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">需打掃，每晚折抵</label>
              <input type="number" value={discountCleaning} onChange={(e) => setDiscountCleaning(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">無需打掃，每晚折抵</label>
              <input type="number" value={discountNoCleaning} onChange={(e) => setDiscountNoCleaning(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">LINE 自動報價套用哪一種</label>
              <select value={consecutiveStayDefaultOption} onChange={(e) => setConsecutiveStayDefaultOption(e.target.value as 'cleaning' | 'no_cleaning')} className="px-3 py-2 border rounded-lg bg-white">
                <option value="no_cleaning">無需打掃</option>
                <option value="cleaning">需打掃</option>
              </select>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">連住折扣是民宿自訂政策、不是詢問顧客的選項，LINE 對話流程會自動套用這裡選的類型，不會另外問顧客。</p>
        </div>

        <div className="p-6 border-b">
          <p className="text-sm font-medium text-gray-700 mb-1">特殊日期價格遇到促銷/連住折扣</p>
          <p className="text-xs text-gray-500 mb-3">「特殊日期價格」頁設定的日期命中時，促銷跟連住折扣要不要繼續套用在那晚上面。</p>
          <div className="space-y-2">
            <label className={`flex items-start gap-2 p-3 border rounded-lg cursor-pointer ${specialPriceStacksWithDiscounts === false ? 'border-green-400 bg-green-50' : 'border-gray-200'}`}>
              <input type="radio" checked={specialPriceStacksWithDiscounts === false} onChange={() => setSpecialPriceStacksWithDiscounts(false)} className="mt-0.5" />
              <span className="text-sm text-gray-700 flex items-center gap-1.5">
                特殊價格就是當晚最終金額
                <InfoTooltip>例：跨年夜設定特殊價 30000。就算這晚剛好是住宿第一晚（本來可套用促銷 9 折）或第三晚（本來可扣連住折扣 -1000），一律照樣收 30000，不會再打折或扣錢。</InfoTooltip>
              </span>
            </label>
            <label className={`flex items-start gap-2 p-3 border rounded-lg cursor-pointer ${specialPriceStacksWithDiscounts ? 'border-green-400 bg-green-50' : 'border-gray-200'}`}>
              <input type="radio" checked={specialPriceStacksWithDiscounts} onChange={() => setSpecialPriceStacksWithDiscounts(true)} className="mt-0.5" />
              <span className="text-sm text-gray-700 flex items-center gap-1.5">
                特殊價格只換掉基礎價
                <InfoTooltip>例：跨年夜特殊價 30000，剛好是住宿第一晚 → 系統還會再打促銷折扣，例如 9 折變 27000；或剛好是第三晚 → 還會再扣連住折扣，實收金額可能比設定的特殊價格低。</InfoTooltip>
              </span>
            </label>
          </div>
        </div>

        <div className="p-6">
          <p className="text-sm font-medium text-gray-700 mb-1">押金與訂金</p>
          <p className="text-xs text-gray-500 mb-3">
            訂單總額 ＝ 房價 ＋ 押金（開了哪幾間房，押金就是那幾間房押金的加總，請到「計價公式設定」頁調整各房型押金）；
            本次需匯訂金 ＝ <strong>房價</strong>的固定比例（不含押金）。LINE 自動報價會照這裡的設定算好，不需要人工填。
          </p>
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs text-gray-500 mb-1">訂金比例（房價的 %）</label>
              <input type="number" min={0} max={100} value={depositPercent} onChange={(e) => setDepositPercent(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
                包棟押金（人工建單用）
                <InfoTooltip>LINE 自動報價已經不分個別租房/包棟，這個金額只有「訂單管理」手動建單時勾選「包棟」才會拿來當押金預設值，跟自動報價公式無關。</InfoTooltip>
              </label>
              <input type="number" min={0} value={wholeHouseSecurityDeposit} onChange={(e) => setWholeHouseSecurityDeposit(Number(e.target.value))} className="w-32 px-3 py-2 border rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

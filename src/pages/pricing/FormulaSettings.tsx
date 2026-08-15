import { useState, useEffect, ReactNode } from 'react';
import { supabase } from '../../lib/supabase';
import {
  Box, Paper, Stack, Typography, Button, IconButton, TextField, MenuItem, Chip, Tooltip, Divider,
  Radio, RadioGroup, FormControlLabel, Table, TableHead, TableBody, TableRow, TableCell, TableContainer,
} from '@mui/material';
import { SlidersHorizontal, Pencil, Sparkles, Plus, Trash2, Info } from 'lucide-react';
import PageHeaderMui from '../../components/ui-mui/PageHeaderMui';
import SpecialDatesModal from '../../components/SpecialDatesModal';

function newId(): string {
  return crypto.randomUUID();
}

function promotionLabel(p: any): string {
  return p.discount_type === 'amount' ? `${p.name}（折抵 NT$${(p.discount_amount || 0).toLocaleString()}）` : `${p.name}（${p.discount_percent}%）`;
}

function InfoHint({ text }: { text: string }) {
  return (
    <Tooltip title={text} arrow placement="top">
      <Info size={13} style={{ color: '#9ca3af', cursor: 'help' }} />
    </Tooltip>
  );
}

// 每個「唯讀/編輯」區塊共用的卡片外殼：唯讀模式顯示摘要＋右上角「編輯」，
// 編輯模式顯示表單＋「取消」「儲存」，取消/儲存都由呼叫端決定行為（取消＝重新抓資料，儲存＝只送出這個區塊的欄位）。
function EditableCard({
  title, tooltip, editing, saving, onEdit, onCancel, onSave, view, edit,
}: {
  title: string;
  tooltip?: string;
  editing: boolean;
  saving: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  view: ReactNode;
  edit: ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 3, height: '100%' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
        <Stack direction="row" alignItems="center" spacing={0.75}>
          <Typography fontWeight={600}>{title}</Typography>
          {tooltip && <InfoHint text={tooltip} />}
        </Stack>
        {!editing ? (
          <Button size="small" startIcon={<Pencil size={14} />} onClick={onEdit}>編輯</Button>
        ) : (
          <Stack direction="row" spacing={1}>
            <Button size="small" onClick={onCancel}>取消</Button>
            <Button size="small" variant="contained" onClick={onSave} disabled={saving}>{saving ? '儲存中...' : '儲存'}</Button>
          </Stack>
        )}
      </Stack>
      {editing ? edit : view}
    </Paper>
  );
}

export default function FormulaSettings() {
  const [loading, setLoading] = useState(true);
  const [settingsId, setSettingsId] = useState<string | null>(null);

  // 基礎公式
  const [bedBaseRate, setBedBaseRate] = useState(1000);
  const [fullOccupancyBonus, setFullOccupancyBonus] = useState(500);
  const [minGroupHeadcount, setMinGroupHeadcount] = useState(1);
  const [editingFormula, setEditingFormula] = useState(false);
  const [savingFormula, setSavingFormula] = useState(false);

  // 日期加價
  const [dateSurchargeSmall, setDateSurchargeSmall] = useState(5000);
  const [dateSurchargePeak, setDateSurchargePeak] = useState(8000);
  const [dateSurchargeHoliday, setDateSurchargeHoliday] = useState(12000);
  const [editingDateSurcharge, setEditingDateSurcharge] = useState(false);
  const [savingDateSurcharge, setSavingDateSurcharge] = useState(false);

  // 各容量加開房費
  const [capacityFees, setCapacityFees] = useState<{ capacity: number; extra_room_fee: number }[]>([]);
  const [editingCapacityFees, setEditingCapacityFees] = useState(false);
  const [savingCapacityFees, setSavingCapacityFees] = useState(false);

  // 特殊日期價格（不鎖，改成彈窗）
  const [specialPriceCount, setSpecialPriceCount] = useState(0);
  const [specialDatesModalOpen, setSpecialDatesModalOpen] = useState(false);

  // 房型押金
  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [editingDeposits, setEditingDeposits] = useState(false);
  const [savingDeposits, setSavingDeposits] = useState(false);

  // 連住折扣
  const [discountCleaning, setDiscountCleaning] = useState(0);
  const [discountNoCleaning, setDiscountNoCleaning] = useState(0);
  const [consecutiveStayDefaultOption, setConsecutiveStayDefaultOption] = useState<'cleaning' | 'no_cleaning'>('no_cleaning');
  const [editingConsecutive, setEditingConsecutive] = useState(false);
  const [savingConsecutive, setSavingConsecutive] = useState(false);

  // 押金與訂金
  const [depositPercent, setDepositPercent] = useState(30);
  const [wholeHouseSecurityDeposit, setWholeHouseSecurityDeposit] = useState(3000);
  const [editingDepositSettings, setEditingDepositSettings] = useState(false);
  const [savingDepositSettings, setSavingDepositSettings] = useState(false);

  // 促銷方案（不鎖，永遠可編輯）
  const [activePromotionId, setActivePromotionId] = useState('');
  const [promotions, setPromotions] = useState<any[]>([]);
  const [specialPriceStacksWithDiscounts, setSpecialPriceStacksWithDiscounts] = useState(true);
  const [savingPromotions, setSavingPromotions] = useState(false);
  const [pendingPromotionDeletes, setPendingPromotionDeletes] = useState<{ table: string; id: string }[]>([]);

  useEffect(() => {
    fetchAll();
  }, []);

  // silent=true 給「取消」「儲存後刷新」用，不會讓整頁閃一次「載入中」。
  const fetchAll = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    const [st, rt, cap, promo, sp] = await Promise.all([
      supabase
        .from('settings')
        .select(
          'id, bed_base_rate, full_occupancy_bonus, min_group_headcount, date_surcharge_small_holiday, date_surcharge_peak, date_surcharge_long_holiday, consecutive_stay_discount_cleaning, consecutive_stay_discount_no_cleaning, consecutive_stay_default_option, deposit_percent, whole_house_security_deposit, special_price_stacks_with_discounts, active_promotion_id'
        )
        .single(),
      supabase.from('room_types').select('*').eq('type', '房間').order('display_order'),
      supabase.from('room_capacity_pricing').select('*'),
      supabase.from('promotions').select('*').order('created_at'),
      supabase.from('special_prices').select('*', { count: 'exact', head: true }),
    ]);
    setSettingsId(st.data?.id || null);
    setBedBaseRate(st.data?.bed_base_rate ?? 1000);
    setFullOccupancyBonus(st.data?.full_occupancy_bonus ?? 500);
    setMinGroupHeadcount(st.data?.min_group_headcount ?? 1);
    setDateSurchargeSmall(st.data?.date_surcharge_small_holiday ?? 5000);
    setDateSurchargePeak(st.data?.date_surcharge_peak ?? 8000);
    setDateSurchargeHoliday(st.data?.date_surcharge_long_holiday ?? 12000);
    setDiscountCleaning(st.data?.consecutive_stay_discount_cleaning ?? 0);
    setDiscountNoCleaning(st.data?.consecutive_stay_discount_no_cleaning ?? 0);
    setConsecutiveStayDefaultOption(st.data?.consecutive_stay_default_option ?? 'no_cleaning');
    setDepositPercent(st.data?.deposit_percent ?? 30);
    setWholeHouseSecurityDeposit(st.data?.whole_house_security_deposit ?? 3000);
    setSpecialPriceStacksWithDiscounts(st.data?.special_price_stacks_with_discounts ?? true);
    setActivePromotionId(st.data?.active_promotion_id ?? '');
    const roomTypeRows = rt.data || [];
    setRoomTypes(roomTypeRows);
    const distinctCaps = Array.from(new Set(roomTypeRows.filter((r: any) => r.is_active !== false).map((r: any) => r.capacity))).filter(
      (c): c is number => typeof c === 'number' && c > 0
    );
    const existingCap = cap.data || [];
    setCapacityFees(distinctCaps.map((c) => existingCap.find((e: any) => e.capacity === c) || { capacity: c, extra_room_fee: 0 }));
    setPromotions(promo.data || []);
    setSpecialPriceCount(sp.count ?? 0);
    setPendingPromotionDeletes([]);
    if (!opts?.silent) setLoading(false);
  };

  const getCapacityFee = (capacity: number): number => capacityFees.find((c) => c.capacity === capacity)?.extra_room_fee ?? 0;
  const updateCapacityFee = (capacity: number, value: string) => {
    const fee = value === '' ? 0 : Number(value);
    setCapacityFees(capacityFees.map((c) => (c.capacity === capacity ? { ...c, extra_room_fee: fee } : c)));
  };
  const updateRoomType = (id: string, field: string, value: any) => {
    setRoomTypes(roomTypes.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };
  const distinctCapacities = Array.from(new Set(roomTypes.filter((r) => r.is_active !== false).map((r) => r.capacity)))
    .filter((c): c is number => typeof c === 'number' && c > 0)
    .sort((a, b) => a - b);

  // ---------------- 各區塊儲存 ----------------
  const handleSaveFormula = async () => {
    setSavingFormula(true);
    try {
      if (settingsId) await supabase.from('settings').update({ bed_base_rate: bedBaseRate, full_occupancy_bonus: fullOccupancyBonus, min_group_headcount: minGroupHeadcount }).eq('id', settingsId);
      await fetchAll({ silent: true });
      setEditingFormula(false);
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingFormula(false);
    }
  };
  const handleCancelFormula = async () => { await fetchAll({ silent: true }); setEditingFormula(false); };

  const handleSaveDateSurcharge = async () => {
    setSavingDateSurcharge(true);
    try {
      if (settingsId) await supabase.from('settings').update({ date_surcharge_small_holiday: dateSurchargeSmall, date_surcharge_peak: dateSurchargePeak, date_surcharge_long_holiday: dateSurchargeHoliday }).eq('id', settingsId);
      await fetchAll({ silent: true });
      setEditingDateSurcharge(false);
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingDateSurcharge(false);
    }
  };
  const handleCancelDateSurcharge = async () => { await fetchAll({ silent: true }); setEditingDateSurcharge(false); };

  const handleSaveCapacityFees = async () => {
    setSavingCapacityFees(true);
    try {
      if (capacityFees.length) await supabase.from('room_capacity_pricing').upsert(capacityFees);
      await fetchAll({ silent: true });
      setEditingCapacityFees(false);
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingCapacityFees(false);
    }
  };
  const handleCancelCapacityFees = async () => { await fetchAll({ silent: true }); setEditingCapacityFees(false); };

  const handleSaveDeposits = async () => {
    setSavingDeposits(true);
    try {
      if (roomTypes.length) await supabase.from('room_types').upsert(roomTypes);
      await fetchAll({ silent: true });
      setEditingDeposits(false);
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingDeposits(false);
    }
  };
  const handleCancelDeposits = async () => { await fetchAll({ silent: true }); setEditingDeposits(false); };

  const handleSaveConsecutive = async () => {
    setSavingConsecutive(true);
    try {
      if (settingsId) await supabase.from('settings').update({ consecutive_stay_discount_cleaning: discountCleaning, consecutive_stay_discount_no_cleaning: discountNoCleaning, consecutive_stay_default_option: consecutiveStayDefaultOption }).eq('id', settingsId);
      await fetchAll({ silent: true });
      setEditingConsecutive(false);
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingConsecutive(false);
    }
  };
  const handleCancelConsecutive = async () => { await fetchAll({ silent: true }); setEditingConsecutive(false); };

  const handleSaveDepositSettings = async () => {
    setSavingDepositSettings(true);
    try {
      if (settingsId) await supabase.from('settings').update({ deposit_percent: depositPercent, whole_house_security_deposit: wholeHouseSecurityDeposit }).eq('id', settingsId);
      await fetchAll({ silent: true });
      setEditingDepositSettings(false);
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingDepositSettings(false);
    }
  };
  const handleCancelDepositSettings = async () => { await fetchAll({ silent: true }); setEditingDepositSettings(false); };

  const queuePromotionDelete = (table: string, id: string) => setPendingPromotionDeletes((prev) => [...prev, { table, id }]);
  const addPromotion = () => setPromotions([...promotions, { id: newId(), name: '新促銷方案', discount_type: 'percent', discount_percent: 0, discount_amount: 0 }]);
  const updatePromotion = (id: string, field: string, value: any) => setPromotions(promotions.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  const deletePromotion = (id: string) => {
    setPromotions(promotions.filter((p) => p.id !== id));
    if (activePromotionId === id) setActivePromotionId('');
    queuePromotionDelete('promotions', id);
  };

  const handleSavePromotions = async () => {
    setSavingPromotions(true);
    try {
      if (settingsId) await supabase.from('settings').update({ active_promotion_id: activePromotionId || null, special_price_stacks_with_discounts: specialPriceStacksWithDiscounts }).eq('id', settingsId);
      if (promotions.length) await supabase.from('promotions').upsert(promotions);
      for (const del of pendingPromotionDeletes) await supabase.from(del.table).delete().eq('id', del.id);
      await fetchAll({ silent: true });
    } catch (e: any) {
      alert(`儲存失敗：${e.message}`);
    } finally {
      setSavingPromotions(false);
    }
  };

  if (loading) return <Box sx={{ p: 8, textAlign: 'center', color: 'text.secondary' }}>載入中...</Box>;

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <PageHeaderMui
        icon={<SlidersHorizontal size={26} color="#16a34a" />}
        title="計價公式設定"
        description="所有人數統一用這套公式自動報價：標準房型（依人數湊出的床位數）× 每床基礎價 ＋ 滿載獎勵 ＋ 加開房費 ＋ 日期加價。每個區塊預設唯讀，點「編輯」才能修改，各自獨立儲存。房型基本資料（名稱/樓層/容納人數）請到「房型與空間維護」調整。"
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, alignItems: 'stretch' }}>
        <EditableCard
          title="基礎公式"
          editing={editingFormula}
          saving={savingFormula}
          onEdit={() => setEditingFormula(true)}
          onCancel={handleCancelFormula}
          onSave={handleSaveFormula}
          view={
            <Typography variant="body2" color="text.secondary">
              每床基礎價 <strong>NT$ {bedBaseRate.toLocaleString()}</strong>　滿載獎勵 <strong>NT$ {fullOccupancyBonus.toLocaleString()}</strong>　最少接待人數 <strong>{minGroupHeadcount} 人</strong>
            </Typography>
          }
          edit={
            <Stack direction="row" flexWrap="wrap" gap={2}>
              <TextField label="每床基礎價" type="number" size="small" value={bedBaseRate} onChange={(e) => setBedBaseRate(Number(e.target.value))} sx={{ width: 140 }} />
              <TextField label="滿載獎勵" type="number" size="small" value={fullOccupancyBonus} onChange={(e) => setFullOccupancyBonus(Number(e.target.value))} sx={{ width: 140 }}
                InputProps={{ endAdornment: <InfoHint text="人數剛好等於標準房型的床位數（沒有空床）才加這筆獎勵金。人數是奇數時一定會有 1 床空著，不會拿到這筆獎勵。" /> }} />
              <TextField label="最少接待人數" type="number" size="small" value={minGroupHeadcount} onChange={(e) => setMinGroupHeadcount(Number(e.target.value))} sx={{ width: 140 }}
                InputProps={{ endAdornment: <InfoHint text="低於這個人數，LINE 對話流程不會自動報價，會請客人改由真人客服處理。" /> }} />
            </Stack>
          }
        />

        <EditableCard
          title="各容量加開房費"
          tooltip="客人指定的房型組合跟系統算出的「標準房型」不同時，減少的房型間數先抵掉增加的房型間數（不分容量，1 間抵 1 間），抵完剩下的增加間數，才照這裡各自的費率收費加總。"
          editing={editingCapacityFees}
          saving={savingCapacityFees}
          onEdit={() => setEditingCapacityFees(true)}
          onCancel={handleCancelCapacityFees}
          onSave={handleSaveCapacityFees}
          view={
            distinctCapacities.length === 0 ? (
              <Typography variant="body2" color="text.disabled">尚未在「房型與空間維護」設定任何啟用中的房間</Typography>
            ) : (
              <Stack direction="row" flexWrap="wrap" gap={1}>
                {distinctCapacities.map((cap) => (
                  <Chip key={cap} label={`${cap}人房 +NT$${getCapacityFee(cap).toLocaleString()}`} size="small" variant="outlined" />
                ))}
              </Stack>
            )
          }
          edit={
            <Stack direction="row" flexWrap="wrap" gap={2}>
              {distinctCapacities.map((cap) => (
                <TextField key={cap} label={`${cap} 人房`} type="number" size="small" value={getCapacityFee(cap)} onChange={(e) => updateCapacityFee(cap, e.target.value)} sx={{ width: 120 }} />
              ))}
            </Stack>
          }
        />

        <EditableCard
          title="日期加價"
          editing={editingDateSurcharge}
          saving={savingDateSurcharge}
          onEdit={() => setEditingDateSurcharge(true)}
          onCancel={handleCancelDateSurcharge}
          onSave={handleSaveDateSurcharge}
          view={
            <Typography variant="body2" color="text.secondary">
              平日 +0　小假日 <strong>+{dateSurchargeSmall.toLocaleString()}</strong>　連假 <strong>+{dateSurchargeHoliday.toLocaleString()}</strong>　旺季 <strong>+{dateSurchargePeak.toLocaleString()}</strong>
            </Typography>
          }
          edit={
            <Stack spacing={2}>
              <Stack direction="row" flexWrap="wrap" gap={2}>
                <TextField label="小假日 +" type="number" size="small" value={dateSurchargeSmall} onChange={(e) => setDateSurchargeSmall(Number(e.target.value))} sx={{ width: 140 }} />
                <TextField label="連假 +" type="number" size="small" value={dateSurchargeHoliday} onChange={(e) => setDateSurchargeHoliday(Number(e.target.value))} sx={{ width: 140 }} />
                <TextField label="旺季 +" type="number" size="small" value={dateSurchargePeak} onChange={(e) => setDateSurchargePeak(Number(e.target.value))} sx={{ width: 140 }} />
              </Stack>
              <Typography variant="caption" color="text.secondary">旺季／連假的日期區間，請到「行事曆」頁右上角「旺季/連假日期設定」調整。</Typography>
            </Stack>
          }
        />

        <Paper variant="outlined" sx={{ p: 3, height: '100%' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" flexWrap="wrap" gap={2}>
            <Box>
              <Typography fontWeight={600} sx={{ mb: 0.5 }}>特殊日期價格</Typography>
              <Typography variant="body2" color="text.secondary">
                目前共 <strong>{specialPriceCount}</strong> 筆設定。日期區間命中時直接用絕對金額當那一晚的最終基礎價，優先權最高，取代整段公式計算。
              </Typography>
            </Box>
            <Button variant="outlined" size="small" startIcon={<Sparkles size={14} />} onClick={() => setSpecialDatesModalOpen(true)}>
              管理特殊日期價格
            </Button>
          </Stack>
        </Paper>
      </Box>

      <EditableCard
        title="房型押金"
        editing={editingDeposits}
        saving={savingDeposits}
        onEdit={() => setEditingDeposits(true)}
        onCancel={handleCancelDeposits}
        onSave={handleSaveDeposits}
        view={
          roomTypes.length === 0 ? (
            <Typography variant="body2" color="text.disabled">尚未設定任何「房間」類型的資料，請先到「房型與空間維護」新增</Typography>
          ) : (
            <Stack direction="row" flexWrap="wrap" gap={1}>
              {roomTypes.map((r) => (
                <Chip key={r.id} label={`${r.floor ? `${r.floor}-` : ''}${r.name}　NT$${Number(r.security_deposit || 0).toLocaleString()}`} size="small" variant="outlined" />
              ))}
            </Stack>
          )
        }
        edit={
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>房型</TableCell>
                  <TableCell>押金</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {roomTypes.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.floor ? `${r.floor}-` : ''}{r.name}（{r.capacity}人）</TableCell>
                    <TableCell>
                      <TextField type="number" size="small" variant="standard" value={r.security_deposit ?? 0} onChange={(e) => updateRoomType(r.id, 'security_deposit', Number(e.target.value))} sx={{ width: 110 }} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        }
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, alignItems: 'stretch' }}>
        <EditableCard
          title="連住折扣"
          tooltip="連住折扣是民宿自訂政策、不是詢問顧客的選項，LINE 對話流程會自動套用這裡選的類型，不會另外問顧客。第二晚（含）以後每晚折抵固定金額。"
          editing={editingConsecutive}
          saving={savingConsecutive}
          onEdit={() => setEditingConsecutive(true)}
          onCancel={handleCancelConsecutive}
          onSave={handleSaveConsecutive}
          view={
            <Typography variant="body2" color="text.secondary">
              需打掃每晚折抵 <strong>NT$ {discountCleaning.toLocaleString()}</strong>　無需打掃每晚折抵 <strong>NT$ {discountNoCleaning.toLocaleString()}</strong>
              <br />LINE 自動報價套用：<strong>{consecutiveStayDefaultOption === 'cleaning' ? '需打掃' : '無需打掃'}</strong>
            </Typography>
          }
          edit={
            <Stack direction="row" flexWrap="wrap" gap={2}>
              <TextField label="需打掃，每晚折抵" type="number" size="small" value={discountCleaning} onChange={(e) => setDiscountCleaning(Number(e.target.value))} sx={{ width: 160 }} />
              <TextField label="無需打掃，每晚折抵" type="number" size="small" value={discountNoCleaning} onChange={(e) => setDiscountNoCleaning(Number(e.target.value))} sx={{ width: 160 }} />
              <TextField select label="LINE 自動報價套用哪一種" size="small" value={consecutiveStayDefaultOption} onChange={(e) => setConsecutiveStayDefaultOption(e.target.value as 'cleaning' | 'no_cleaning')} sx={{ width: 180 }}>
                <MenuItem value="no_cleaning">無需打掃</MenuItem>
                <MenuItem value="cleaning">需打掃</MenuItem>
              </TextField>
            </Stack>
          }
        />

        <EditableCard
          title="押金與訂金"
          tooltip="訂單總額 ＝ 房價 ＋ 押金（開了哪幾間房，押金就是那幾間房押金的加總，見上方「房型押金」）；本次需匯訂金 ＝ 房價的固定比例（不含押金）。"
          editing={editingDepositSettings}
          saving={savingDepositSettings}
          onEdit={() => setEditingDepositSettings(true)}
          onCancel={handleCancelDepositSettings}
          onSave={handleSaveDepositSettings}
          view={
            <Typography variant="body2" color="text.secondary">
              訂金比例 <strong>{depositPercent}%</strong>　包棟押金（人工建單用）<strong>NT$ {wholeHouseSecurityDeposit.toLocaleString()}</strong>
            </Typography>
          }
          edit={
            <Stack direction="row" flexWrap="wrap" gap={2}>
              <TextField label="訂金比例（房價的 %）" type="number" size="small" value={depositPercent} onChange={(e) => setDepositPercent(Number(e.target.value))} sx={{ width: 180 }} />
              <TextField label="包棟押金（人工建單用）" type="number" size="small" value={wholeHouseSecurityDeposit} onChange={(e) => setWholeHouseSecurityDeposit(Number(e.target.value))} sx={{ width: 200 }}
                InputProps={{ endAdornment: <InfoHint text="LINE 自動報價已經不分個別租房/包棟，這個金額只有「訂單管理」手動建單時勾選「包棟」才會拿來當押金預設值，跟自動報價公式無關。" /> }} />
            </Stack>
          }
        />
      </Box>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography fontWeight={600}>促銷方案</Typography>
          <Button size="small" variant="contained" onClick={handleSavePromotions} disabled={savingPromotions}>{savingPromotions ? '儲存中...' : '儲存'}</Button>
        </Stack>
        <Stack spacing={3}>
          <Box>
            <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>LINE 對話流程目前套用的促銷方案</Typography>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              顧客在 LINE 上聊天訂房會自動套用這裡選定的方案，不用顧客自己提、也不會另外詢問。選「無」就跟現在一樣不打折，跟「試算報價」選同一個方案時金額會完全一致。
            </Typography>
            <TextField select size="small" sx={{ minWidth: 240 }} value={activePromotionId} onChange={(e) => setActivePromotionId(e.target.value)}>
              <MenuItem value="">無（不套用促銷）</MenuItem>
              {promotions.map((p) => (
                <MenuItem key={p.id} value={p.id}>{promotionLabel(p)}</MenuItem>
              ))}
            </TextField>
          </Box>

          <Divider />

          <Box>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography variant="body2" fontWeight={500}>促銷方案清單（打折%／固定金額折抵，只套用在第一晚）</Typography>
              <Button size="small" startIcon={<Plus size={14} />} onClick={addPromotion}>新增方案</Button>
            </Stack>
            <Stack spacing={1}>
              {promotions.map((p) => (
                <Stack direction="row" spacing={1} alignItems="center" key={p.id}>
                  <TextField size="small" value={p.name} onChange={(e) => updatePromotion(p.id, 'name', e.target.value)} sx={{ flex: 1 }} placeholder="促銷方案名稱" />
                  <TextField select size="small" value={p.discount_type || 'percent'} onChange={(e) => updatePromotion(p.id, 'discount_type', e.target.value)} sx={{ width: 130 }}>
                    <MenuItem value="percent">打折%</MenuItem>
                    <MenuItem value="amount">固定金額</MenuItem>
                  </TextField>
                  {p.discount_type === 'amount' ? (
                    <TextField type="number" size="small" value={p.discount_amount ?? 0} onChange={(e) => updatePromotion(p.id, 'discount_amount', Number(e.target.value))} sx={{ width: 110 }} />
                  ) : (
                    <TextField type="number" size="small" value={p.discount_percent} onChange={(e) => updatePromotion(p.id, 'discount_percent', Number(e.target.value))} sx={{ width: 90 }} />
                  )}
                  <IconButton size="small" color="error" onClick={() => deletePromotion(p.id)}><Trash2 size={16} /></IconButton>
                </Stack>
              ))}
              {promotions.length === 0 && <Typography variant="body2" color="text.disabled">尚未設定促銷方案</Typography>}
            </Stack>
          </Box>

          <Divider />

          <Box>
            <Typography variant="body2" fontWeight={500} sx={{ mb: 0.5 }}>特殊日期價格遇到促銷/連住折扣</Typography>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>「特殊日期價格」設定的日期命中時，促銷跟連住折扣要不要繼續套用在那晚上面。</Typography>
            <RadioGroup value={specialPriceStacksWithDiscounts ? 'stack' : 'final'} onChange={(e) => setSpecialPriceStacksWithDiscounts(e.target.value === 'stack')}>
              <FormControlLabel value="final" control={<Radio size="small" />} label="特殊價格就是當晚最終金額（不再打折/扣連住折扣）" />
              <FormControlLabel value="stack" control={<Radio size="small" />} label="特殊價格只換掉基礎價（促銷/連住折扣照常套用）" />
            </RadioGroup>
          </Box>
        </Stack>
      </Paper>

      <SpecialDatesModal
        open={specialDatesModalOpen}
        onClose={() => setSpecialDatesModalOpen(false)}
        onSaved={() => fetchAll({ silent: true })}
      />
    </Box>
  );
}

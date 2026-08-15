import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { OCCUPYING_STATUSES } from '../../lib/bookingStatus';
import { Box, Paper, Stack, Typography, Chip, Divider, Table, TableHead, TableBody, TableRow, TableCell, TableContainer } from '@mui/material';
import { LayoutDashboard, DoorOpen, Sparkles, Percent, DollarSign, ArrowRight, Lightbulb, CalendarDays } from 'lucide-react';
import PageHeaderMui from '../../components/ui-mui/PageHeaderMui';
import StatCardMui from '../../components/ui-mui/StatCardMui';

function promotionLabel(p: any): string {
  return p.discount_type === 'amount' ? `${p.name}（折抵 NT$${(p.discount_amount || 0).toLocaleString()}）` : `${p.name}（${p.discount_percent}%）`;
}

const TIPS = [
  '每個設定分頁都是唯讀顯示，點「編輯」才能修改，各自獨立儲存，不會互相影響。',
  '特殊日期價格優先於一般日期加價設定，命中時會直接覆蓋整段計算。',
  '低於「最少接待人數」的詢問，LINE 對話流程會自動轉真人客服，不會自動報價。',
  '促銷方案同時間只會有一筆生效中（單選），不是多筆同時疊加。',
];

export default function PricingOverview() {
  const [loading, setLoading] = useState(true);

  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [bedBaseRate, setBedBaseRate] = useState(1000);
  const [fullOccupancyBonus, setFullOccupancyBonus] = useState(500);
  const [minGroupHeadcount, setMinGroupHeadcount] = useState(1);
  const [dateSurchargeSmall, setDateSurchargeSmall] = useState(5000);
  const [dateSurchargePeak, setDateSurchargePeak] = useState(8000);
  const [dateSurchargeHoliday, setDateSurchargeHoliday] = useState(12000);
  const [activePromotionId, setActivePromotionId] = useState('');

  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [capacityFees, setCapacityFees] = useState<{ capacity: number; extra_room_fee: number }[]>([]);
  const [promotions, setPromotions] = useState<any[]>([]);
  const [specialPriceCount, setSpecialPriceCount] = useState(0);
  const [monthRevenue, setMonthRevenue] = useState(0);

  useEffect(() => {
    fetchAll();
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthStart = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

    const [st, rt, cap, promo, sp, bk] = await Promise.all([
      supabase
        .from('settings')
        .select('id, bed_base_rate, full_occupancy_bonus, min_group_headcount, date_surcharge_small_holiday, date_surcharge_peak, date_surcharge_long_holiday, active_promotion_id')
        .single(),
      supabase.from('room_types').select('*').eq('type', '房間').order('display_order'),
      supabase.from('room_capacity_pricing').select('*'),
      supabase.from('promotions').select('*').order('created_at'),
      supabase.from('special_prices').select('*', { count: 'exact', head: true }),
      supabase
        .from('bookings')
        .select('room_amount, checkin_date, status')
        .gte('checkin_date', monthStart)
        .lt('checkin_date', nextMonthStart)
        .in('status', OCCUPYING_STATUSES),
    ]);

    setSettingsId(st.data?.id || null);
    setBedBaseRate(st.data?.bed_base_rate ?? 1000);
    setFullOccupancyBonus(st.data?.full_occupancy_bonus ?? 500);
    setMinGroupHeadcount(st.data?.min_group_headcount ?? 1);
    setDateSurchargeSmall(st.data?.date_surcharge_small_holiday ?? 5000);
    setDateSurchargePeak(st.data?.date_surcharge_peak ?? 8000);
    setDateSurchargeHoliday(st.data?.date_surcharge_long_holiday ?? 12000);
    setActivePromotionId(st.data?.active_promotion_id ?? '');
    setRoomTypes(rt.data || []);
    setCapacityFees((cap.data || []).map((c: any) => ({ capacity: c.capacity, extra_room_fee: c.extra_room_fee })));
    setPromotions(promo.data || []);
    setSpecialPriceCount(sp.count ?? 0);
    setMonthRevenue((bk.data || []).reduce((sum: number, b: any) => sum + Number(b.room_amount || 0), 0));
    setLoading(false);
  };

  // 促銷方案是單選、低風險、立即可逆的切換，點了就直接寫入，不用另外按儲存
  // （其餘會實際改動金額欄位的設定，一律只在「計價公式設定」的對應區塊編輯）。
  const selectActivePromotion = async (id: string) => {
    const next = activePromotionId === id ? '' : id;
    setActivePromotionId(next);
    if (settingsId) await supabase.from('settings').update({ active_promotion_id: next || null }).eq('id', settingsId);
  };

  const activeRoomCount = roomTypes.filter((r) => r.is_active !== false).length;

  if (loading) return <Box sx={{ p: 8, textAlign: 'center', color: 'text.secondary' }}>載入中...</Box>;

  return (
    <Box sx={{ maxWidth: 1200, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <PageHeaderMui
        icon={<LayoutDashboard size={26} color="#16a34a" />}
        title="價格總覽"
        description="快速預覽房型、公式與促銷設定目前的狀態。這裡都是唯讀捷徑，實際修改請點連結到「計價公式設定」對應區塊進行。"
      />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', md: '1fr 1fr 1fr 1fr' }, gap: 2 }}>
        <StatCardMui icon={<DoorOpen size={16} />} label="房型總數" value={activeRoomCount} />
        <StatCardMui icon={<Sparkles size={16} />} label="特殊日期" value={specialPriceCount} />
        <StatCardMui icon={<Percent size={16} />} label="促銷方案" value={promotions.length} />
        <StatCardMui
          icon={<DollarSign size={16} />}
          label="預估本月營收"
          value={`NT$ ${monthRevenue.toLocaleString()}`}
          valueColor="#16a34a"
          sublabel="依本月入住日、佔用中訂單的房價加總"
        />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr 1fr' }, gap: 2, alignItems: 'stretch' }}>
        <Paper variant="outlined" sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography fontWeight={600}>計價公式</Typography>
          <Typography variant="body2" color="text.secondary">
            每床基礎價 <strong>NT$ {bedBaseRate.toLocaleString()}</strong><br />
            滿載獎勵 <strong>NT$ {fullOccupancyBonus.toLocaleString()}</strong><br />
            最少接待人數 <strong>{minGroupHeadcount} 人</strong>
          </Typography>
          <Link to="/room-pricing/formula#pricing-formula-section" style={{ fontSize: 12, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
            前往計價公式設定 <ArrowRight size={12} />
          </Link>
        </Paper>

        <Paper variant="outlined" sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography fontWeight={600}>日期加價</Typography>
          <Typography variant="body2" color="text.secondary">
            小假日 <strong>+{dateSurchargeSmall.toLocaleString()}</strong><br />
            連假 <strong>+{dateSurchargeHoliday.toLocaleString()}</strong><br />
            旺季 <strong>+{dateSurchargePeak.toLocaleString()}</strong>
          </Typography>
          <Stack spacing={0.5}>
            <Link to="/room-pricing/formula#pricing-formula-section" style={{ fontSize: 12, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
              調整加價金額 <ArrowRight size={12} />
            </Link>
            <Link to="/room-calendar" style={{ fontSize: 12, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
              <CalendarDays size={12} /> 到「行事曆」設定旺季/連假日期區間 <ArrowRight size={12} />
            </Link>
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography fontWeight={600}>促銷方案</Typography>
          {promotions.length === 0 ? (
            <Typography variant="body2" color="text.disabled">尚未設定促銷方案</Typography>
          ) : (
            <Stack spacing={1}>
              {promotions.map((p) => {
                const active = activePromotionId === p.id;
                return (
                  <Box
                    key={p.id}
                    onClick={() => selectActivePromotion(p.id)}
                    sx={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1,
                      px: 1.5, py: 1, borderRadius: 1.5, border: '1px solid', cursor: 'pointer',
                      borderColor: active ? 'success.light' : 'divider',
                      bgcolor: active ? 'success.50' : 'transparent',
                      color: active ? 'success.dark' : 'text.secondary',
                      fontSize: 13,
                      '&:hover': { bgcolor: active ? 'success.50' : 'action.hover' },
                    }}
                  >
                    <Typography variant="body2" noWrap sx={{ color: 'inherit' }}>{promotionLabel(p)}</Typography>
                    {active && <Chip label="目前套用" size="small" color="success" sx={{ height: 20, fontSize: 11 }} />}
                  </Box>
                );
              })}
            </Stack>
          )}
          <Link to="/room-pricing/formula#promotions-section" style={{ fontSize: 12, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
            管理所有促銷方案 <ArrowRight size={12} />
          </Link>
        </Paper>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '2fr 1fr' }, gap: 2, alignItems: 'stretch' }}>
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1} sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Typography fontWeight={600}>房型概覽</Typography>
            <Link to="/room-spaces" style={{ fontSize: 12, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
              管理房型 <ArrowRight size={12} />
            </Link>
          </Stack>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>房型</TableCell>
                  <TableCell>容納人數</TableCell>
                  <TableCell>押金</TableCell>
                  <TableCell>該容量加開房費</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {roomTypes.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell sx={{ fontWeight: 500 }}>{r.floor ? `${r.floor}-` : ''}{r.name}</TableCell>
                    <TableCell>{r.capacity} 人</TableCell>
                    <TableCell>NT$ {Number(r.security_deposit || 0).toLocaleString()}</TableCell>
                    <TableCell>NT$ {(capacityFees.find((c) => c.capacity === r.capacity)?.extra_room_fee ?? 0).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
                {roomTypes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} align="center" sx={{ color: 'text.disabled', py: 3 }}>尚未設定任何房型</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <Divider />
          <Box sx={{ px: 2.5, py: 1.5 }}>
            <Link to="/room-pricing/formula#pricing-formula-section" style={{ fontSize: 12, color: '#15803d', display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}>
              調整加開房費/押金 <ArrowRight size={12} />
            </Link>
          </Box>
        </Paper>

        <Paper variant="outlined" sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography fontWeight={600} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Lightbulb size={16} color="#f59e0b" />價格設定小提醒
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
            {TIPS.map((tip, i) => (
              <Typography key={i} component="li" variant="caption" color="text.secondary">{tip}</Typography>
            ))}
          </Box>
        </Paper>
      </Box>
    </Box>
  );
}

// 節日固定價（不看人數統一價）：booking_date_ranges.fixed_price 命中時取代整段公式；
// 特殊指定日期價格仍優先；重疊區間取最窄的一段；折扣疊加沿用特殊日期價格的開關。
import { computeUnifiedMultiNightQuote, getFixedRangePrice, type UnifiedQuoteInput } from '../../src/lib/bookingEngine';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

// 2026-10-09（五）～10-11（日）是國慶連假；bed 1000、滿載 +500、連假加價 12000、小假日 5000
const base: UnifiedQuoteInput = {
  checkInDate: new Date(2026, 9, 9),
  nights: 1,
  headcount: 4,
  dateRanges: [{ range_type: '連假', start_date: '2026-10-09', end_date: '2026-10-11', label: '國慶連假' }],
  roomCapacities: [{ capacity: 2, count: 2 }, { capacity: 4, count: 2 }],
  capacityFees: [{ capacity: 2, extra_room_fee: 1000 }, { capacity: 4, extra_room_fee: 1500 }],
  bedBaseRate: 1000,
  fullOccupancyBonus: 500,
  minGroupHeadcount: 1,
  dateSurcharge: { small_holiday: 5000, peak: 8000, long_holiday: 12000 },
  promotion: null,
  consecutiveStayDiscountPerNight: 500,
};
const withFixed = (price: number, extra: Partial<UnifiedQuoteInput> = {}): UnifiedQuoteInput => ({
  ...base, ...extra,
  dateRanges: [{ ...base.dateRanges[0], fixed_price: price }, ...(extra.dateRanges || [])],
});

// 沒填固定價：照公式 4 床×1000 + 滿載 500 + 連假 12000 = 16500
const formula = computeUnifiedMultiNightQuote(base);
t('沒填固定價 → 照公式（4 人 16,500，來源 formula）', formula.total === 16500 && formula.nightly[0].priceSource === 'formula', formula);

const fixed4 = computeUnifiedMultiNightQuote(withFixed(20000));
const fixed2 = computeUnifiedMultiNightQuote(withFixed(20000, { headcount: 2 }));
const fixed7 = computeUnifiedMultiNightQuote(withFixed(20000, { headcount: 7 }));
t('填固定價 20,000 → 2 人、4 人、7 人都是 20,000（不看人數）', fixed4.total === 20000 && fixed2.total === 20000 && fixed7.total === 20000, { fixed4: fixed4.total, fixed2: fixed2.total, fixed7: fixed7.total });
t('固定價那一晚 priceSource=fixed_range、tier 仍顯示連假', fixed4.nightly[0].priceSource === 'fixed_range' && fixed4.nightly[0].tier === '連假', fixed4.nightly[0]);

// 指定房型組合的加開房費在固定價那晚不再疊加
const fixedLayout = computeUnifiedMultiNightQuote(withFixed(20000, { requestedLayout: { 2: 2 } }));
t('固定價不疊加加開房費', fixedLayout.total === 20000, fixedLayout.total);

// 固定價只影響價格：人數超過可接待仍然不報價
const tooMany = computeUnifiedMultiNightQuote(withFixed(20000, { headcount: 13 }));
t('固定價不影響「超過可接待人數不報價」', tooMany.total === null);

// 特殊指定日期價格優先於固定價
const special = computeUnifiedMultiNightQuote(withFixed(20000, { specialPrices: [{ start_date: '2026-10-09', end_date: '2026-10-09', occupancy: null, price: 25000 }] }));
t('同一天有特殊日期價格 → 以特殊日期價格為準（25,000，來源 special）', special.total === 25000 && special.nightly[0].priceSource === 'special', special.nightly[0]);

// 兩晚：第一晚固定價、第二晚（10-12 一）不在連假內 → 公式平日 4500 再減連住 500
const twoNights = computeUnifiedMultiNightQuote({ ...withFixed(20000), checkInDate: new Date(2026, 9, 11), nights: 2 });
t('跨出固定價區間的晚數照公式（20,000 + 4,000）', twoNights.total === 24000 && twoNights.nightly[1].priceSource === 'formula', twoNights.nightly.map((n) => [n.rawPrice, n.discountedPrice, n.priceSource]));

// 折扣疊加開關：預設疊加（促銷折 1000 → 19,000）；關掉 → 20,000
const promo = { id: 'p', name: '早鳥', discount_type: 'amount', discount_amount: 1000, discount_percent: 0 } as any;
const stack = computeUnifiedMultiNightQuote(withFixed(20000, { promotion: promo }));
const noStack = computeUnifiedMultiNightQuote(withFixed(20000, { promotion: promo, specialPriceStacksWithDiscounts: false }));
t('固定價預設仍疊加促銷（19,000）；關閉疊加 → 20,000', stack.total === 19000 && noStack.total === 20000, { stack: stack.total, noStack: noStack.total });

// 重疊：整個暑假旺季固定 15,000，但其中一段連假固定 22,000 → 取最窄的連假
const overlap = getFixedRangePrice(new Date(2026, 7, 8), [
  { range_type: '旺季', start_date: '2026-07-01', end_date: '2026-08-31', fixed_price: 15000 },
  { range_type: '連假', start_date: '2026-08-08', end_date: '2026-08-09', fixed_price: 22000 },
]);
t('重疊區間取最窄的一段（22,000）', overlap === 22000, overlap);
t('旺季固定價區間內、非連假的日子取旺季固定價', getFixedRangePrice(new Date(2026, 6, 15), [{ range_type: '旺季', start_date: '2026-07-01', end_date: '2026-08-31', fixed_price: 15000 }]) === 15000);
t('區間有填 null／沒填 → 不算固定價', getFixedRangePrice(new Date(2026, 9, 9), [{ range_type: '連假', start_date: '2026-10-09', end_date: '2026-10-11', fixed_price: null }, base.dateRanges[0]]) === null);

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

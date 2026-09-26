// 訊息變數代入：系統自己出的範本用到的名稱（[入住人數]…）不能依賴管理員有沒有在「參數設定」建過對照。
import { buildMergeFields, buildStandardFields, STANDARD_VARIABLE_ROWS } from '../../src/lib/messageVariables';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const booking = {
  order_number: 'DX26090003', name: '林志偉', phone: '0912345900',
  checkin_date: '2026-09-22', checkout_date: '2026-09-25', headcount: 4, adults: 3, kids: 1, infants: 0,
  whole_house: true, room_type_label: '包棟', guest_notes: '想烤肉', status: 'awaiting_confirmation',
  room_amount: 7600, security_deposit: 3000, total_amount: 10600, deposit: 2280,
};
const ctx = { booking, customer: { nickname: '小林', line_user_id: 'U1' }, settings: { business_name: '稻香民宿' } } as any;
const std = buildStandardFields(ctx);

t('[入住人數] 一律算得出來（這次回報的問題）', std['入住人數'] === '4', std['入住人數']);
t('其餘常用欄位也都有值', ['訂單編號', '客戶姓名', '入住日期', '退房日期', '房型', '電話'].every((k) => !!std[k]), Object.fromEntries(['訂單編號', '客戶姓名', '入住日期', '退房日期', '房型', '電話'].map((k) => [k, std[k]])));
t('金額欄位用短名（不是白名單裡帶括號說明的 label）', std['訂單總額'] === '10,600' && std['訂金'] === '2,280' && std['尾款'] === '8,320' && std['房價'] === '7,600', { 訂單總額: std['訂單總額'], 訂金: std['訂金'], 尾款: std['尾款'], 房價: std['房價'] });
t('沒有帶括號說明的變數名（[訂單總額（房價＋押金）] 這種不該出現）', !Object.keys(std).some((k) => k.includes('（')), Object.keys(std).filter((k) => k.includes('（')));
t('兩種歷史叫法都認得（姓名／人數／總金額／總報價）', std['姓名'] === '林志偉' && std['人數'] === '4' && std['總金額'] === '10,600' && std['總報價'] === '10,600');
t('客戶與民宿設定的欄位也有（LINE 暱稱、民宿名稱）', std['LINE 暱稱'] === '小林' && std['民宿名稱'] === '稻香民宿');
t('大人小孩、是否包棟算得出來', std['大人小孩'].includes('3') && std['是否包棟'] === '是', { a: std['大人小孩'], w: std['是否包棟'] });

// 管理員自訂的同名變數要蓋過標準值（呼叫端的 spread 順序）
const custom = buildMergeFields([{ variable_name: '入住人數', source: 'booking', field_key: 'adults_kids' } as any], ctx);
const merged = { ...std, ...custom };
t('管理員自訂的同名變數優先', merged['入住人數'] === std['大人小孩'] && merged['入住人數'] !== '4', merged['入住人數']);

// 編輯器用的清單
const names = STANDARD_VARIABLE_ROWS.map((r) => r.variable_name);
t('編輯器的內建變數清單涵蓋所有標準欄位，且都有 field_key', names.includes('入住人數') && STANDARD_VARIABLE_ROWS.every((r) => !!r.field_key));
t('內建變數清單沒有重複的名稱', new Set(names).size === names.length, names.filter((n, i) => names.indexOf(n) !== i));
t('每個內建變數名都算得出值', names.every((n) => n in std), names.filter((n) => !(n in std)));

// 空值不該變成 undefined 字串
const empty = buildStandardFields({ booking: {} as any });
t('沒有值的欄位回空字串，不是 undefined', Object.values(empty).every((v) => typeof v === 'string'), Object.entries(empty).filter(([, v]) => typeof v !== 'string'));

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

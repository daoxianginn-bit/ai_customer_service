// 報價之後客人用「問句」講出新條件時，系統算得出來就該直接報，不是推給真人：
//   「如果多1大人1小孩價格一樣嗎?」→ 9 人改 11 人重新報價（以前回「稍後由專人回覆」）
//   「可以給我4間房嗎?」           → 挑一組住得下的 4 間房報價（以前原封不動重送同一張報價）
import { composeRoomsForTotal, scanHeadcountDelta, scanRoomTotal } from '../../src/lib/bookingIntent';
import { scanHeadcountForTest } from '../../netlify/functions/line-webhook';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

// ---- 相對人數
t('「如果多1大人1小孩價格一樣嗎?」9 人 → 11 人（這次的 case）', scanHeadcountDelta('如果多1大人1小孩價格一樣嗎?', 9) === 11, scanHeadcountDelta('如果多1大人1小孩價格一樣嗎?', 9));
t('「再加兩人」→ +2', scanHeadcountDelta('再加兩人', 9) === 11);
t('「多一個人」→ +1', scanHeadcountDelta('多一個人', 9) === 10);
t('「多十位」→ +10', scanHeadcountDelta('多十位', 9) === 19);
t('「少1位」→ -1', scanHeadcountDelta('少1位可以嗎', 9) === 8);
t('「多2大人和1小孩」→ +3', scanHeadcountDelta('多2大人和1小孩', 9) === 12);
t('沒有加減詞就不算相對變動（「9人」是絕對人數）', scanHeadcountDelta('9人', 9) === undefined);
t('減到 0 或負數不採用（不要報價 0 人）', scanHeadcountDelta('少9人', 9) === undefined && scanHeadcountDelta('少20人', 9) === undefined);
t('還沒收集到人數時不適用', scanHeadcountDelta('多2人', 0) === undefined);
t('「多1間房」不是人數（單位是間）', scanHeadcountDelta('多1間房', 9) === undefined);

// ---- 只講間數
t('「可以給我4間房嗎?」→ 4', scanRoomTotal('所以你們提供2+4+4的房型嗎? 可以給我4間房嗎?') === 4);
t('「我要三間房」→ 3', scanRoomTotal('我要三間房') === 3);
t('「兩間房間」→ 2', scanRoomTotal('可以訂兩間房間嗎') === 2);
t('沒提到間數就是 undefined', scanRoomTotal('有消毒鍋嗎?') === undefined);
t('誇張的數字不採用', scanRoomTotal('我要100間房') === undefined);

// ---- 挑組合：5 間房（2 人房 2 間、4 人房 3 間）
const inventory = [{ capacity: 2, count: 2 }, { capacity: 4, count: 3 }];
const pick = (rooms: number, people: number, inv = inventory) => composeRoomsForTotal(rooms, people, inv);

t('9 人要 4 間房 → 2+2+4+4（住得下、床位最少）', (() => {
  const c = pick(4, 9);
  return !!c && c.seatsAll && c.layout[2] === 2 && c.layout[4] === 2 && c.beds === 12;
})(), pick(4, 9));
t('9 人要 3 間房 → 2+4+4（10 床）', (() => {
  const c = pick(3, 9);
  return !!c && c.seatsAll && c.layout[2] === 1 && c.layout[4] === 2;
})(), pick(3, 9));
t('9 人要 2 間房 → 住不下，回床位最多的 4+4（讓報價那邊照實說「最多 8 人」）', (() => {
  const c = pick(2, 9);
  return !!c && !c.seatsAll && c.beds === 8 && c.layout[4] === 2;
})(), pick(2, 9));
t('要 6 間房 → null（總共只有 5 間，交給知識庫回答實際房間數）', pick(6, 9) === null);
t('4 人要 2 間房 → 2+2（不會浪費開兩間四人房）', (() => {
  const c = pick(2, 4);
  return !!c && c.seatsAll && c.layout[2] === 2 && c.layout[4] === undefined;
})(), pick(2, 4));
t('5 人要 2 間房 → 2+4', (() => {
  const c = pick(2, 5);
  return !!c && c.seatsAll && c.layout[2] === 1 && c.layout[4] === 1;
})(), pick(2, 5));
t('沒有房型資料時回 null', pick(2, 4, []) === null);

// ---- 大人＋小孩要相加（規則模式；AI 模式本來就算得對）
t('「7+2小」＝9 人，不是 7 人', scanHeadcountForTest('7+2小') === '9', scanHeadcountForTest('7+2小'));
t('「2大人1小孩」＝3 人', scanHeadcountForTest('2大人1小孩') === '3', scanHeadcountForTest('2大人1小孩'));
t('「7大2小」＝9 人', scanHeadcountForTest('7大2小') === '9');
t('「9人」還是 9 人', scanHeadcountForTest('9人') === '9');
t('「有4人房嗎」不是人數（在講房型）', scanHeadcountForTest('有4人房嗎') === undefined, scanHeadcountForTest('有4人房嗎'));
t('「可以給我4間房嗎?」不是人數（在講房數）', scanHeadcountForTest('可以給我4間房嗎?') === undefined, scanHeadcountForTest('可以給我4間房嗎?'));
t('「9」還是當人數（整步只問人數、客人只回一個數字）', scanHeadcountForTest('9') === '9');

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

// 客人先說模糊日期、之後才講清楚的情境（實際發生的報價錯誤）：
//   「10月初還有房嗎?」→ AI 把它當成 10/01 存起來
//   「10/6-7」        → 入住日被「已經答過就不覆蓋」擋掉，只補了退房日
//   結果報價用 10/01 → 10/07（6 晚），客人根本沒說要住 10/01。
import { hasOnlyVagueDate, isDateField, messageStatesFieldExplicitly } from '../../netlify/functions/line-webhook';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const checkin = { key: 'f1', label: '入住日期', quote_field: 'checkin_date' as const, value_type: 'date' as const };
const checkout = { key: 'f2', label: '退房日期', quote_field: 'checkout_date' as const, value_type: 'date' as const };
const headcount = { key: 'f3', label: '人數', quote_field: 'headcount' as const, value_type: 'number' as const };
const roomCount = { key: 'f4', label: '雙人房數', quote_field: 'room_count' as const, room_capacity: 2, value_type: 'number' as const };
const wholeHouse = { key: 'f5', label: '是否包棟', quote_field: 'whole_house' as const, value_type: null };
const notes = { key: 'f6', label: '備註', quote_field: null, value_type: 'string' as const };

// ---- 模糊日期不能變成具體日期
t('「10月初還有房嗎?」算模糊日期，AI 猜的 10/01 要作廢', hasOnlyVagueDate('10月初還有房嗎?'));
t('「月底想去」「下旬」「過年」都算模糊', ['月底想去', '10月下旬', '過年想訂房', '連假有空房嗎'].every(hasOnlyVagueDate));
t('「10/6-7」有具體日期，不算模糊', !hasOnlyVagueDate('10/6-7'));
t('「10月初到10月5號」講得出日子，不算模糊', !hasOnlyVagueDate('10月初到10月5號'));
t('「下個月6號」有具體的日，交給 AI 換算年月，不算模糊', !hasOnlyVagueDate('下個月6號'));
t('「10月6日」不算模糊', !hasOnlyVagueDate('10月6日'));
t('沒提到日期的閒聊不算模糊日期（不會誤刪別的欄位）', !hasOnlyVagueDate('請問有停車位嗎'));

// ---- 已答過的欄位什麼時候可以被覆蓋
t('「10/6-7」可以改掉已答過的入住日與退房日（這次的 bug）', messageStatesFieldExplicitly('10/6-7', checkin) && messageStatesFieldExplicitly('10/6-7', checkout));
t('「10月6日入住」可以改日期', messageStatesFieldExplicitly('10月6日入住', checkin));
t('「改成7個人」可以改人數（數字帶單位）', messageStatesFieldExplicitly('改成7個人', headcount));
t('「人數：9」可以改人數（有標籤）', messageStatesFieldExplicitly('人數：9', headcount));
t('「7+2小」可以改人數', messageStatesFieldExplicitly('7+2小', headcount), '7+2小');
t('光一個「1」不能改人數（bot 問房數、客人回 1 的經典卡住）', !messageStatesFieldExplicitly('1', headcount));
t('光一個「1」不能改房數，要有標籤', !messageStatesFieldExplicitly('1', roomCount) && messageStatesFieldExplicitly('雙人房數：1', roomCount));
t('「是」不能改包棟（跟確認用語分不開），要有標籤', !messageStatesFieldExplicitly('是', wholeHouse) && messageStatesFieldExplicitly('是否包棟：是', wholeHouse));
t('自由文字要有標籤才能改', !messageStatesFieldExplicitly('想烤肉', notes) && messageStatesFieldExplicitly('備註：想烤肉', notes));
t('沒有日期的句子不能改日期', !messageStatesFieldExplicitly('我要訂房', checkin));
t('訊息裡的電話號碼不會被當成日期而改掉入住日', !messageStatesFieldExplicitly('我的電話 0912345678', checkin), '0912345678');

// ---- 日期欄位的判定
t('isDateField 認得算價的入住／退房，也認得 value_type=date 的自訂欄位', isDateField(checkin) && isDateField(checkout) && isDateField({ key: 'x', label: '預計抵達日', quote_field: null, value_type: 'date' }) && !isDateField(headcount));

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

// 忽略關鍵字的規則格式：新的 JSON（每條可選 包含／整句相等）與舊的逗號字串都要讀得對。
import { parseKeywordRules, serializeKeywordRules, matchTriggerRules } from '../../src/lib/messageVariables';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

let rules = parseKeywordRules('測試,廣告,型');
t('舊逗號格式：多字＝包含、單字＝整句相等', rules.length === 3 && rules[0].match === 'contains' && rules[2].match === 'exact', rules);
t('舊格式下「房型有哪些」不會被單字「型」擋掉（整句相等）', !matchTriggerRules('房型有哪些', rules), rules);
t('舊格式下「這是測試」被「測試」擋掉（包含）', !!matchTriggerRules('這是測試', rules), rules);

const json = serializeKeywordRules([{ keyword: '房型', match: 'exact' }, { keyword: '廣告', match: 'contains' }, { keyword: '  ', match: 'exact' }]);
rules = parseKeywordRules(json);
t('新格式存成 JSON、空白項目丟掉', json.startsWith('[') && rules.length === 2, { json, rules });
t('「房型」設整句相等 → 「房型有哪些」不會被擋、「房型」會', !matchTriggerRules('房型有哪些', rules) && !!matchTriggerRules('房型', rules), rules);
t('「廣告」設包含 → 「這是廣告訊息」被擋', matchTriggerRules('這是廣告訊息', rules)?.keyword === '廣告', rules);
t('沒有規則 → 空字串（欄位清空）', serializeKeywordRules([]) === '' && parseKeywordRules('').length === 0);
t('壞掉的 JSON 當舊格式讀，不會炸', parseKeywordRules('[not json').length === 1);

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

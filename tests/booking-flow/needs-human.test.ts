// AI「答不出來」的判斷：有標記一定算；模型漏掉標記時靠制式句子的片語備援；答得出來的正常回覆不能誤判。
import { splitNeedsHumanMarker, NEEDS_HUMAN_MARKER } from '../../netlify/functions/line-webhook';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

let r = splitNeedsHumanMarker(`不好意思，這部分我幫您確認一下，稍後由專人回覆您 🙏\n${NEEDS_HUMAN_MARKER}`);
t('有標記 → needsHuman，且標記從客人看到的文字裡拿掉', r.needsHuman && !r.text.includes('[[') && r.text.endsWith('🙏'), r);

r = splitNeedsHumanMarker('不好意思，早餐供應方式目前沒有相關資訊，我幫您確認一下，稍後由專人回覆您 🙏');
t('模型漏掉標記、但是制式句 → 仍判定需專人（截圖裡的真實回覆）', r.needsHuman, r);

r = splitNeedsHumanMarker('我們的入住時間是下午三點，退房是上午十一點喔 😊');
t('答得出來的一般回覆 → 不需專人、文字不變', !r.needsHuman && r.text === '我們的入住時間是下午三點，退房是上午十一點喔 😊', r);

r = splitNeedsHumanMarker(`目前沒有提供早餐，附近步行 5 分鐘有早餐店。 ${NEEDS_HUMAN_MARKER}`);
t('標記黏在句尾也拿得乾淨', !r.text.includes('[[') && r.text === '目前沒有提供早餐，附近步行 5 分鐘有早餐店。', r);

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

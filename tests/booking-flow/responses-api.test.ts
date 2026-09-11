// OpenAI Responses API 回應解析。這個形狀來自官方文件；以前的程式碼讀 result.output.text，
// 對陣列永遠拿到 undefined，等於 GPT-5 系列每次都回空字串——問答整則不回、欄位擷取全空。
import { extractResponsesApiText } from '../../netlify/functions/line-webhook';

const checks: [string, boolean][] = [];
const t = (name: string, ok: boolean) => checks.push([name, ok]);

// 官方文件的典型回應：reasoning 項 + message 項
const typical = {
  id: 'resp_1', object: 'response', status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"intent":"question","slots":{}}', annotations: [] }] },
  ],
};
t('典型回應（reasoning + message）→ 抽出文字', extractResponsesApiText(typical) === '{"intent":"question","slots":{}}');

t('舊寫法 result.output.text 是 undefined（證明原本的 bug）', (typical.output as any).text === undefined);

t('SDK 風格的 output_text 欄位優先', extractResponsesApiText({ output_text: '直接的文字', output: [] }) === '直接的文字');

const multi = { output: [
  { type: 'message', content: [{ type: 'output_text', text: '第一段' }] },
  { type: 'message', content: [{ type: 'output_text', text: '第二段' }] },
] };
t('多個 message 項 → 串起來', extractResponsesApiText(multi) === '第一段\n第二段');

t('refusal → 帶出來讓錯誤看得懂', extractResponsesApiText({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: '不能回答' }] }] }) === '[refusal] 不能回答');

t('只有 reasoning、沒有 message → 空字串（呼叫端會當錯誤）', extractResponsesApiText({ output: [{ type: 'reasoning' }] }) === '');
t('完全不是預期形狀 → 空字串，不炸', extractResponsesApiText(null) === '' && extractResponsesApiText({}) === '' && extractResponsesApiText({ output: 'oops' }) === '');

let ok = true;
for (const [k, v] of checks) { console.log((v ? '✓ ' : '✗ ') + k); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

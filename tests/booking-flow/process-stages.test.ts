// 訂單處理（人工關卡工作台）：關卡定義要跟狀態機一致、排序與範本挑選的純函式。
import { STAGES, defaultTemplateFor, mergeTemplate, sortQueue, stageForStatus } from '../../src/features/process/processStages';
import { MANUAL_ACTION_STATUSES, nextFlowStatus } from '../../src/lib/bookingStatus';
import { PERMISSION_CATALOG } from '../../src/app/permissions';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const codes = new Set(PERMISSION_CATALOG.map((p) => p.code));

// 關卡定義
t('每個狀態只屬於一個關卡', (() => { const all = STAGES.flatMap((s) => s.statuses); return new Set(all).size === all.length; })());
t('人工關卡的狀態（待確認／待收尾款／押金處理／待退款）都有對應關卡', ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund'].every((s) => !!stageForStatus(s)));
t('待人工確認（撞期）不在這一頁（那是候補／衝突頁的事）', !stageForStatus('pending_manual_conflict') && MANUAL_ACTION_STATUSES.includes('pending_manual_conflict'));
t('推進目標就是狀態機的下一關（待確認→已預定、待收尾款→待入住、押金處理→已處理）', ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing'].every((s) => stageForStatus(s)!.nextStatus === nextFlowStatus(s)));
t('待退款 → 已退款（例外分支，不在 1~9 序列）', stageForStatus('awaiting_refund')!.nextStatus === 'refunded' && nextFlowStatus('awaiting_refund') === null);
t('待確認的「確認」＝直接推進（避免被自動取消排程當成未付款）', stageForStatus('awaiting_confirmation')!.confirmAdvances && stageForStatus('awaiting_confirmation')!.fields.includes('remit'));
t('待入住／入住中不推進（由排程當天自動轉），可改密碼與洗物數量', (() => { const s = stageForStatus('awaiting_checkin')!; return s.nextStatus === null && s.fields.includes('password') && s.fields.includes('linen') && stageForStatus('checked_in') === s; })());
t('待退款的高亮鈕叫「退款完成」而不是「訂單取消」', stageForStatus('awaiting_refund')!.action === '退款完成');
t('每關的權限 code 都在目錄裡', STAGES.every((s) => codes.has(s.permission)), STAGES.filter((s) => !codes.has(s.permission)).map((s) => s.permission));
t('五關顏色互不相同', new Set(STAGES.map((s) => s.color)).size === STAGES.length);
t('booking.notify 權限存在', codes.has('booking.notify'));

// 排序：越急越上面
const q = sortQueue(stageForStatus('awaiting_confirmation')!, [
  { id: 'a', status: 'awaiting_confirmation', payment_deadline_at: '2026-09-20T10:00:00Z', created_at: '2026-09-10T00:00:00Z' },
  { id: 'b', status: 'awaiting_confirmation', payment_deadline_at: '2026-09-15T10:00:00Z', created_at: '2026-09-12T00:00:00Z' },
  { id: 'c', status: 'awaiting_confirmation', payment_deadline_at: null, created_at: '2026-09-01T00:00:00Z' },
] as any);
t('待確認依匯款期限排序，沒有期限的排最後', q.map((x) => x.id).join() === 'b,a,c', q.map((x) => x.id));
const q2 = sortQueue(stageForStatus('awaiting_checkin')!, [{ id: 'x', status: 'awaiting_checkin', checkin_date: '2026-09-20' }, { id: 'y', status: 'checked_in', checkin_date: '2026-09-14' }] as any);
t('入住處理依入住日排序', q2.map((x) => x.id).join() === 'y,x');

// 範本挑選：設定優先，沒設定用同名範本
const templates = [{ id: 't1', title: '訂房成功通知', body: 'A' }, { id: 't2', title: '別的', body: 'B' }];
const stage = stageForStatus('awaiting_confirmation')!;
t('沒設定 → 用預設標題的範本', defaultTemplateFor(stage, templates, {})?.id === 't1');
t('有設定 → 用設定的範本', defaultTemplateFor(stage, templates, { awaiting_confirmation: 't2' })?.id === 't2');
t('設定指到已刪除的範本 → 退回同名範本', defaultTemplateFor(stage, templates, { awaiting_confirmation: 'gone' })?.id === 't1');
t('mergeTemplate 代入變數、缺的變數原樣保留', mergeTemplate('[姓名] 訂單 [訂單編號] [沒有的]', { 姓名: '王小明', 訂單編號: 'DX1' }) === '王小明 訂單 DX1 [沒有的]');

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

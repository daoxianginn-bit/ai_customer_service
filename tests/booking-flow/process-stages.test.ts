// 訂單處理（人工關卡工作台）：關卡定義要跟狀態機與權限目錄一致，加上排序／時間窗／範本挑選的純函式。
import {
  STAGES, damageSummary, defaultTemplateFor, groupsOf, mergeTemplate, sortQueue, stageByKey, stagesForStatus, stageUsesWindow, withinCheckinWindow,
} from '../../src/features/process/processStages';
import { CHECKIN_PASSWORD_STATUSES, MANUAL_ACTION_STATUSES, nextFlowStatus } from '../../src/lib/bookingStatus';
import { PERMISSION_CATALOG, ROLE_TEMPLATES, withDependencies } from '../../src/app/permissions';

const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const codes = new Set(PERMISSION_CATALOG.map((p) => p.code));
const stage = (k: string) => stageByKey(k as never);
const permsOf = (roleCode: string) => new Set(ROLE_TEMPLATES.find((r) => r.code === roleCode)!.permissions);

// ---- 關卡定義
t('關卡 key 不重複', new Set(STAGES.map((s) => s.key)).size === STAGES.length);
t('每關顏色互不相同（一眼分得出來是哪一關）', new Set(STAGES.map((s) => s.color)).size === STAGES.length);
t('每關的權限 code 都在目錄裡', STAGES.every((s) => codes.has(s.permission)), STAGES.filter((s) => !codes.has(s.permission)).map((s) => s.permission));
t('人工關卡的四個款項狀態都有對應關卡', ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund'].every((s) => stagesForStatus(s).length > 0));
t('待人工確認（撞期）不在這一頁（那是候補／衝突頁的事）', stagesForStatus('pending_manual_conflict').length === 0 && MANUAL_ACTION_STATUSES.includes('pending_manual_conflict'));

// ---- 一筆訂單可以同時出現在多個關卡（這次改版的重點）
t('待入住同時出現在 洗滌清單 與 入住密碼 兩關', (() => {
  const keys = stagesForStatus('awaiting_checkin').map((s) => s.key).sort();
  return keys.join() === 'checkin_password,linen' && stagesForStatus('checked_in').map((s) => s.key).sort().join() === keys.join();
})(), stagesForStatus('awaiting_checkin').map((s) => s.key));
t('押金處理同時出現在 房況檢查（房務）與 押金退款（會計）兩關', (() => {
  const keys = stagesForStatus('deposit_processing').map((s) => s.key).sort();
  return keys.join() === 'deposit_processing,room_check';
})(), stagesForStatus('deposit_processing').map((s) => s.key));

// ---- 推進目標與狀態機一致
t('推進目標＝狀態機的下一關（訂金→已預定、尾款→待入住、押金退款→已處理）', ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing'].every((k) => stage(k).nextStatus === nextFlowStatus(k)));
t('取消退款 → 已退款（例外分支，不在 1~9 序列）', stage('awaiting_refund').nextStatus === 'refunded' && nextFlowStatus('awaiting_refund') === null);
t('訂金入款的「確認」＝直接推進（避免被自動取消排程當成未付款）', stage('awaiting_confirmation').confirmAdvances && stage('awaiting_confirmation').fields.includes('remit'));
t('房務的三關都不推進狀態（排程當天自動轉／還要等會計）', ['linen', 'checkin_password', 'room_check'].every((k) => stage(k).nextStatus === null && !stage(k).confirmAdvances));

// ---- 房務看不到金流、會計看不到布巾
t('房務的關卡只顯示總額（money=total）', ['linen', 'checkin_password', 'room_check'].every((k) => stage(k).money === 'total' && stage(k).amountLabel === null));
t('會計的四關顯示完整金額與本關金額', ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund'].every((k) => stage(k).money === 'full' && !!stage(k).amountLabel));
t('洗滌清單與房況檢查不發客人通知', stage('linen').templateTitle === null && stage('room_check').templateTitle === null);
t('入住密碼的通知鈕寫「補發密碼給客人」（主要由排程發）', stage('checkin_password').templateTitle === '入住密碼發送' && stage('checkin_password').notifyLabel === '補發密碼給客人');

// ---- 角色範本真的做得到自己的事
const hk = permsOf('housekeeping');
const acc = permsOf('accounting');
t('房務範本有洗滌／密碼／房況三關的權限，且做得到那三關', ['linen', 'checkin_password', 'room_check'].every((k) => hk.has(stage(k).permission)), [...hk].filter((p) => p.startsWith('booking.')));
t('房務範本沒有任何金流關卡的權限', !['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund'].some((k) => hk.has(stage(k).permission)));
t('房務範本能補發密碼（booking.notify）', hk.has('booking.notify'));
t('會計範本做得到四個金流關卡', ['awaiting_confirmation', 'awaiting_balance', 'deposit_processing', 'awaiting_refund'].every((k) => acc.has(stage(k).permission)));
t('會計範本沒有布巾／密碼／房況的權限', !['linen', 'checkin_password'].some((k) => acc.has(stage(k).permission)));
t('新權限的相依都補齊（勾了就一定帶 booking.view）', ['booking.linen.manage', 'booking.checkin_password.manage', 'booking.room_check'].every((c) => withDependencies([c]).has('booking.view')));
t('入住密碼不再綁在付款權限上（房務看得到密碼、看不到金額）', PERMISSION_CATALOG.find((p) => p.code === 'booking.payment.view')!.description.indexOf('入住密碼') === -1);
t('groupsOf 依固定順序回傳（款項→入住→退房→補登）', groupsOf(STAGES).join() === 'payment,checkin,checkout,backfill');
t('房務打開入住準備、退房檢查與資料補登三組', groupsOf(STAGES.filter((s) => hk.has(s.permission))).join() === 'checkin,checkout,backfill');
t('會計打開只有款項處理一組', groupsOf(STAGES.filter((s) => acc.has(s.permission))).join() === 'payment');

// ---- 待補布巾數量（資料補登）
const backfill = stage('linen_backfill');
t('待補布巾數量不看狀態，只看旗標', backfill.statuses.length === 0 && typeof backfill.appliesTo === 'function');
t('有旗標才進佇列', !!backfill.appliesTo!({ id: 'a', status: 'external_synced', needs_linen_backfill: true } as any));
t('沒旗標不進佇列', !backfill.appliesTo!({ id: 'a', status: 'external_synced' } as any));
t('第三方平台訂單本來不屬於任何關卡，靠這一關才看得到',
  stagesForStatus('external_synced').length === 0 && !!backfill.appliesTo!({ id: 'a', status: 'external_synced', needs_linen_backfill: true } as any));
t('這一關不推進狀態（補資料不該改訂單流程）', backfill.nextStatus === null && backfill.confirmAdvances === false);
t('這一關不發客人通知', backfill.templateTitle === null);
t('權限跟洗滌清單同一個（都是房務）', backfill.permission === stage('linen').permission);
t('不吃入住時間窗（住完的也要補）', !stageUsesWindow(backfill));
// ---- 入住準備：已預定 ~ 入住中都能備料
//
// 「待收尾款 → 待入住」沒有排程、只能人工按，尾款沒人確認的訂單會一路停在待收尾款。
// 只收待入住／入住中的話，客人當天要來了房務還是碰不到那筆單。
const prepStatuses = ['reserved', 'awaiting_balance', 'awaiting_checkin', 'checked_in'];
for (const s of prepStatuses) {
  t(`${s}：洗滌清單與入住密碼都進得去`,
    stagesForStatus(s).map((x) => x.key).sort().join().includes('checkin_password')
    && stagesForStatus(s).map((x) => x.key).includes('linen'),
    stagesForStatus(s).map((x) => x.key));
}
t('押金處理不進入住準備（退房後備料沒有意義，要補成本走資料補登）',
  !stagesForStatus('deposit_processing').some((s) => s.group === 'checkin'),
  stagesForStatus('deposit_processing').map((s) => s.key));
t('已處理不進入住準備', !stagesForStatus('completed').some((s) => s.group === 'checkin'));
t('第三方平台訂單仍然只靠資料補登那一關',
  stagesForStatus('external_synced').length === 0);

// 兩份清單必須一字不差。不一致的後果是「房務在工作台設好密碼，別人下一次編輯那張訂單存檔
// 就把它清成 null」——而且畫面上不會有任何提示，是會默默吃掉資料的那種錯。
t('可填密碼的狀態＝入住密碼那一關收的狀態',
  [...CHECKIN_PASSWORD_STATUSES].sort().join() === stage('checkin_password').statuses.slice().sort().join(),
  { 密碼欄位: CHECKIN_PASSWORD_STATUSES, 關卡: stage('checkin_password').statuses });

// ---- 入住準備的時間窗
const bk = (checkin: string) => ({ id: 'x', status: 'awaiting_checkin', checkin_date: checkin }) as any;
const today = new Date('2026-09-16T08:00:00');
t('只有入住準備用時間窗', STAGES.filter(stageUsesWindow).map((s) => s.key).sort().join() === 'checkin_password,linen');
t('14 天內的算在內、第 20 天的不算', withinCheckinWindow(bk('2026-09-29'), 14, today) && !withinCheckinWindow(bk('2026-10-06'), 14, today));
t('今天入住、昨天就入住（入住中）都算在內', withinCheckinWindow(bk('2026-09-16'), 3, today) && withinCheckinWindow(bk('2026-09-10'), 3, today));
t('選「全部」時不過濾', withinCheckinWindow(bk('2027-01-01'), 0, today));

// ---- 排序：越急越上面
const q = sortQueue(stage('awaiting_confirmation'), [
  { id: 'a', status: 'awaiting_confirmation', payment_deadline_at: '2026-09-20T10:00:00Z', created_at: '2026-09-10T00:00:00Z' },
  { id: 'b', status: 'awaiting_confirmation', payment_deadline_at: '2026-09-15T10:00:00Z', created_at: '2026-09-12T00:00:00Z' },
  { id: 'c', status: 'awaiting_confirmation', payment_deadline_at: null, created_at: '2026-09-01T00:00:00Z' },
] as any);
t('訂金入款依匯款期限排序，沒有期限的排最後', q.map((x) => x.id).join() === 'b,a,c', q.map((x) => x.id));
t('入住準備依入住日排序', sortQueue(stage('linen'), [bk('2026-09-20'), { ...bk('2026-09-14'), id: 'y' }] as any).map((x: any) => x.id).join() === 'y,x');
t('房況檢查依退房日排序', sortQueue(stage('room_check'), [
  { id: 'a', status: 'deposit_processing', checkout_date: '2026-09-18' }, { id: 'b', status: 'deposit_processing', checkout_date: '2026-09-15' },
] as any).map((x) => x.id).join() === 'b,a');

// ---- 房況回報 → 會計的實退金額
t('還沒檢查：標示未檢查、不扣款', (() => { const d = damageSummary({ } as any); return !d.checked && d.deduction === 0; })());
t('檢查過沒損壞：房況正常', (() => { const d = damageSummary({ damage_found: false } as any); return d.checked && d.label === '房況正常' && d.deduction === 0; })());
t('有損壞含建議扣款：標示金額', damageSummary({ damage_found: true, damage_deduction: 500 } as any).label.includes('500'));
t('押金退款的實退預設＝押金 − 房務建議扣款', stage('deposit_processing').defaultRefund!({ security_deposit: 3000, damage_found: true, damage_deduction: 500 } as any) === 2500);
t('房務還沒檢查就退全額', stage('deposit_processing').defaultRefund!({ security_deposit: 3000 } as any) === 3000);
t('建議扣款超過押金時不會退成負數', stage('deposit_processing').defaultRefund!({ security_deposit: 1000, damage_found: true, damage_deduction: 5000 } as any) === 0);
t('取消退款的實退預設＝已收訂金', stage('awaiting_refund').defaultRefund!({ deposit: 2280 } as any) === 2280);

// ---- 範本挑選
const templates = [{ id: 't1', title: '訂房成功通知', body: 'A' }, { id: 't2', title: '別的', body: 'B' }];
t('沒設定 → 用預設標題的範本', defaultTemplateFor(stage('awaiting_confirmation'), templates, {})?.id === 't1');
t('有設定 → 用設定的範本', defaultTemplateFor(stage('awaiting_confirmation'), templates, { awaiting_confirmation: 't2' })?.id === 't2');
t('設定指到已刪除的範本 → 退回同名範本', defaultTemplateFor(stage('awaiting_confirmation'), templates, { awaiting_confirmation: 'gone' })?.id === 't1');
t('不發通知的關卡永遠沒有預設範本', defaultTemplateFor(stage('linen'), templates, { linen: 't1' }) === null);
t('mergeTemplate 代入變數、缺的變數原樣保留', mergeTemplate('[姓名] 訂單 [訂單編號] [沒有的]', { 姓名: '王小明', 訂單編號: 'DX1' }) === '王小明 訂單 DX1 [沒有的]');

let ok = true;
for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n     ${d}` : '')); if (!v) ok = false; }
console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
process.exit(ok ? 0 : 1);

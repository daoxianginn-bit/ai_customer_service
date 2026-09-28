// 追加款：字母配發、尾款計算、訊息變數、會計的關卡，以及「LINE 機器人不會碰追加款」。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXTRA_CHARGE_MAX, computeBalanceDue, extraChargeCode, isBlankExtraChargeInput, nextExtraChargeLetters, remainingExtraChargeSlots, validateExtraChargeInput,
} from '../../src/lib/extraCharges';
import { buildStandardFields } from '../../src/lib/messageVariables';
import { STAGES, stageApplies, stageByKey, stagesForStatus } from '../../src/features/process/processStages';
import { ROLE_TEMPLATES } from '../../src/app/permissions';
import { __extraChargeTesting } from '../../netlify/functions/booking-process';
import { __reset, __db } from './stubs/supabase';
import { __sent } from './stubs/line';

const { addExtraCharges, setExtraChargesPaid } = __extraChargeTesting;
const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const stage = (k: string) => stageByKey(k as never);

(async () => {
  // ===== 編號 =====
  t('編號｜第一筆是 A', nextExtraChargeLetters([], 1)?.join() === 'A');
  t('編號｜已有 A、B → 一次加三筆是 C、D、E', nextExtraChargeLetters(['A', 'B'], 3)?.join() === 'C,D,E');
  t('編號｜作廢的不回收：用過 A、C（B 已刪不存在也一樣）→ 下一筆是 D', nextExtraChargeLetters(['A', 'C'], 1)?.join() === 'D');
  t('編號｜到 Z 為止，超過回 null', nextExtraChargeLetters(['Y'], 1)?.join() === 'Z' && nextExtraChargeLetters(['Y'], 2) === null);
  t('編號｜剩餘可加數', remainingExtraChargeSlots([]) === EXTRA_CHARGE_MAX && remainingExtraChargeSlots(['X']) === 2 && remainingExtraChargeSlots(['Z']) === 0);
  t('編號｜訂單編號-字母', extraChargeCode('K7M2QX', 'B') === 'K7M2QX-B' && extraChargeCode(null, 'B') === 'B');

  // ===== 輸入檢查 =====
  t('檢查｜名稱必填', !!validateExtraChargeInput({ title: ' ', amount: 500 })?.title);
  t('檢查｜金額要正整數（0、負數、小數都不行）', ['0', '-5', '12.5', 'abc', ''].every((a) => !!validateExtraChargeInput({ title: 'x', amount: a })?.amount));
  t('檢查｜合格', validateExtraChargeInput({ title: '烤肉用具租借', amount: '800' }) === null);
  t('檢查｜整列空白算空白', isBlankExtraChargeInput({ title: '', amount: '', internal_note: '' }) && !isBlankExtraChargeInput({ title: '', amount: '5' }));

  // ===== 尾款 =====
  const b = { total_amount: 13000, deposit: 3000, extra_unpaid_total: 1500, extra_paid_total: 800 };
  t('尾款｜總額－訂金＋未付追加款', computeBalanceDue(b) === 11500);
  t('尾款｜沒有追加款時跟以前一樣', computeBalanceDue({ total_amount: 13000, deposit: 3000 }) === 10000);
  t('尾款｜沒有總額算不出來', computeBalanceDue({ deposit: 3000 }) === null);

  // ===== 訊息變數 =====
  const f = buildStandardFields({ booking: { ...b, order_number: 'K7M2QX', extra_unpaid_detail: 'K7M2QX-B 延遲退房 NT$1,000\nK7M2QX-C 代訂晚餐 NT$500' } as any });
  t('變數｜[尾款] 含未付追加款', f['尾款'] === (11500).toLocaleString(), f['尾款']);
  t('變數｜[追加款明細]', f['追加款明細'].includes('K7M2QX-B 延遲退房'), f['追加款明細']);
  t('變數｜[追加款合計]', f['追加款合計'] === (1500).toLocaleString(), f['追加款合計']);

  // ===== 會計的關卡 =====
  const extras = stage('extra_charges');
  const acc = new Set(ROLE_TEMPLATES.find((r) => r.code === 'accounting')!.permissions);
  t('關卡｜追加款收款在款項處理組、會計做得到', extras.group === 'payment' && acc.has(extras.permission));
  t('關卡｜尾款已收（待入住／入住中／押金處理／已結案）＋有未付追加款 → 出現', ['awaiting_checkin', 'checked_in', 'deposit_processing', 'completed'].every((s) => stageApplies(extras, { id: 'x', status: s, extra_unpaid_total: 500 } as any)));
  t('關卡｜還沒到尾款關卡 → 不出現（會在尾款一起收）', ['reserved', 'awaiting_balance'].every((s) => !stageApplies(extras, { id: 'x', status: s, extra_unpaid_total: 500 } as any)));
  t('關卡｜沒有未付追加款 → 不出現', !stageApplies(extras, { id: 'x', status: 'completed', extra_unpaid_total: 0 } as any));
  t('關卡｜不影響「依狀態」的關卡分配', stagesForStatus('awaiting_checkin').map((s) => s.key).sort().join() === 'checkin_password,linen');
  t('關卡｜每關顏色還是互不相同', new Set(STAGES.map((s) => s.color)).size === STAGES.length);
  t('關卡｜應收尾款含未付追加款', stage('awaiting_balance').amountOf(b as any) === 11500);
  t('關卡｜取消退款的應退＝訂金＋已付追加款', stage('awaiting_refund').defaultRefund!(b as any) === 3800);

  // ===== 後端：新增追加款 =====
  const seed = (status: string, existing: any[] = []) => {
    __sent.length = 0;
    __reset({
      bookings: [{ id: 'b1', order_number: 'K7M2QX', status, name: '王小明', checkin_date: '2026-10-07', checkout_date: '2026-10-08' }],
      booking_extra_charges: existing,
      operation_logs: [],
      scheduled_tasks: [{ task_type: 'balance_reminder', is_active: true, config: { line_recipients: [{ id: 'G-acc', channel_id: 'ch-team' }] } }],
      line_channels: [{ id: 'ch-team', channel_access_token: 'tok', channel_secret: 's' }],
      settings: [{ handover_notification_group_id: null }],
      notification_recipient_groups: [],
    });
  };

  seed('reserved', [{ id: 'e1', booking_id: 'b1', seq: 'A', title: '舊的', amount: 100, voided_at: '2026-10-01' }]);
  let r = await addExtraCharges('b1', [{ title: '烤肉用具租借', amount: 800 }, { title: '', amount: '' }, { title: '延遲退房', amount: '500', internal_note: '管家說 13 點才走' }], 'staff@x', false);
  const rows = (__db.booking_extra_charges || []).filter((x: any) => x.id !== 'e1');
  t('後端｜空白列略過、A 已作廢也不回收 → B、C', r.status === 200 && rows.map((x: any) => x.seq).join() === 'B,C', { r, rows });
  t('後端｜寫進操作紀錄', (__db.operation_logs || []).some((l: any) => l.action === '新增追加款' && String(l.after?.追加款).includes('K7M2QX-B 烤肉用具租借')));
  t('後端｜尾款還沒收（已預定）→ 不通知會計（會在尾款一起收）', __sent.length === 0, __sent);

  seed('reserved');
  r = await addExtraCharges('b1', [{ title: '烤肉', amount: 800, paid: true }], 'staff@x', false);
  t('後端｜不是會計卻帶「已付」→ 拒絕，一筆都不存', r.status === 403 && !(__db.booking_extra_charges || []).length, r);

  seed('reserved');
  r = await addExtraCharges('b1', [{ title: '烤肉', amount: 800 }, { title: '延遲退房', amount: '0' }], 'staff@x', false);
  t('後端｜其中一列不合格 → 整批不存', r.status === 400 && !(__db.booking_extra_charges || []).length && String(r.body.error).includes('第 2 列'), r);

  seed('cancelled');
  r = await addExtraCharges('b1', [{ title: '烤肉', amount: 800 }], 'staff@x', true);
  t('後端｜已取消的訂單不能加', r.status === 400, r);

  seed('checked_in');
  r = await addExtraCharges('b1', [{ title: '代訂晚餐', amount: 1200 }, { title: '現場租借腳踏車', amount: 300, paid: true }], 'acc@x', true);
  t('後端｜會計新增時可以直接勾已付', (__db.booking_extra_charges || []).find((x: any) => x.seq === 'B')?.is_paid === true && (__db.booking_extra_charges || []).find((x: any) => x.seq === 'B')?.paid_by === 'acc@x');
  const push = __sent.find((s) => s.kind === 'push' && s.to === 'G-acc');
  t('後端｜尾款已收（入住中）有新的未付項目 → 通知會計（尾款提醒的收件人），只列未付的', !!push && push.text.includes('K7M2QX-A 代訂晚餐') && !push.text.includes('腳踏車') && String(r.body.notice).includes('已通知會計'), { sent: __sent, r });

  seed('checked_in');
  r = await addExtraCharges('b1', [{ title: '腳踏車', amount: 300, paid: true }], 'acc@x', true);
  t('後端｜全部都已付 → 不通知', __sent.length === 0, __sent);

  // 26 筆上限
  seed('reserved', [{ id: 'eY', booking_id: 'b1', seq: 'Y', title: 'x', amount: 1 }]);
  r = await addExtraCharges('b1', [{ title: 'a', amount: 1 }, { title: 'b', amount: 1 }], 'staff@x', false);
  t('後端｜超過 Z → 拒絕並說還能加幾項', r.status === 400 && String(r.body.error).includes('1 項'), r);

  // ===== 後端：標已付 =====
  seed('awaiting_balance', [
    { id: 'p1', booking_id: 'b1', seq: 'A', title: '烤肉', amount: 800, is_paid: false, voided_at: null },
    { id: 'p2', booking_id: 'b1', seq: 'B', title: '延遲', amount: 500, is_paid: false, voided_at: null },
    { id: 'p3', booking_id: 'b1', seq: 'C', title: '作廢的', amount: 999, is_paid: false, voided_at: '2026-10-01' },
  ]);
  r = await setExtraChargesPaid('b1', ['p1'], true, 'acc@x');
  t('標已付｜只標指定的那筆', r.body.changed === 1 && __db.booking_extra_charges.find((x: any) => x.id === 'p1').is_paid && !__db.booking_extra_charges.find((x: any) => x.id === 'p2').is_paid, __db.booking_extra_charges);
  r = await setExtraChargesPaid('b1', null, true, 'acc@x');
  t('標已付｜不指定＝所有未付的（作廢的不算）', r.body.changed === 1 && __db.booking_extra_charges.find((x: any) => x.id === 'p2').is_paid && !__db.booking_extra_charges.find((x: any) => x.id === 'p3').is_paid, __db.booking_extra_charges);
  r = await setExtraChargesPaid('b1', ['p1'], false, 'acc@x');
  t('標已付｜可以取消已付', !__db.booking_extra_charges.find((x: any) => x.id === 'p1').is_paid && __db.booking_extra_charges.find((x: any) => x.id === 'p1').paid_by === null);

  // ===== LINE 機器人不會碰追加款 =====
  const webhookSource = readFileSync(join(process.cwd(), 'netlify/functions/line-webhook.ts'), 'utf8');
  t('LINE｜line-webhook 沒有任何讀寫追加款資料表的程式碼（追加款只能人工新增）', !webhookSource.includes('booking_extra_charges'));

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n    ${d.slice(0, 600)}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });

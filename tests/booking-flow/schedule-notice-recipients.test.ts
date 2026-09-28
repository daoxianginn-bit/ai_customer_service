// 排程通知：已預定→待收尾款的通知天數可自訂（轉狀態固定 3 天），收件人可以是角色／個別帳號綁的 LINE。
import { __scheduledTaskTesting, balanceNoticeDaysBefore, notifyPaymentStaff, resolveAccountRecipients } from '../../netlify/functions/scheduled-tasks-run';
import { __reset, __db } from './stubs/supabase';
import { __sent } from './stubs/line';

const { advanceToAwaitingBalance, taiwanTodayIso } = __scheduledTaskTesting;
const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// 後台帳號：u1 會計（綁了 LINE）、u2 會計（沒綁）、u3 會計（停權、有綁）、u4 客服（綁了）、u5 會計兼客服（綁了）
const staff = () => ({
  roles: [{ id: 'r-acc', name: '會計', is_active: true }, { id: 'r-cs', name: '客服', is_active: true }, { id: 'r-old', name: '停用角色', is_active: false }],
  user_roles: [
    { user_id: 'u1', role_id: 'r-acc' }, { user_id: 'u2', role_id: 'r-acc' }, { user_id: 'u3', role_id: 'r-acc' },
    { user_id: 'u4', role_id: 'r-cs' }, { user_id: 'u5', role_id: 'r-acc' }, { user_id: 'u5', role_id: 'r-cs' }, { user_id: 'u4', role_id: 'r-old' },
  ],
  admin_profiles: [
    { id: 'u1', status: 'active', line_user_id: 'L-u1', line_channel_id: 'ch-team' },
    { id: 'u2', status: 'active', line_user_id: null, line_channel_id: null },
    { id: 'u3', status: 'suspended', line_user_id: 'L-u3', line_channel_id: 'ch-team' },
    { id: 'u4', status: 'active', line_user_id: 'L-u4', line_channel_id: 'ch-team' },
    { id: 'u5', status: 'active', line_user_id: 'L-u5', line_channel_id: 'ch-team' },
  ],
  line_channels: [{ id: 'ch-team', channel_access_token: 'tok', channel_secret: 's' }],
});

(async () => {
  // ===== 天數設定 =====
  t('天數｜沒設定＝3（跟轉狀態同一天，既有排程行為不變）', balanceNoticeDaysBefore({}) === 3);
  t('天數｜設 5 就是 5', balanceNoticeDaysBefore({ notice_days_before: 5 }) === 5);
  t('天數｜超出 1～30 或亂填退回 3', [0, 31, -2, 'abc'].every((v) => balanceNoticeDaysBefore({ notice_days_before: v }) === 3));

  // ===== 角色／帳號 → LINE =====
  __reset(staff());
  let r = await resolveAccountRecipients(['r-acc'], []);
  t('收件人｜勾「會計」角色：只有啟用中、有綁 LINE 的會計（u1、u5）', r.map((x) => x.id).sort().join() === 'L-u1,L-u5', r);
  r = await resolveAccountRecipients(['r-old'], []);
  t('收件人｜停用的角色不算', r.length === 0, r);
  r = await resolveAccountRecipients(['r-acc'], ['u4', 'u2']);
  t('收件人｜角色＋個別帳號合併；沒綁 LINE 的個別帳號收不到', r.map((x) => x.id).sort().join() === 'L-u1,L-u4,L-u5', r);
  r = await resolveAccountRecipients(['r-acc', 'r-cs'], ['u5']);
  t('收件人｜同一人被多個條件選到只算一次', r.filter((x) => x.id === 'L-u5').length === 1, r);

  // ===== 已預定→待收尾款：通知天數 =====
  const today = taiwanTodayIso();
  const seedBookings = () => [
    { id: 'b-conv', order_number: 'A1', name: '要轉狀態的', status: 'reserved', checkin_date: addDays(today, 3) },
    { id: 'b-res5', order_number: 'A2', name: '五天後已預定', status: 'reserved', checkin_date: addDays(today, 5) },
    { id: 'b-bal5', order_number: 'A3', name: '五天後待收尾款', status: 'awaiting_balance', checkin_date: addDays(today, 5) },
    { id: 'b-paid5', order_number: 'A4', name: '五天後尾款已收', status: 'awaiting_checkin', checkin_date: addDays(today, 5) },
  ];
  const run = async (config: Record<string, any>) => {
    __sent.length = 0;
    __reset({ ...staff(), bookings: seedBookings(), message_variables: [{ variable_name: '姓名', source: 'booking', field_key: 'name', display_order: 1 }], operation_logs: [], line_groups: [] });
    return advanceToAwaitingBalance(config, {});
  };

  let res = await run({ notice_template: '尾款未收：[姓名]', role_recipients: ['r-acc'], notice_days_before: 5 });
  const push5 = __sent.find((s) => s.kind === 'push');
  t('5 天｜轉狀態還是固定 3 天（只有入住日 3 天後的那筆轉）', __db.bookings.find((b: any) => b.id === 'b-conv').status === 'awaiting_balance' && __db.bookings.find((b: any) => b.id === 'b-res5').status === 'reserved', __db.bookings);
  t('5 天｜通知的是入住日 5 天後、尾款還沒收的（已預定＋待收尾款），尾款已收的不算', !!push5 && push5.text.includes('五天後已預定') && push5.text.includes('五天後待收尾款') && !push5.text.includes('尾款已收') && !push5.text.includes('要轉狀態的'), { push5, res });
  t('5 天｜發給會計角色綁的 LINE（u1、u5），沒綁的、停權的不發', __sent.filter((s) => s.kind === 'push').map((s) => s.to).sort().join() === 'L-u1,L-u5', __sent);

  res = await run({ notice_template: '尾款未收：[姓名]', role_recipients: ['r-acc'] });
  const push3 = __sent.find((s) => s.kind === 'push');
  t('沒設天數｜跟以前一樣：通知剛轉成待收尾款的那批（入住 3 天後）', !!push3 && push3.text.includes('要轉狀態的') && !push3.text.includes('五天後'), { push3, res });

  __sent.length = 0;
  __reset({ ...staff(), bookings: [{ id: 'x', status: 'reserved', name: '五天後', checkin_date: addDays(today, 5) }], message_variables: [{ variable_name: '姓名', source: 'booking', field_key: 'name', display_order: 1 }], operation_logs: [], line_groups: [] });
  res = await advanceToAwaitingBalance({ notice_template: '提醒 [姓名]', account_recipients: ['u4'], notice_days_before: 5 }, {});
  t('今天沒有要轉的訂單，通知照樣檢查並發送', res.ok && res.summary.includes('沒有需要轉為待收尾款') && __sent.some((s) => s.to === 'L-u4' && s.text.includes('五天後')), { res, sent: __sent });

  res = await run({ notice_template: '', role_recipients: [] });
  t('沒設通知內容｜只轉狀態、不發訊息', __sent.length === 0 && res.ok, { res, sent: __sent });

  // ===== 追加款通知會計也吃得到角色收件人 =====
  __sent.length = 0;
  __reset({ ...staff(), scheduled_tasks: [{ task_type: 'balance_reminder', is_active: true, config: { role_recipients: ['r-acc'] } }], settings: [{}], notification_recipient_groups: [], line_groups: [] });
  const notice = await notifyPaymentStaff('新增追加款');
  t('追加款｜尾款提醒排程勾了會計角色 → 會計們收到', notice.includes('已通知會計') && __sent.map((s) => s.to).sort().join() === 'L-u1,L-u5', { notice, sent: __sent });

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n    ${d.slice(0, 700)}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });

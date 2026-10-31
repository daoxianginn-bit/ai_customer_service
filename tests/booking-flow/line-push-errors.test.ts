// 入住密碼推播：LINE 回 400 時要看得出原因；LINE 聯絡人存成暱稱等無效值時，在送出前就擋下、講清楚。
import { isLineUserId, lineErrorDetail } from '../../src/lib/lineErrors';
import { __scheduledTaskTesting } from '../../netlify/functions/scheduled-tasks-run';
import { __reset } from './stubs/supabase';
import { __sent, __failPushTo } from './stubs/line';

const { checkinNotice, taiwanTodayIso } = __scheduledTaskTesting;
const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const VALID = 'U0123456789abcdef0123456789abcdef';
const VALID2 = 'Ufedcba9876543210fedcba9876543210';
// 舊版 Client（axios）丟出的錯誤長這樣：訊息只有 status code，原因在 originalError.response.data
const axiosError = (status: number, data: any) => Object.assign(new Error(`Request failed with status code ${status}`), {
  statusCode: status, originalError: { response: { status, data } },
});

(async () => {
  // ===== ID 格式 =====
  t('ID｜U 開頭 32 碼十六進位才算', isLineUserId(VALID) && isLineUserId(` ${VALID} `));
  t('ID｜暱稱、打到一半、群組 ID 都不算', !isLineUserId('陳小姐') && !isLineUserId('U0123') && !isLineUserId('C0123456789abcdef0123456789abcdef') && !isLineUserId('') && !isLineUserId(null));

  // ===== 讀出 LINE 真正的原因 =====
  let d = lineErrorDetail(axiosError(400, { message: "The property, 'to', in the request body is invalid (line: -, column: -)" }));
  t('錯誤｜收件人無效：判斷得出來，訊息不再只有 status code', d.status === 400 && d.invalidRecipient && d.message.includes("'to'"), d);
  d = lineErrorDetail(axiosError(400, { message: 'The request body has 1 error(s)', details: [{ message: 'Length must be between 0 and 5000', property: 'messages[0].text' }] }));
  t('錯誤｜訊息太長：帶出欄位與原因，不誤判成收件人問題', !d.invalidRecipient && d.message.includes('messages[0].text') && d.message.includes('5000'), d);
  d = lineErrorDetail(Object.assign(new Error('x'), { status: 400, body: JSON.stringify({ message: "The property, 'to', in the request body is invalid" }) }));
  t('錯誤｜新版 fetch 錯誤格式也讀得到', d.invalidRecipient, d);
  d = lineErrorDetail(new Error('socket hang up'));
  t('錯誤｜沒有回應內文時退回原本的錯誤訊息', d.status === null && d.message === 'socket hang up', d);

  // ===== 入住通知（含入住密碼）排程 =====
  const today = taiwanTodayIso();
  const run = async (bookings: any[]) => {
    __sent.length = 0;
    __reset({
      bookings: bookings.map((b) => ({ status: 'awaiting_checkin', checkin_date: today, check_in_password: '1234', ...b })),
      custom_message_templates: [{ id: 'tpl', body: '您好 [姓名]，入住密碼 [入住密碼]' }],
      line_channels: [{ id: 'ch', role: 'customer', is_active: true, display_order: 1, channel_access_token: 'tok', channel_secret: 's' }],
      message_variables: [{ variable_name: '姓名', source: 'booking', field_key: 'name', display_order: 1 }],
    });
    return checkinNotice({ template_id: 'tpl' }, {});
  };

  let res = await run([{ id: 'b1', order_number: 'A001', name: '王先生', line_user_id: VALID }]);
  t('排程｜正常：密碼送到、排程成功', res.ok && __sent.length === 1 && __sent[0].text.includes('1234'), { res, __sent });

  res = await run([{ id: 'b1', order_number: 'A001', name: '王先生', line_user_id: VALID }, { id: 'b2', order_number: 'A002', name: '陳小姐', line_user_id: '陳小姐' }]);
  t('排程｜LINE ID 存成暱稱：不去打 LINE，結果寫出是哪張單、存了什麼', __sent.length === 1 && res.summary.includes('A002') && res.summary.includes('「陳小姐」'), { res, __sent });
  t('排程｜有人密碼沒送到 → 排程標成失敗（執行紀錄看得到）', !res.ok, res);

  __failPushTo.set(VALID2, axiosError(400, { message: "The property, 'to', in the request body is invalid" }));
  res = await run([{ id: 'b3', order_number: 'A003', name: '林小姐', line_user_id: VALID2 }]);
  __failPushTo.clear();
  t('排程｜LINE 拒收：結果寫明是拒收，不是只有「失敗 1 位」', !res.ok && res.summary.includes('A003') && res.summary.includes('LINE 拒收'), res);

  res = await run([{ id: 'b4', order_number: 'A004', name: '電話客', line_user_id: '' }]);
  t('排程｜本來就沒有 LINE 的電話訂房不算排程失敗', res.ok && res.summary.includes('沒有 LINE 聯絡人'), res);

  let ok = true;
  for (const [k, v, dd] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (dd ? `\n    ${dd.slice(0, 700)}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });

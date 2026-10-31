// 待入住→入住中（含洗滌單）排程：尾款還沒勾掉的訂單也要上洗滌單；洗滌單有沒有發一律寫進執行結果；
// 每次排程執行（不論有沒有改到訂單）都在「執行紀錄」留一筆。
import { __scheduledTaskTesting } from '../../netlify/functions/scheduled-tasks-run';
import { LAUNDRY_SHEET_STATUSES } from '../../src/lib/bookingStatus';
import { STAGES } from '../../src/features/process/processStages';
import { __reset, __db } from './stubs/supabase';
import { __sent } from './stubs/line';

const { advanceToCheckedIn, taiwanTodayIso, rawHandler } = __scheduledTaskTesting;
const checks: [string, boolean, string?][] = [];
const t = (name: string, ok: boolean, detail?: unknown) => checks.push([name, ok, ok ? undefined : JSON.stringify(detail)]);

const laundryConfig = { notice_template: '洗滌單 [日期]\n[布巾明細(簡稱)]', line_recipients: [{ id: 'G-laundry', channel_id: 'ch-team' }] };

(async () => {
  const today = taiwanTodayIso();
  const seed = (bookings: any[], extra: Record<string, any[]> = {}) => {
    __sent.length = 0;
    __reset({
      bookings,
      booking_linen_usage: bookings.map((b, i) => ({ booking_id: b.id, linen_item_id: 'li-sheet', quantity: i + 1 })),
      linen_items: [{ id: 'li-sheet', category: '床包', spec: '雙人', short_name: '床包(雙)', display_order: 1 }],
      line_channels: [{ id: 'ch-team', channel_access_token: 'tok', channel_secret: 's' }],
      line_groups: [], message_variables: [], operation_logs: [], roles: [], user_roles: [], admin_profiles: [],
      ...extra,
    });
  };

  // ===== 房務能填布巾的狀態，洗滌單都要涵蓋 =====
  const linenStage = STAGES.find((s) => s.key === 'linen')!;
  t('狀態清單｜房務「洗滌清單」開放的每個狀態都會上洗滌單', linenStage.statuses.every((s) => LAUNDRY_SHEET_STATUSES.includes(s)), { linen: linenStage.statuses, laundry: LAUNDRY_SHEET_STATUSES });

  // ===== 尾款沒勾掉、停在待收尾款度過入住日 =====
  seed([{ id: 'b-bal', order_number: 'A1', name: '尾款未勾', status: 'awaiting_balance', checkin_date: today }]);
  let res = await advanceToCheckedIn(laundryConfig, {});
  const push = __sent.find((s) => s.kind === 'push');
  t('待收尾款｜不會被轉成入住中（收尾款是人工關卡）', __db.bookings[0].status === 'awaiting_balance', __db.bookings);
  t('待收尾款｜但洗滌單照樣發，布巾數量有算進去', !!push && push.to === 'G-laundry' && push.text.includes('床包(雙)：1'), { push, res });
  t('待收尾款｜執行結果寫出洗滌單已發送', res.ok && res.summary.includes('洗滌單已發送'), res);

  // ===== 混合：剛轉入住中＋OTA＋已預定，加總在同一張單 =====
  seed([
    { id: 'b-1', name: '待入住', status: 'awaiting_checkin', checkin_date: today },
    { id: 'b-2', name: 'OTA', status: 'external_synced', checkin_date: today },
    { id: 'b-3', name: '已預定', status: 'reserved', checkin_date: today },
    { id: 'b-x', name: '已取消', status: 'cancelled', checkin_date: today },
  ]);
  res = await advanceToCheckedIn(laundryConfig, {});
  const mixed = __sent.find((s) => s.kind === 'push');
  // 數量 1+2+3=6，取消那筆（4）不算
  t('混合｜待入住＋OTA＋已預定加總（取消的不算）', !!mixed && mixed.text.includes('床包(雙)：6'), { mixed, res });
  t('混合｜只有待入住那筆被轉成入住中', __db.bookings.find((b: any) => b.id === 'b-1').status === 'checked_in' && __db.bookings.find((b: any) => b.id === 'b-3').status === 'reserved', __db.bookings);

  // ===== 沒發洗滌單時，執行結果要說為什麼 =====
  seed([{ id: 'b-1', name: '待入住', status: 'awaiting_checkin', checkin_date: today }]);
  res = await advanceToCheckedIn({}, {});
  t('沒設定｜結果寫明洗滌單未設定（不再沉默）', res.ok && res.summary.includes('洗滌單未設定'), res);

  seed([]);
  res = await advanceToCheckedIn(laundryConfig, {});
  t('沒訂單｜結果寫明今日沒有入住的訂單', res.ok && res.summary.includes('今日沒有入住的訂單'), res);

  seed([{ id: 'b-1', name: '待入住', status: 'awaiting_checkin', checkin_date: today }], { line_channels: [] });
  res = await advanceToCheckedIn(laundryConfig, {});
  t('推播全失敗｜排程標成失敗，才會被注意到', !res.ok && res.summary.includes('洗滌單未發送'), res);

  // ===== 每次執行都寫進執行紀錄 =====
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  seed([], {
    settings: [{}],
    scheduled_tasks: [
      { id: 't-notice', name: '入住前提醒', task_type: 'checkin_reminder_notice', is_active: true, recurrence: 'daily', run_at_time: '09:00', next_run_at: pastIso, config: {} },
      { id: 't-bad', name: '壞掉的排程', task_type: 'no_such_type', is_active: true, recurrence: 'daily', run_at_time: '09:00', next_run_at: pastIso, config: {} },
    ],
  });
  await rawHandler({} as any, {} as any);
  const runLogs = __db.operation_logs.filter((l: any) => l.feature === '排程管理');
  const noticeLog = runLogs.find((l: any) => l.target === '入住前提醒');
  const badLog = runLogs.find((l: any) => l.target === '壞掉的排程');
  t('執行紀錄｜沒改到任何訂單的通知型排程也留一筆', !!noticeLog && noticeLog.action === '排程執行' && noticeLog.level === 'info' && String(noticeLog.after?.結果 || '').length > 0 && noticeLog.after?.觸發方式 === '自動排程', runLogs);
  t('執行紀錄｜失敗的執行記成 error，附上原因', !!badLog && badLog.action === '排程執行失敗' && badLog.level === 'error' && String(badLog.error_message).includes('未知的排程類型'), runLogs);

  let ok = true;
  for (const [k, v, d] of checks) { console.log((v ? '✓ ' : '✗ ') + k + (d ? `\n    ${d.slice(0, 700)}` : '')); if (!v) ok = false; }
  console.log(`\n${checks.filter((x) => x[1]).length}/${checks.length} passed`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });

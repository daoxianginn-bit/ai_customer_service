import LogsPage from '../../features/logs/LogsPage';
import { LOG_FEATURES } from '../../lib/operationLog';

// 自動化排程 → 執行紀錄（V2 §63）：每次排程執行的結果。資料來自 operation_logs（排程執行後寫入），
// 不另建執行歷史表（第一階段不動 DB）。
export default function AutomationHistory() {
  return <LogsPage preset={{ feature: LOG_FEATURES.scheduledTask }} title="執行紀錄" description="每次排程執行的時間、處理結果與錯誤。" />;
}

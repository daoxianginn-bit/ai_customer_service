import OperationLogs from '../OperationLogs';

// 系統管理 → 錯誤紀錄（V2 §84）：獨立於操作紀錄，只列 level=error。
export default function ErrorLogs() {
  return <OperationLogs preset={{ level: 'error' }} title="錯誤紀錄" description="系統發生過的錯誤：AI 呼叫、LINE、OTA 同步、行事曆、排程、後端 API。含狀態碼與錯誤訊息。" />;
}

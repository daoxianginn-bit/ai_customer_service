// 通知名單的型別定義。實際查詢邏輯在各自的 Netlify function 裡各自 select
// （scheduled-tasks-run.ts／custom-messages.ts），這裡只放共用型別，避免前後端對欄位認知不一致。
export interface NotificationRecipientGroup {
  id: string;
  channel_id: string;
  name: string;
  line_user_ids: string[];
}

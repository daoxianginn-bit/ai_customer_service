# 系統分析訪談結論（2026-08-13）

依真實情境與假設性問題訪談後，確認以下項目。標示「維持現況」的不需要改動，其餘為確認要做的異動。

**實作狀態：全部 12 項（含未列在原表格的第 13、14 項）都已經寫進程式碼。**
本次用到的新欄位已經併入 [supabase_schema.sql](supabase_schema.sql)（整份可重複執行，既有專案升級就整份重新貼上執行一次即可，
不用另外找 migration 檔案），執行完再到「帳號管理」頁面用現有的管理員帳號點「將我設為主帳號」，第 9、12 項才會生效。

主帳號目前先簡單存在 `settings.primary_admin_id`；schema 裡其實已經有一張預留給角色權限用、但目前完全沒接上的
`admin_profiles` 表（`role` 欄位）。之後如果要做更完整的多角色管理，應該改接到那張表，這裡先解決「主帳號不能被刪」
這個當下需求，不動既有的、還沒接上的設計。

## 1. 群發訊息不該改訂單狀態
- 現況：[CustomMessageSending.tsx](src/pages/CustomMessageSending.tsx:88) 有勾選框「發送後將訂單改為已預定」
- 異動：**移除**這個勾選框與對應邏輯（[custom-messages.ts](netlify/functions/custom-messages.ts) 的 `markReserved` 相關程式碼）。發訊息與改訂單狀態完全拆開，改狀態一律回訂單管理頁做。

## 2. 缺房／滿房回覆邏輯
- 現況：[line-webhook.ts:1170-1327](netlify/functions/line-webhook.ts:1170) 偵測到房型排不出來或日期衝突時，轉 `pending_manual_conflict`，回覆客人已請真人核實
- **維持現況，不用改**

## 3. 訂金匯款截止時間
- 現況：[line-webhook.ts:609-616](netlify/functions/line-webhook.ts:609) 按天固定收班時間點（18:00前算今天21:00截止，之後算明天21:00截止）
- 異動：改成**送出後 N 小時倒數**，N 做成後台系統參數（`settings` 表新增欄位，後台可調整）

## 4. 真人轉接逾時計時器
- 現況：[line-webhook.ts:120-169](netlify/functions/line-webhook.ts:120) `last_human_interaction` 只在轉接觸發當下寫入一次，之後不論客人再傳幾則訊息都不會更新，固定 N 分鐘後下一則訊息就自動轉回 AI
- 異動：**客人每次傳訊息都要重置這個計時器**（滾動計時），變成「持續互動就不會逾時，真正沒互動 N 分鐘才轉回 AI」
- 已知限制：無法偵測真人客服本人在 LINE 官方帳號 App 裡是否還在處理（客服是直接用官方 App 回覆，不透過後台），只能靠客人是否有再傳訊息判斷——**此限制可接受**

## 5. 知識庫回答邊界
- 現況：[line-webhook.ts:198](netlify/functions/line-webhook.ts:198), [1595-1611](netlify/functions/line-webhook.ts:1595) system_prompt 預設無限制，AI 可能用通用知識回答知識庫沒有的問題
- 異動：system_prompt 要**嚴格限制**——知識庫沒有寫到的問題一律回「不知道」或建議聯繫真人
- 補充確認：這個「建議轉真人」**只是回覆文字**，不會觸發跟關鍵字一樣的完整轉真人流程（不寫 `is_human_mode=true`、不寫 `handover_logs`、不通知客服）。純文字建議，後台不會知道發生過這件事。

## 6. AI 呼叫失敗處理
- 現況：[line-webhook.ts:201-212](netlify/functions/line-webhook.ts:201) AI 呼叫失敗時把原始錯誤訊息（`❌ AI 錯誤：...`）直接回覆給客人，客服不會被通知
- 異動：改成**友善制式回覆**（不透露技術錯誤內容）＋**自動推播通知客服人員**（`agent_user_ids`）。不用自動切換該客人的真人模式。

## 7. 訂房流程 session 逾時
- 現況：[line-webhook.ts:225-233, 318](netlify/functions/line-webhook.ts:225) `in_flow`/`awaiting_confirmation` 階段 30 分鐘無回覆，session 悄悄消失，無任何通知
- 異動：session 過期時，客人下次傳訊息進來，系統要**主動回覆一句提示**（例如「不好意思，這次詢問已逾時，請重新輸入」），不能悄悄當成一般訊息處理

## 8. 保證金依房間數／包棟調整
- 現況：[BookingManagement.tsx:139](src/pages/BookingManagement.tsx:139), [line-webhook.ts:1200](netlify/functions/line-webhook.ts:1200) `security_deposit_amount` 是全域單一數字（預設 3000），不分訂 1 間房或包棟
- 異動：改成**個別房型可各自設定保證金金額**；包棟另外設一個獨立的固定數字（不是用房間金額加總算出來，是自己另外定的值）

## 9. 管理員帳號需要主帳號保護
- 現況：[delete-admin.ts](netlify/functions/delete-admin.ts), [invite-admin.ts](netlify/functions/invite-admin.ts) 完全沒有角色概念，任何登入的管理員都能邀請/刪除其他任何管理員（除了不能刪自己）
- 異動：需要建立**角色分級機制**，至少要有一個「主帳號」不能被其他管理員刪除
- 關聯：這個主帳號角色同時是第 11 項「客戶資料清除功能」的執行權限門檻

## 10. 對話紀錄保留期
- 現況：[cleanup-conversations.ts:11](netlify/functions/cleanup-conversations.ts:11) 預設 3 天後永久刪除 `conversations` 表資料
- **維持現況，故意設短以保護隱私，不用改**

## 11. 行銷訊息退訂標記
- 現況：[custom-messages.ts] 沒有任何退訂機制，客人只能整個封鎖 LINE 官方帳號才能停止收到促銷群發（同時失去客服管道）
- 異動：新增「**不接收行銷訊息**」標記（存在客戶資料或訂單上），客製訊息發送頁篩選名單時要能排除掉這些人

## 12. 客戶資料清除功能
- 現況：[CustomerDirectory.tsx] 沒有「清除此客人所有資料」的功能，個資法要求下只能手動上 Supabase 後台逐表刪除
- 異動：後台新增清除客戶資料功能，**只有主帳號（第 9 項的角色分級）能執行**，且**執行前要二次確認**

## 13. 訂房流程中途被異動，客人被已讀不回
- 現況：[line-webhook.ts:918-927](netlify/functions/line-webhook.ts:918) 客人流程進行到一半時，若後台異動了該流程的步驟（刪除/重排導致下一步找不到對應設定），系統會直接清空 session、完全不回覆客人，客人的訊息石沉大海
- 異動：偵測到這種「流程對不上」的狀況時，**自動觸發完整轉真人流程**（跟第 4 項關鍵字轉真人一樣：`is_human_mode=true`、寫入 `handover_logs`、推播通知客服），讓真人接手，而不是silently吞掉

## 14. 多個流程觸發條件重疊
- 現況：[line-webhook.ts:174-175](netlify/functions/line-webhook.ts:174) `activeFlows.find(...)` 依 `display_order` 排序選第一個符合觸發條件的流程，如果兩個流程的觸發規則重疊，後台完全沒有警告
- 異動：**邏輯維持現狀**（按 display_order 選第一個），但「LINE 自定訊息流程」編輯頁儲存新/改流程時，如果偵測到觸發條件跟其他已啟用流程重疊，**要跳出提示**讓管理員知道、自己決定要不要調整

---

## 未深入的頁面
訊息變數維護、房型/空間維護 CRUD、房況行事曆——結構單純的資料維護頁面，訪談時判斷出現隱藏行為落差的機率較低，未逐一深挖。如果之後想針對這些頁面也做同樣的訪談，可以再進行。

-- ========================================================================
-- 系統分析訪談結論（2026-08-13，詳見 INTERVIEW_FINDINGS.md）新增的資料庫欄位
-- 都用 ADD COLUMN IF NOT EXISTS，可以重複執行不會出錯，也不影響既有資料。
-- 在 Supabase SQL Editor 貼上執行一次即可。
-- ========================================================================

-- 第 3 項：訂金匯款截止時間改成「送出後 N 小時」，N 為後台可調整參數（預設 10 小時）
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS payment_deadline_hours INTEGER DEFAULT 10;

-- 第 8 項：保證金依房型/包棟調整——房型各自設定金額，包棟另外設一個固定數字
ALTER TABLE public.room_types ADD COLUMN IF NOT EXISTS security_deposit NUMERIC DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whole_house_security_deposit NUMERIC DEFAULT 3000;

-- 第 9 項：管理員主帳號（不能被其他管理員刪除，也是第 12 項清除客戶資料的權限門檻）
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS primary_admin_id UUID;

-- 第 11 項：客戶「不接收行銷訊息」標記（客戶資料頁維護，客製訊息發送時排除）
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN DEFAULT false;

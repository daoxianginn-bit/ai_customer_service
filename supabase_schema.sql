-- ============================================================
-- AI 客服系統完整資料庫腳本（含訂房功能）
-- 全新 Supabase 專案：整份貼到 SQL Editor 執行一次即可。
-- 既有專案升級：一樣整份重新執行，全部語句都用 IF NOT EXISTS / DROP+CREATE，可重複執行不會出錯。
-- ============================================================

-- 1. 設定表
CREATE TABLE IF NOT EXISTS public.settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_ai_enabled BOOLEAN DEFAULT true,
    active_ai TEXT DEFAULT 'gpt',
    gpt_api_key TEXT,
    gpt_model_name TEXT DEFAULT 'gpt-4.1-mini',
    gpt_temperature FLOAT DEFAULT 0.7,
    gpt_max_tokens INTEGER DEFAULT 2000,
    gpt_reasoning_effort TEXT DEFAULT 'none',
    gpt_verbosity TEXT DEFAULT 'medium',
    gemini_api_key TEXT,
    gemini_model_name TEXT DEFAULT 'gemini-pro',
    gemini_temperature FLOAT DEFAULT 1.0,
    gemini_max_tokens INTEGER DEFAULT 2000,
    gemini_thinking_level TEXT DEFAULT 'high',
    system_prompt TEXT DEFAULT '你是一個專業的客服助手。',
    reference_text TEXT DEFAULT '',
    reference_file_url TEXT DEFAULT '',
    line_channel_access_token TEXT,
    line_channel_secret TEXT,
    handover_keywords TEXT DEFAULT '真人,客服,人工',
    handover_timeout_minutes INTEGER DEFAULT 30,
    agent_user_ids TEXT DEFAULT '',
    conversation_retention_days INTEGER DEFAULT 3
);

-- 2. 用戶狀態表
CREATE TABLE IF NOT EXISTS public.user_states (
    line_user_id TEXT PRIMARY KEY,
    nickname TEXT,
    is_human_mode BOOLEAN DEFAULT false,
    last_human_interaction TIMESTAMP WITH TIME ZONE,
    last_ai_reset_at TIMESTAMP WITH TIME ZONE,
    last_event_id TEXT,
    booking_session TEXT -- 訂房對話流程：進行中的訂房詢問狀態（JSON），null＝目前沒有進行中的詢問
);

-- 3. 事件去重表 (防止 LINE Webhook 重試導致重複回覆)
CREATE TABLE IF NOT EXISTS public.processed_events (
    event_id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 4. 知識庫項目（可新增多筆文字或檔案，AI 回覆時參考所有已啟用項目）
CREATE TABLE IF NOT EXISTS public.knowledge_base_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL CHECK (type IN ('text', 'file')),
    title TEXT NOT NULL,
    content TEXT,
    file_url TEXT,
    file_name TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 5. 真人客服歷史紀錄（append-only，轉回 AI 時寫入一筆，不覆蓋）
CREATE TABLE IF NOT EXISTS public.handover_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_user_id TEXT NOT NULL,
    nickname TEXT,
    triggered_keyword TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    resolved_by TEXT,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed'))
);
CREATE INDEX IF NOT EXISTS idx_handover_logs_user ON public.handover_logs(line_user_id, started_at DESC);

-- 6. 完整對話紀錄（預設保留 3 天，由排程功能清除，天數見 settings.conversation_retention_days）
CREATE TABLE IF NOT EXISTS public.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_user_id TEXT NOT NULL,
    nickname TEXT,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'ai_gpt', 'ai_gemini', 'human_agent', 'system')),
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON public.conversations(line_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON public.conversations(created_at);

-- 7. 管理員個人資料（銜接 Supabase Auth 帳號，之後角色權限掛在這）
CREATE TABLE IF NOT EXISTS public.admin_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    role TEXT DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 8. 訂房功能：房型／定價／包棟方案／加人規則／日期區間／促銷
-- 設計原則：定價一律用「房型/方案 + tier 文字欄位」正規化存放，之後新增定價級距只需要多一筆資料，不需要改表結構。

CREATE TABLE IF NOT EXISTS public.room_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    floor TEXT DEFAULT '',
    capacity INTEGER NOT NULL,
    max_extra_persons INTEGER DEFAULT 0,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.room_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (room_type_id, tier)
);

CREATE TABLE IF NOT EXISTS public.room_extra_person_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (room_type_id, tier)
);

CREATE TABLE IF NOT EXISTS public.whole_house_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occupancy INTEGER NOT NULL,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whole_house_package_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id UUID NOT NULL REFERENCES public.whole_house_packages(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (package_id, tier)
);

CREATE TABLE IF NOT EXISTS public.whole_house_package_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id UUID NOT NULL REFERENCES public.whole_house_packages(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    UNIQUE (package_id, room_type_id)
);

CREATE TABLE IF NOT EXISTS public.whole_house_extra_person_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_type TEXT NOT NULL, -- 'no_extra_room'（不多開房）/ 'extra_room'（多開房）
    rule_label TEXT DEFAULT '',
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (rule_type, tier)
);

CREATE TABLE IF NOT EXISTS public.promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    discount_percent NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.booking_date_ranges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    range_type TEXT NOT NULL, -- '旺季' / '連假'
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    label TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 訂房相關的 settings 欄位（既有專案升級用；新專案 CREATE TABLE 時不含這些，靠這幾行 ALTER 補齊）
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS booking_whole_house_enabled BOOLEAN DEFAULT true;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS consecutive_stay_discount_cleaning NUMERIC DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS consecutive_stay_discount_no_cleaning NUMERIC DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS consecutive_stay_default_option TEXT DEFAULT 'no_cleaning';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS peak_season_weekday_tier TEXT DEFAULT 'peak';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS booking_trigger_keywords TEXT DEFAULT '我要訂房,訂房';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS quote_sheet_id TEXT DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS quote_sheet_gid TEXT DEFAULT '0';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS booking_welcome_message TEXT DEFAULT '🏡 LINE AI 訂房
若您想先詢問空房或報價，請直接回覆以下資訊，我們會協助您確認：

姓名 :
電話 :
入住日期：
退房日期：
入住人數：
大人小孩：O大O小/O幼(3歲以下)
是否包棟：';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS booking_quote_message TEXT DEFAULT '入住日期：[入住日期]
退房日期：[退房日期]
入住人數：[人數]
是否包棟：[是否包棟]
價格：[總金額]

提醒您，實際空房與價格會依日期、人數與平台狀況為準，
確定訂房請回覆『是』或『否』，或者轉『真人客服』替您服務謝謝 😊';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS booking_confirm_message TEXT DEFAULT '親愛的 [姓名] 您好，感謝您預訂我們的民宿！為您保留的訂房資訊如下：

🔸 入住日期： [入住日期] 15:00 後
🔸 退房日期： [退房日期] 11:00 前
🔸 房型與人數： [是否包棟] / [人數] 位 ([大人小孩])
🔸 訂單總額： [總金額]
🔸 本次需匯訂金： [訂金]

💳 【匯款帳號資訊】
銀行代碼： 808
銀行名稱： 玉山銀行
帳號： 0118979100691

⚠️ 溫馨提醒：
請於 [匯款日時間] 前完成匯款，以利為您保留房間。若逾期未匯款，系統將自動取消訂房，不另行通知喔。
匯款完成後，請回傳「帳號後五碼」或「轉帳明細截圖」，我們查帳無誤後會立即傳送【訂房成功確認信】給您！';
-- 目前生效中的促銷方案：後台選定後，LINE 訂房對話流程會自動套用同一個。放在 promotions 表格之後（要參照其 id）。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS active_promotion_id UUID REFERENCES public.promotions(id) ON DELETE SET NULL;

-- 客製訊息發送：後台自訂的可重複使用訊息範本
CREATE TABLE IF NOT EXISTS public.custom_message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 8.5 動態訂房流程（可新增多組流程，各自有觸發關鍵字與最多 5 個步驟）
-- 每個步驟送出 message_template 給顧客，等顧客回覆後依 fields 定義擷取 1~3 個答案；
-- fields 是 JSON 陣列，每筆 { key, label, quote_field }，quote_field 為
-- 'checkin_date' / 'checkout_date' / 'headcount' / 'whole_house' / null（null＝純收集資訊，不影響算價）。
CREATE TABLE IF NOT EXISTS public.booking_flows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    trigger_keywords TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN DEFAULT true,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.booking_flow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    flow_id UUID NOT NULL REFERENCES public.booking_flows(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    message_template TEXT NOT NULL DEFAULT '',
    fields JSONB NOT NULL DEFAULT '[]',
    UNIQUE (flow_id, step_order)
);

-- 8.6 訂房紀錄（取代 Google「報價」試算表為主要資料來源；仍會盡力鏡射寫入試算表，寫入失敗不影響主流程）
CREATE TABLE IF NOT EXISTS public.bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    line_user_id TEXT NOT NULL,
    flow_id UUID REFERENCES public.booking_flows(id) ON DELETE SET NULL,
    nickname TEXT,
    name TEXT,
    phone TEXT,
    checkin_date DATE,
    checkout_date DATE,
    nights INTEGER,
    headcount INTEGER,
    adults INTEGER,
    kids INTEGER,
    infants INTEGER,
    whole_house BOOLEAN,
    total_amount NUMERIC,
    deposit NUMERIC,
    status TEXT NOT NULL DEFAULT 'inquiring' CHECK (status IN ('inquiring', 'pending_confirmation', 'confirmed', 'cancelled', 'pending_manual_conflict')),
    collected_answers JSONB DEFAULT '{}',
    sheet_row_number INTEGER,
    reserved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON public.bookings(line_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookings_confirmed_dates ON public.bookings(checkin_date, checkout_date) WHERE status = 'confirmed';

-- 8.7 個別房型每晚實際使用紀錄（顧客確認訂房當下才寫入），供「不同顧客訂到同一天/同房型」衝突檢查用。
CREATE TABLE IF NOT EXISTS public.booking_room_nights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
    night_date DATE NOT NULL,
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_booking_room_nights_lookup ON public.booking_room_nights(night_date, room_type_id);

-- 9. 啟用 RLS（僅限已登入使用者存取，用 DROP + CREATE 讓整份腳本可重複執行）
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_base_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handover_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_extra_person_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_package_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_package_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_extra_person_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_date_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_flow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_room_nights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow Auth Access" ON public.settings;
CREATE POLICY "Allow Auth Access" ON public.settings FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access States" ON public.user_states;
CREATE POLICY "Allow Auth Access States" ON public.user_states FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access KB" ON public.knowledge_base_items;
CREATE POLICY "Allow Auth Access KB" ON public.knowledge_base_items FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Handover Logs" ON public.handover_logs;
CREATE POLICY "Allow Auth Access Handover Logs" ON public.handover_logs FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Conversations" ON public.conversations;
CREATE POLICY "Allow Auth Access Conversations" ON public.conversations FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Profiles" ON public.admin_profiles;
CREATE POLICY "Allow Auth Access Profiles" ON public.admin_profiles FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Room Types" ON public.room_types;
CREATE POLICY "Allow Auth Access Room Types" ON public.room_types FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Room Pricing" ON public.room_pricing;
CREATE POLICY "Allow Auth Access Room Pricing" ON public.room_pricing FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Room Extra Person Pricing" ON public.room_extra_person_pricing;
CREATE POLICY "Allow Auth Access Room Extra Person Pricing" ON public.room_extra_person_pricing FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access WH Packages" ON public.whole_house_packages;
CREATE POLICY "Allow Auth Access WH Packages" ON public.whole_house_packages FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access WH Package Pricing" ON public.whole_house_package_pricing;
CREATE POLICY "Allow Auth Access WH Package Pricing" ON public.whole_house_package_pricing FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access WH Package Rooms" ON public.whole_house_package_rooms;
CREATE POLICY "Allow Auth Access WH Package Rooms" ON public.whole_house_package_rooms FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access WH Extra Person Rules" ON public.whole_house_extra_person_rules;
CREATE POLICY "Allow Auth Access WH Extra Person Rules" ON public.whole_house_extra_person_rules FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Promotions" ON public.promotions;
CREATE POLICY "Allow Auth Access Promotions" ON public.promotions FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Date Ranges" ON public.booking_date_ranges;
CREATE POLICY "Allow Auth Access Booking Date Ranges" ON public.booking_date_ranges FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Custom Message Templates" ON public.custom_message_templates;
CREATE POLICY "Allow Auth Access Custom Message Templates" ON public.custom_message_templates FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Flows" ON public.booking_flows;
CREATE POLICY "Allow Auth Access Booking Flows" ON public.booking_flows FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Flow Steps" ON public.booking_flow_steps;
CREATE POLICY "Allow Auth Access Booking Flow Steps" ON public.booking_flow_steps FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Bookings" ON public.bookings;
CREATE POLICY "Allow Auth Access Bookings" ON public.bookings FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Room Nights" ON public.booking_room_nights;
CREATE POLICY "Allow Auth Access Booking Room Nights" ON public.booking_room_nights FOR ALL USING (auth.role() = 'authenticated');

-- 10. 初始資料
INSERT INTO public.settings (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM public.settings);

-- 11. 儲存空間權限 (Storage)：知識庫檔案上傳用
INSERT INTO storage.buckets (id, name, public) VALUES ('knowledge_base', 'knowledge_base', true) ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Allow Public Select" ON storage.objects;
CREATE POLICY "Allow Public Select" ON storage.objects FOR SELECT TO public USING (bucket_id = 'knowledge_base');
DROP POLICY IF EXISTS "Allow Auth Insert" ON storage.objects;
CREATE POLICY "Allow Auth Insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'knowledge_base');
DROP POLICY IF EXISTS "Allow Auth Update" ON storage.objects;
CREATE POLICY "Allow Auth Update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'knowledge_base');
DROP POLICY IF EXISTS "Allow Auth Delete" ON storage.objects;
CREATE POLICY "Allow Auth Delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'knowledge_base');

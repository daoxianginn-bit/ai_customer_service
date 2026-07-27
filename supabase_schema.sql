-- 1. 設定表
CREATE TABLE IF NOT EXISTS public.settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    is_ai_enabled BOOLEAN DEFAULT true,
    active_ai TEXT DEFAULT 'gpt',
    -- GPT Settings
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
    -- Google 試算表知識庫 (意圖比對 + 一般 QA 來源)
    knowledge_sheet_id TEXT DEFAULT '',
    knowledge_sheet_gid TEXT DEFAULT '0',
    line_channel_access_token TEXT,
    line_channel_secret TEXT,
    handover_keywords TEXT DEFAULT '真人,客服,人工',
    handover_timeout_minutes INTEGER DEFAULT 30,
    agent_user_ids TEXT DEFAULT '',
    -- 已由 LINE 官方帳號原生「自動回應/圖文選單」處理過的訊息，AI 收到會直接略過不重複回覆
    skip_ai_keywords TEXT DEFAULT ''
);

-- 去重記錄表 (防止重試導致狀態回滾)
CREATE TABLE IF NOT EXISTS public.processed_events (
    event_id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 2. 用戶狀態表
CREATE TABLE IF NOT EXISTS public.user_states (
    line_user_id TEXT PRIMARY KEY,
    nickname TEXT,
    is_human_mode BOOLEAN DEFAULT false,
    last_human_interaction TIMESTAMP WITH TIME ZONE,
    last_ai_reset_at TIMESTAMP WITH TIME ZONE, -- 新增：記錄手動重設時間
    conversation_history TEXT DEFAULT '[]' -- AI 對話記憶：最近幾輪對話紀錄（JSON 陣列）
);

-- 2.5 訂房功能（Phase 1：房型／定價／包棟方案／加人規則／日期區間）
-- 設計原則：定價一律用「房型/方案 + tier 文字欄位」正規化存放，
-- 之後要新增定價級距（例如「旺季平日」）只需要多一筆資料，不需要改表結構。

-- 房型主檔
CREATE TABLE IF NOT EXISTS public.room_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    floor TEXT DEFAULT '',
    capacity INTEGER NOT NULL,
    display_order INTEGER DEFAULT 0, -- 房型分配演算法會依此順序優先選用（例如同容納人數時優先低樓層）
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 房型 × 定價級距（tier 留空/沒有這筆資料 = 該 tier 不開放個別租房，只能包棟）
CREATE TABLE IF NOT EXISTS public.room_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    tier TEXT NOT NULL, -- 例如：平日／小假日／連假／旺季／定價（純文字，可自由擴充）
    price NUMERIC,
    UNIQUE (room_type_id, tier)
);

-- 包棟方案（依動人數級距，如 10/12/14/16）
CREATE TABLE IF NOT EXISTS public.whole_house_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occupancy INTEGER NOT NULL, -- 該方案基礎可入住人數
    room_combo TEXT DEFAULT '', -- 房型人數搭配說明文字，如「4+4+2」，純顯示用
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 包棟方案 × 定價級距
CREATE TABLE IF NOT EXISTS public.whole_house_package_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id UUID NOT NULL REFERENCES public.whole_house_packages(id) ON DELETE CASCADE,
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (package_id, tier)
);

-- 包棟超過基礎人數時的加人規則（不加床不多開房 / 不加床多開房）
CREATE TABLE IF NOT EXISTS public.whole_house_extra_person_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_type TEXT NOT NULL, -- 'no_extra_room'（不多開房）/ 'extra_room'（多開房），純文字可擴充
    rule_label TEXT DEFAULT '',
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (rule_type, tier)
);

-- 日期區間（旺季／連假），完全由後台維護介面新增/編輯/刪除
CREATE TABLE IF NOT EXISTS public.booking_date_ranges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    range_type TEXT NOT NULL, -- '旺季' / '連假'（純文字，未來可擴充新類型）
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    label TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 3. 啟用 RLS
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_package_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_extra_person_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_date_ranges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow Auth Access" ON public.settings FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access States" ON public.user_states FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access Room Types" ON public.room_types FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access Room Pricing" ON public.room_pricing FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access WH Packages" ON public.whole_house_packages FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access WH Package Pricing" ON public.whole_house_package_pricing FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access WH Extra Person Rules" ON public.whole_house_extra_person_rules FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access Booking Date Ranges" ON public.booking_date_ranges FOR ALL USING (auth.role() = 'authenticated');

-- 4. 初始資料
INSERT INTO public.settings (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM public.settings);

-- 5. 儲存空間權限 (Storage)
-- 建立 Bucket (如果不存在)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('knowledge_base', 'knowledge_base', true)
ON CONFLICT (id) DO NOTHING;

-- 允許任何人讀取檔案
CREATE POLICY "Allow Public Select" ON storage.objects
FOR SELECT TO public
USING (bucket_id = 'knowledge_base');

-- 允許已登入的管理員上傳/更新/刪除檔案
CREATE POLICY "Allow Auth Insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'knowledge_base');
CREATE POLICY "Allow Auth Update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'knowledge_base');
CREATE POLICY "Allow Auth Delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'knowledge_base');

-- 6. 【既有專案升級用】若您的資料庫是舊版建立的，CREATE TABLE IF NOT EXISTS 不會補齊新欄位，
--    請單獨執行以下 ALTER TABLE 語句以支援「Google 試算表知識庫」功能：
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS knowledge_sheet_id TEXT DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS knowledge_sheet_gid TEXT DEFAULT '0';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS skip_ai_keywords TEXT DEFAULT '';
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS conversation_history TEXT DEFAULT '[]';

-- 7. 【既有專案升級用】支援「訂房管理 Phase 1」功能：
-- 日期區間改為純後台維護，若您先前已執行過含 booking_sheet_id/booking_sheet_gid 的舊版腳本，
-- 以下語句會把這兩個欄位與 booking_date_ranges 的 source 欄位清掉（不影響其他資料）：
ALTER TABLE public.settings DROP COLUMN IF EXISTS booking_sheet_id;
ALTER TABLE public.settings DROP COLUMN IF EXISTS booking_sheet_gid;
ALTER TABLE public.booking_date_ranges DROP COLUMN IF EXISTS source;

CREATE TABLE IF NOT EXISTS public.room_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    floor TEXT DEFAULT '',
    capacity INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS public.whole_house_packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    occupancy INTEGER NOT NULL,
    room_combo TEXT DEFAULT '',
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

CREATE TABLE IF NOT EXISTS public.whole_house_extra_person_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_type TEXT NOT NULL,
    rule_label TEXT DEFAULT '',
    tier TEXT NOT NULL,
    price NUMERIC,
    UNIQUE (rule_type, tier)
);

CREATE TABLE IF NOT EXISTS public.booking_date_ranges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    range_type TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    label TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE public.room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_package_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_extra_person_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_date_ranges ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'room_types' AND policyname = 'Allow Auth Access Room Types') THEN
        CREATE POLICY "Allow Auth Access Room Types" ON public.room_types FOR ALL USING (auth.role() = 'authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'room_pricing' AND policyname = 'Allow Auth Access Room Pricing') THEN
        CREATE POLICY "Allow Auth Access Room Pricing" ON public.room_pricing FOR ALL USING (auth.role() = 'authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whole_house_packages' AND policyname = 'Allow Auth Access WH Packages') THEN
        CREATE POLICY "Allow Auth Access WH Packages" ON public.whole_house_packages FOR ALL USING (auth.role() = 'authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whole_house_package_pricing' AND policyname = 'Allow Auth Access WH Package Pricing') THEN
        CREATE POLICY "Allow Auth Access WH Package Pricing" ON public.whole_house_package_pricing FOR ALL USING (auth.role() = 'authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whole_house_extra_person_rules' AND policyname = 'Allow Auth Access WH Extra Person Rules') THEN
        CREATE POLICY "Allow Auth Access WH Extra Person Rules" ON public.whole_house_extra_person_rules FOR ALL USING (auth.role() = 'authenticated');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'booking_date_ranges' AND policyname = 'Allow Auth Access Booking Date Ranges') THEN
        CREATE POLICY "Allow Auth Access Booking Date Ranges" ON public.booking_date_ranges FOR ALL USING (auth.role() = 'authenticated');
    END IF;
END $$;
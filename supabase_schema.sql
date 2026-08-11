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
    conversation_retention_days INTEGER DEFAULT 3,
    business_name TEXT DEFAULT '', -- 民宿/商家名稱，客製訊息發送的 [民宿名稱] 合併欄位
    customer_service_line TEXT DEFAULT '', -- 客服 LINE 帳號/ID，客製訊息發送的 [客服LINE] 合併欄位
    booking_gift_message TEXT DEFAULT '' -- 禮金/加購項目說明，客製訊息發送的 [禮金內容] 合併欄位
);

-- 2. 用戶狀態表
CREATE TABLE IF NOT EXISTS public.user_states (
    line_user_id TEXT PRIMARY KEY,
    nickname TEXT,
    is_human_mode BOOLEAN DEFAULT false,
    last_human_interaction TIMESTAMP WITH TIME ZONE,
    last_ai_reset_at TIMESTAMP WITH TIME ZONE
    -- last_event_id / booking_session / last_message_at / first_message_at / avatar_url 由後面的 ALTER TABLE 補齊，新舊專案都適用
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
    -- type / equipment 由後面的 ALTER TABLE 補齊，新舊專案都適用
);

-- room_types 後來加的欄位：「房型與空間維護」頁面用來管理房間/空間的基本資料。
-- type 用自由文字（不是固定選項），預設「房間」；只有 type='房間' 的資料列會出現在「房型定價」的
-- 訂價/訂房邏輯裡（其他 type 例如「空間」是純設施紀錄，不能訂房、不需要價格）。
ALTER TABLE public.room_types ADD COLUMN IF NOT EXISTS type TEXT DEFAULT '房間';
ALTER TABLE public.room_types ADD COLUMN IF NOT EXISTS equipment TEXT DEFAULT ''; -- 設備說明，自由文字

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

-- 耗材維護：會被用掉、需要補貨的消耗品（例如沐浴乳、衛生紙），跟床單/毛巾這類重複使用的
-- 布巾備品分開管理（布巾備品直接寫在 room_types.equipment 說明文字裡即可，不需要庫存數量）。
CREATE TABLE IF NOT EXISTS public.consumables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    unit TEXT DEFAULT '', -- 單位，例如：瓶、包、捲
    stock_quantity INTEGER DEFAULT 0,
    restock_threshold INTEGER DEFAULT 0, -- 低於這個數字在畫面上標示「該補貨了」
    notes TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 耗材可以對應到多個房型/空間（例如衛生紙每個房間都要），房型/空間也可以對應多種耗材
CREATE TABLE IF NOT EXISTS public.consumable_spaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consumable_id UUID NOT NULL REFERENCES public.consumables(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    UNIQUE (consumable_id, room_type_id)
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

-- user_states 後來加的欄位（新專案 CREATE TABLE 時不含這些，靠這幾行 ALTER 補齊，既有專案升級也適用）
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS last_event_id TEXT;
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS booking_session TEXT; -- 訂房對話流程：進行中的訂房詢問狀態（JSON），null＝目前沒有進行中的詢問
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITH TIME ZONE; -- 最近一次跟 LINE 官方帳號互動的時間（不分是否轉真人/訂房），供「客製訊息發送」查詢聯絡人清單用
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMP WITH TIME ZONE; -- 第一次互動時間，只在 line-webhook.ts 第一次見到這個 line_user_id 時寫入一次，之後不會再更新
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS avatar_url TEXT; -- LINE 大頭貼網址，跟暱稱同時機快取（第一次互動 / 手動按「重新整理暱稱」時更新）

-- 客製訊息發送：後台自訂的可重複使用訊息範本
CREATE TABLE IF NOT EXISTS public.custom_message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 訊息變數資料維護：管理員自訂「[變數名稱]」對應到哪個資料來源的哪個欄位，
-- LINE 自定訊息流程的罐頭訊息、客製訊息發送的範本都共用這份對照表來源算合併欄位的值。
-- 「來源」限定訂單/客戶/民宿設定三種（對應 bookings / user_states / settings 三張表），
-- 「欄位」也只能從該來源的白名單選，避免管理員不小心曝光不該顯示的資料庫欄位。
CREATE TABLE IF NOT EXISTS public.message_variables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variable_name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK (source IN ('booking', 'customer', 'settings')),
    field_key TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- 預設帶入現有系統已經在用的變數，讓既有的罐頭訊息／客製訊息範本升級後不會突然找不到變數。
-- 「客戶姓名」跟「姓名」、「入住人數」跟「人數」、「總報價」跟「總金額」是同一個欄位的兩種命名
-- （客製訊息發送 vs 罐頭訊息歷史上取的名字不同），兩個都保留，管理員可以自行刪除不需要的那個。
INSERT INTO public.message_variables (variable_name, source, field_key, display_order) VALUES
    ('訂單編號', 'booking', 'order_number', 1),
    ('姓名', 'booking', 'name', 2),
    ('客戶姓名', 'booking', 'name', 3),
    ('入住日期', 'booking', 'checkin_date', 4),
    ('退房日期', 'booking', 'checkout_date', 5),
    ('人數', 'booking', 'headcount', 6),
    ('入住人數', 'booking', 'headcount', 7),
    ('大人小孩', 'booking', 'adults_kids', 8),
    ('是否包棟', 'booking', 'whole_house', 9),
    ('房型', 'booking', 'room_type_label', 10),
    ('訂單狀態', 'booking', 'status', 11),
    ('總金額', 'booking', 'total_amount', 12),
    ('總報價', 'booking', 'total_amount', 13),
    ('訂金', 'booking', 'deposit', 14),
    ('尾款', 'booking', 'balance_due', 15),
    ('電話', 'booking', 'phone', 16),
    ('LINE暱稱', 'customer', 'nickname', 17),
    ('LINE User ID', 'customer', 'line_user_id', 18),
    ('禮金內容', 'settings', 'booking_gift_message', 19),
    ('民宿名稱', 'settings', 'business_name', 20),
    ('客服LINE', 'settings', 'customer_service_line', 21)
ON CONFLICT (variable_name) DO NOTHING;

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

-- booking_flows 後來加的欄位（新專案 CREATE TABLE 時不含這些，靠這幾行 ALTER 補齊，既有專案升級也適用）
--
-- trigger_rules：每個關鍵字各自決定比對方式，[{ "keyword": "訂房", "match": "exact" }, ...]
--   match = 'exact'  顧客整句話就是這個關鍵字才觸發
--   match = 'contains' 顧客句子裡出現這個關鍵字就觸發
--   舊的 trigger_keywords 欄位保留不刪，前端存檔時會同步寫入，萬一要退回舊版程式仍讀得到。
-- reply_mode：'ai' 用 AI 理解顧客回覆並擷取欄位（預設，等同改版前的行為）；
--   'system' 完全不呼叫 AI，改用純程式解析顧客回覆（省 token，但只認得標準寫法）。
-- quote_message / confirm_message：流程走完、算出金額後的報價確認與付款確認訊息。
--   改版前這兩段放在 settings 表、全站共用一份；現在每個流程各自一份，
--   webhook 讀不到流程自己的內容時會退回 settings 的舊值，所以升級過程不會有空窗。
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS trigger_rules JSONB NOT NULL DEFAULT '[]';
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS quote_message TEXT;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS confirm_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_flows_reply_mode_check') THEN
    ALTER TABLE public.booking_flows ADD CONSTRAINT booking_flows_reply_mode_check CHECK (reply_mode IN ('ai', 'system'));
  END IF;
END $$;

-- 既有流程的關鍵字回填：沿用改版前寫死在 line-webhook.ts 的規則——單字關鍵字太容易誤觸，
-- 只在整句完全相同時才算（exact）；兩字以上用包含比對（contains）。這樣升級後行為完全不變。
UPDATE public.booking_flows f
SET trigger_rules = COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
        'keyword', kw,
        'match', CASE WHEN char_length(kw) = 1 THEN 'exact' ELSE 'contains' END
     ))
     FROM (
        SELECT btrim(k) AS kw
        FROM unnest(string_to_array(replace(f.trigger_keywords, '，', ','), ',')) AS k
     ) parts
     WHERE kw <> ''),
    '[]'::jsonb)
WHERE f.trigger_rules = '[]'::jsonb AND COALESCE(f.trigger_keywords, '') <> '';

-- 報價／付款確認訊息回填：把 settings 裡原本全站共用的那一份複製給每個既有流程當起點。
-- settings 的欄位保留不刪，webhook 仍會在流程沒有自己的內容時拿它當備援。
UPDATE public.booking_flows
SET quote_message = (SELECT booking_quote_message FROM public.settings LIMIT 1)
WHERE quote_message IS NULL;

UPDATE public.booking_flows
SET confirm_message = (SELECT booking_confirm_message FROM public.settings LIMIT 1)
WHERE confirm_message IS NULL;

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
    -- order_number / room_type_label / notes 由後面的 ALTER TABLE 補齊，新舊專案都適用
);

-- bookings 後來加的欄位（新專案 CREATE TABLE 時不含這些，靠這幾行 ALTER 補齊，既有專案升級也適用）
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS order_number TEXT UNIQUE; -- 建立訂單時產生，格式 YYYYMMDD-XXXX，供客服人員與顧客溝通時使用的可讀編號
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS room_type_label TEXT; -- 算完報價時寫入的人類可讀房型摘要（包棟＝「包棟」，個別租房＝房型名稱組合），列表顯示用，不用每次 join booking_room_nights
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS notes TEXT; -- 訂單管理頁的管理員備註，系統不會自動寫入
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS remit_last5 TEXT; -- 匯款末5碼，狀態改成「已預定」時訂單管理頁會要求填寫（僅前端表單驗證，不是資料庫層級限制，避免擋到 LINE 自動流程寫入）

-- 訂單狀態改版（10 種狀態，取代原本 5 種）：
-- 待報價 inquiring／已報價 quoted／待預定 awaiting_deposit／已預定 reserved／待收尾款 awaiting_balance／
-- 已確認 confirmed／待退款 awaiting_refund／已退款 refunded／已取消 cancelled（沒收過款、不需退款的取消）／
-- 待人工確認 pending_manual_conflict（系統偵測到檔期衝突，非管理員手動可選狀態，LINE 自動流程專用）。
-- 既有資料先轉換再套用新限制，避免既有訂單違反新的 CHECK：
-- 舊 pending_confirmation（報價已送出，等客戶回覆）→ 新 quoted（意思相同）
-- 舊 confirmed（客戶已回「是」，鎖房並發送匯款資訊，不代表真的收到款項）→ 新 reserved
--   （沿用「已收到訂金」的既有語意——這批舊資料是回填歷史訂單時，依「訂金付款日有無填寫」判斷已收訂金才標記
--   confirmed，所以轉成 reserved 最接近事實；LINE 自動流程之後改成同一個時間點寫入 awaiting_deposit，
--   等後台人工核對實際匯款後再手動改成 reserved，兩者定義才會一致）。
-- 順序很重要：先把舊的 CHECK 限制拿掉，UPDATE 才能把資料改成新的狀態代碼（新代碼在舊限制下是
-- 不合法的值，UPDATE 若在拿掉舊限制之前執行會直接違反舊 CHECK 失敗），最後才套用新的限制。
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.bookings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.bookings DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

UPDATE public.bookings SET status = 'quoted' WHERE status = 'pending_confirmation';
UPDATE public.bookings SET status = 'reserved' WHERE status = 'confirmed';

ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'inquiring', 'quoted', 'awaiting_deposit', 'reserved', 'awaiting_balance',
  'confirmed', 'awaiting_refund', 'refunded', 'cancelled', 'pending_manual_conflict'
));
DROP INDEX IF EXISTS idx_bookings_confirmed_dates; -- 舊索引，條件只認舊的 'confirmed' 狀態，被下面新的取代

CREATE INDEX IF NOT EXISTS idx_bookings_user ON public.bookings(line_user_id, created_at DESC);
-- 「佔用中」的狀態（房間已鎖定、還沒到取消/退款的訂單），供檔期衝突檢查跟房況行事曆使用
CREATE INDEX IF NOT EXISTS idx_bookings_occupying_dates ON public.bookings(checkin_date, checkout_date)
  WHERE status IN ('awaiting_deposit', 'reserved', 'awaiting_balance', 'confirmed', 'pending_manual_conflict');
CREATE INDEX IF NOT EXISTS idx_bookings_order_number ON public.bookings(order_number);

-- 8.7 個別房型每晚實際使用紀錄（顧客確認訂房當下才寫入），供「不同顧客訂到同一天/同房型」衝突檢查用。
CREATE TABLE IF NOT EXISTS public.booking_room_nights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
    night_date DATE NOT NULL,
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_booking_room_nights_lookup ON public.booking_room_nights(night_date, room_type_id);

-- ========================================================================
-- 8.8 布巾備品洗滌成本
--
-- 跟 consumables（耗材）分開：耗材是用掉就沒了、要補貨；布巾是重複使用、每次送洗算一次錢，
-- 成本來自洗滌廠的每件單價，不需要庫存數量。
--
-- 成本怎麼算：
--   某張訂單的用量 = Σ（這張訂單開的每一間房 × 該房型的預設組合數量 × 換洗次數）
--   換洗次數 = ceil(住宿晚數 / change_every_nights)，例如毛巾天天換(1)、床包三天換(3)，
--   住 5 晚就是毛巾 5 次、床包 2 次。
--   「包棟」不特別處理——它只是使用權的名稱，實際成本一律看 booking_rooms 開了幾間房。
-- ========================================================================

-- 布巾品項與洗滌單價（初始資料為艾利租時代概念有限公司的報價單）
CREATE TABLE IF NOT EXISTS public.linen_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL,           -- 品項，例如：床包、被套、枕套
    spec TEXT NOT NULL DEFAULT '',    -- 品名-規格，例如：平紋貢緞床包-5x6.2 尺-高 28cm 紅線
    unit_price NUMERIC,               -- 每件洗滌單價；NULL＝另行報價（例如「其他布品」）
    is_active BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (category, spec)
);

-- 每個房間的預設布巾組合：一間房整理一次要用哪些布巾、各幾件、幾晚換一次
CREATE TABLE IF NOT EXISTS public.room_type_linen_defaults (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    linen_item_id UUID NOT NULL REFERENCES public.linen_items(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1,
    change_every_nights INTEGER NOT NULL DEFAULT 1, -- 幾晚換一次；1＝每晚換
    UNIQUE (room_type_id, linen_item_id)
);

-- 這張訂單實際開了哪幾間房。
-- 既有的 booking_room_nights 不能拿來當唯一來源：它只有 LINE 流程的「個別租房」會寫入，
-- 包棟不寫，訂單管理手動建立的訂單也不寫。這張表由訂單管理頁維護，涵蓋所有來源的訂單。
CREATE TABLE IF NOT EXISTS public.booking_rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    UNIQUE (booking_id, room_type_id)
);
CREATE INDEX IF NOT EXISTS idx_booking_rooms_booking ON public.booking_rooms(booking_id);

-- 這張訂單的布巾用量與成本。
-- unit_price 是「當下的單價快照」，不是即時 join linen_items——洗滌廠調價之後，
-- 歷史訂單的成本必須維持原樣，否則過去的月報表會憑空變動。
CREATE TABLE IF NOT EXISTS public.booking_linen_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id UUID NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
    linen_item_id UUID NOT NULL REFERENCES public.linen_items(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 0,
    unit_price NUMERIC NOT NULL DEFAULT 0,
    is_manual BOOLEAN NOT NULL DEFAULT false, -- true＝管理員手動改過，重算預設組合時不覆蓋
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (booking_id, linen_item_id)
);
CREATE INDEX IF NOT EXISTS idx_booking_linen_usage_booking ON public.booking_linen_usage(booking_id);

INSERT INTO public.linen_items (category, spec, unit_price, display_order) VALUES
    ('床包', '平紋貢緞床包-3.5x6.2 尺-高 28cm 紫線', 45, 1),
    ('床包', '平紋貢緞床包-5x6.2 尺-高 28cm 紅線', 45, 2),
    ('床包', '平紋貢緞床包-6x6.2 尺-高 28cm 藍線', 45, 3),
    ('床包', '平紋貢緞床包-6x7 尺-高 28cm 綠線', 45, 4),
    ('被套', '平紋貢緞被套-150*(210+10)cm', 50, 5),
    ('被套', 'CVC3cm 條紋被套-180x(210+10)cm', 50, 6),
    ('被套', 'CVC0.6cm 條紋被套-210x(210+10)cm-紅線', 50, 7),
    ('被套', 'CVC1cm 條紋被套-240x(210+10)cm', 50, 8),
    ('枕套', '平紋貢緞枕套-50x7-cm-信封式-250TC', 8, 9),
    ('大浴巾', '白色平織浴巾 16 兩-70*140 公分', 16, 10),
    ('大浴巾', '白色平織浴巾 14 兩-70*140 公分', 16, 11),
    ('中毛巾', '白色平織毛巾 4 兩-35*78 公分', 8, 12),
    ('足布', '白色平織腳墊 10 兩-78*52 公分', 12, 13),
    ('床單', '', 40, 14),
    ('保潔墊', '', 60, 15),
    ('枕頭', '', 70, 16),
    ('羽絨(毛)被', '', 150, 17),
    ('其他布品', '', NULL, 18)
ON CONFLICT (category, spec) DO NOTHING;

-- 既有訂單的房間紀錄回填：LINE 個別租房的訂單有 booking_room_nights，可以直接推出開了哪幾間房。
-- 包棟與手動建立的訂單沒有任何房間資料，只能由管理員在訂單管理頁補選，這裡不亂猜。
INSERT INTO public.booking_rooms (booking_id, room_type_id)
SELECT DISTINCT booking_id, room_type_id FROM public.booking_room_nights
ON CONFLICT (booking_id, room_type_id) DO NOTHING;

-- 9. 啟用 RLS（僅限已登入使用者存取，用 DROP + CREATE 讓整份腳本可重複執行）
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_base_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handover_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_extra_person_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consumable_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_package_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_package_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whole_house_extra_person_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_date_ranges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_flows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_flow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_room_nights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.linen_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_type_linen_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_linen_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow Auth Access" ON public.settings;
CREATE POLICY "Allow Auth Access" ON public.settings FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access States" ON public.user_states;
CREATE POLICY "Allow Auth Access States" ON public.user_states FOR ALL USING (auth.role() = 'authenticated');
-- processed_events 只有 line-webhook.ts 用 service role key 寫入/查詢（會略過 RLS），
-- 前端從不存取這張表，這裡開 RLS 只是不讓 anon key 直接讀寫，不影響 webhook 運作。
DROP POLICY IF EXISTS "Allow Auth Access Processed Events" ON public.processed_events;
CREATE POLICY "Allow Auth Access Processed Events" ON public.processed_events FOR ALL USING (auth.role() = 'authenticated');
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
DROP POLICY IF EXISTS "Allow Auth Access Consumables" ON public.consumables;
CREATE POLICY "Allow Auth Access Consumables" ON public.consumables FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Consumable Spaces" ON public.consumable_spaces;
CREATE POLICY "Allow Auth Access Consumable Spaces" ON public.consumable_spaces FOR ALL USING (auth.role() = 'authenticated');
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
DROP POLICY IF EXISTS "Allow Auth Access Message Variables" ON public.message_variables;
CREATE POLICY "Allow Auth Access Message Variables" ON public.message_variables FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Flows" ON public.booking_flows;
CREATE POLICY "Allow Auth Access Booking Flows" ON public.booking_flows FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Flow Steps" ON public.booking_flow_steps;
CREATE POLICY "Allow Auth Access Booking Flow Steps" ON public.booking_flow_steps FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Bookings" ON public.bookings;
CREATE POLICY "Allow Auth Access Bookings" ON public.bookings FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Room Nights" ON public.booking_room_nights;
CREATE POLICY "Allow Auth Access Booking Room Nights" ON public.booking_room_nights FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Linen Items" ON public.linen_items;
CREATE POLICY "Allow Auth Access Linen Items" ON public.linen_items FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Room Type Linen Defaults" ON public.room_type_linen_defaults;
CREATE POLICY "Allow Auth Access Room Type Linen Defaults" ON public.room_type_linen_defaults FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Rooms" ON public.booking_rooms;
CREATE POLICY "Allow Auth Access Booking Rooms" ON public.booking_rooms FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Booking Linen Usage" ON public.booking_linen_usage;
CREATE POLICY "Allow Auth Access Booking Linen Usage" ON public.booking_linen_usage FOR ALL USING (auth.role() = 'authenticated');

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

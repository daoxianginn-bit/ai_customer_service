-- ============================================================
-- AI 客服系統完整資料庫腳本（含訂房功能）
--
-- 這是專案唯一的資料庫腳本，沒有其他分散的 migration 檔案要另外執行。
-- 全新 Supabase 專案：整份貼到 SQL Editor 執行一次即可。
-- 既有專案升級：一樣整份重新執行，全部語句都用 IF NOT EXISTS / DROP+CREATE / 條件式 UPDATE，
--   可重複執行不會出錯，也不會重複套用同一筆資料補正。
--
-- 章節順序：1~8 建立資料表與欄位 → 9 RLS 權限 → 10~11 初始資料與儲存空間 → 12 既有資料補正。
-- 新增欄位請放在對應章節的 ALTER 區塊；新增「改既有資料」的語句請放到第 12 節，
-- 那裡的前提是所有表格欄位都已經建好。
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
-- 這個房型個別租房時的押金。訂單開了幾間房，押金就加總幾間（見「房型與定價」頁與
-- messageVariables.ts 的 computeOrderAmounts）；包棟不用這個欄位，是另外固定的
-- settings.whole_house_security_deposit。
ALTER TABLE public.room_types ADD COLUMN IF NOT EXISTS security_deposit NUMERIC NOT NULL DEFAULT 0;

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

-- 耗材維護：會被用掉、需要補貨的消耗品（例如沐浴乳、衛生紙）。跟床單/毛巾這類重複使用、
-- 每次送洗依件計價的布巾備品是不同的資料模型（耗材看庫存量，布巾看洗滌成本），
-- 各自有獨立的資料表（布巾備品見後面 8.8 節的 linen_items 等表），
-- 但前端「備品管理」頁面把兩者放在同一頁的不同分頁，方便管理員一次維護完。
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
    -- room_layout / is_default 由後面的 ALTER TABLE 補齊，新舊專案都適用
);

-- 同一個人數（occupancy）現在可以有多筆方案，各自代表不同的房型組合（例如 8 人的「4+4」
-- 跟「2+2+4」各是獨立一筆，各自連自己的 whole_house_package_rooms 跟 whole_house_package_pricing）。
-- room_layout 是純顯示用標籤；is_default 標記客人沒有指定房型組合時系統要自動選哪一筆
-- （同一 occupancy 只能有一筆 is_default=true，由後台編輯畫面自己保證，資料庫沒有加約束——
-- 避免既有資料在升級當下就不符合約束而炸掉）。
ALTER TABLE public.whole_house_packages ADD COLUMN IF NOT EXISTS room_layout TEXT DEFAULT '';
ALTER TABLE public.whole_house_packages ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT true;

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

-- 特殊指定日期價格：日期區間（可選填人數，NULL＝不分人數都套用）直接指定一個絕對金額，
-- 優先權最高，計算包棟報價時第一個檢查，命中就直接用這個金額當「當晚基礎價」，
-- 不再跑平日/小假日/連假/旺季那套 tier 判斷（見 bookingEngine.ts 的 getSpecialPrice()）。
-- 促銷方案／連住折扣要不要繼續疊加在這個金額上面，由 settings.special_price_stacks_with_discounts 決定。
CREATE TABLE IF NOT EXISTS public.special_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    name TEXT DEFAULT '',
    occupancy INTEGER,
    price NUMERIC NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_special_prices_dates ON public.special_prices(start_date, end_date);

-- 加開房費：客人實際要求的房型組合比標準房型多開的每一間，依這間房的容量收費
-- （例如雙人房 1000、四人房 1500）。每種實際存在的容量各一筆，新增房型容量時
-- 這裡也要補一筆，不然那個容量沒有加開費資料時預設視為 0。
CREATE TABLE IF NOT EXISTS public.room_capacity_pricing (
    capacity INTEGER PRIMARY KEY,
    extra_room_fee NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.promotions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    discount_percent NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
    -- discount_type / discount_amount 由後面的 ALTER TABLE 補齊，新舊專案都適用
);

-- 促銷除了打折 % 之外，也能設固定金額折抵（例如「早鳥折 500 元」）。
-- discount_type='percent'（預設，沿用既有的 discount_percent 欄位）；'amount' 時改用 discount_amount
-- 直接從房價扣，兩個欄位都保留、依 discount_type 決定套用哪一個，不會互相覆蓋。
ALTER TABLE public.promotions ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'percent';
ALTER TABLE public.promotions ADD COLUMN IF NOT EXISTS discount_amount NUMERIC NOT NULL DEFAULT 0;

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
-- 特殊指定日期價格命中時，促銷方案／連住折扣要不要繼續疊加：true＝疊加（特殊價格只是換掉基礎價，
-- 折扣照常套用，實收可能比設定的特殊價格低）；false＝不疊加（特殊價格就是當晚最終金額）。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS special_price_stacks_with_discounts BOOLEAN NOT NULL DEFAULT true;

-- 純公式驅動計價（取代同人數多方案手動定價那套）：標準房型的價格 = 床位數 × 每床基礎價，
-- 人數剛好滿載（等於床位數）再加滿載獎勵；標準房型怎麼湊見 bookingEngine.ts 的
-- computeStandardRoomLayout()。日期加價沿用 booking_date_ranges 的 tier 判斷，平日固定 +0，
-- 其餘三個 tier 各自的加價金額存在這裡。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS bed_base_rate NUMERIC NOT NULL DEFAULT 1000;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS full_occupancy_bonus NUMERIC NOT NULL DEFAULT 500;
-- 低於這個人數不自動報價，直接轉真人客服確認（見 line-webhook.ts 的「無法自動試算」訊息）。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS min_group_headcount INTEGER NOT NULL DEFAULT 1;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS date_surcharge_small_holiday NUMERIC NOT NULL DEFAULT 5000;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS date_surcharge_peak NUMERIC NOT NULL DEFAULT 8000;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS date_surcharge_long_holiday NUMERIC NOT NULL DEFAULT 12000;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS consecutive_stay_discount_cleaning NUMERIC DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS consecutive_stay_discount_no_cleaning NUMERIC DEFAULT 0;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS consecutive_stay_default_option TEXT DEFAULT 'no_cleaning';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS peak_season_weekday_tier TEXT DEFAULT 'peak';
-- 平日算到週幾：'sun_thu'＝日~四是平日、五六是小假日（原本唯一的行為）；'sun_fri'＝日~五是平日、只有週六算小假日。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS weekday_range TEXT DEFAULT 'sun_thu';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS booking_trigger_keywords TEXT DEFAULT '我要訂房,訂房';
-- 【已停用】quote_sheet_id / quote_sheet_gid：原本用來鏡射寫入 Google「報價」試算表，
-- 該功能已整個移除，程式不再讀寫這兩個欄位。保留欄位定義只是為了讓既有資料庫不需要跑破壞性的
-- DROP COLUMN；確定不再需要時可以自行執行：
--   ALTER TABLE public.settings DROP COLUMN IF EXISTS quote_sheet_id, DROP COLUMN IF EXISTS quote_sheet_gid;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS quote_sheet_id TEXT DEFAULT '';
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS quote_sheet_gid TEXT DEFAULT '0';

-- 訂房行事曆訂閱網址（netlify/functions/calendar-feed.ts）的通行碼。這是 2026-08 版本用的舊功能
-- （行事曆軟體訂閱一個 URL，Google/TimeTree/Apple 都適用），後來改成直接寫入指定的 Google 行事曆
-- （見下面 google_calendar_id 等欄位），程式已經不再讀寫這個欄位，比照本專案「舊欄位保留不刪」的慣例
-- （LINE 串接改多帳號時 settings 的舊 channel token 欄位也是這樣處理）留著不動，避免不必要的欄位異動。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS calendar_feed_token TEXT DEFAULT '';

-- Google 行事曆同步（服務帳號直接寫入事件，取代上面舊的訂閱網址做法）：
--   google_calendar_id：要寫入哪一個 Google 行事曆，管理員在 Google 日曆設定裡複製「行事曆 ID」貼過來。
--   google_service_account_json：GCP 服務帳號的金鑰檔（JSON）原文貼上，用來簽發存取權杖呼叫
--     Calendar API，等同密碼，不要外流。管理員要記得把上面設定的行事曆「分享」給這組服務帳號的信箱
--     （在服務帳號金鑰的 client_email 欄位可以找到），並給予「可以變更活動」的權限，否則寫入會被拒絕。
--   last_synced_at / last_sync_status / last_sync_summary：「排程管理」的 sync_calendars 排程執行完寫回，
--     供後台顯示最後一次同步的結果，跟 ota_channels 的 last_import_* 同一套設計。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS google_service_account_json TEXT;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS google_calendar_last_synced_at TIMESTAMPTZ;
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS google_calendar_last_sync_status TEXT; -- 'success' | 'failed'，還沒同步過是 NULL
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS google_calendar_last_sync_summary TEXT;
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
-- 押金：改版前是每筆訂單固定收取的可退款保證金。現在拆成兩種——個別租房用 room_types.security_deposit
-- （每個房型各自設定，訂單開了幾間房就加總幾間）；包棟不能用加總（風險是整棟的，跟開幾間房無關），
-- 沿用這個欄位當包棟專用的固定金額，語意從「每筆訂單」窄化成「包棟訂單」，欄位本身不用改名。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS security_deposit_amount NUMERIC NOT NULL DEFAULT 3000;
-- 訂金比例：以「房價」為基數，不含押金。30 代表房價的 30%。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS deposit_percent NUMERIC NOT NULL DEFAULT 30;

-- 匯款截止時間：改版前是「依送出時間算當天/隔天 21:00」寫死的邏輯，傍晚送出的客人可能只剩 3 小時，
-- 半夜的客服又看不到通知。現在改成後台可調整的「送出後 N 小時」，見 line-webhook.ts 的
-- computePaymentDeadlineDate()。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS payment_deadline_hours INTEGER NOT NULL DEFAULT 10;
-- 包棟押金：見上面 security_deposit_amount 的說明，這是給新的（個別房型押金加總 vs 包棟固定金額）
-- 兩種算法用的正式欄位名稱；security_deposit_amount 保留給包棟繼續用，新程式碼一律讀這個。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS whole_house_security_deposit NUMERIC NOT NULL DEFAULT 3000;
-- 主帳號：不能被其他管理員移除（見 delete-admin.ts）。目前先簡單存一個 user id，
-- 之後如果要做更完整的多角色權限，應該改接到上面第 7 節已經預留、但還沒接上的 admin_profiles.role，
-- 這裡只是先解決「主帳號不能被刪」這個當下的需求。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS primary_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- user_states 後來加的欄位（新專案 CREATE TABLE 時不含這些，靠這幾行 ALTER 補齊，既有專案升級也適用）
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS last_event_id TEXT;
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS booking_session TEXT; -- 訂房對話流程：進行中的訂房詢問狀態（JSON），null＝目前沒有進行中的詢問
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITH TIME ZONE; -- 最近一次跟 LINE 官方帳號互動的時間（不分是否轉真人/訂房），供「客製訊息發送」查詢聯絡人清單用
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS first_message_at TIMESTAMP WITH TIME ZONE; -- 第一次互動時間，只在 line-webhook.ts 第一次見到這個 line_user_id 時寫入一次，之後不會再更新
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS avatar_url TEXT; -- LINE 大頭貼網址，跟暱稱同時機快取（第一次互動 / 手動按「重新整理暱稱」時更新）
-- 客人要求不接收行銷群發。跟封鎖 LINE 官方帳號不一樣——封鎖會連客服/訂房管道都一起失去，
-- 這個只影響「客製訊息發送」頁挑選名單時排不排得到這個人，個別客服對話不受影響。
ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;

-- ========================================================================
-- 2.5 多 LINE 官方帳號（多 webhook）
--
-- 改版前整套系統假設只有一個官方帳號，憑證直接放在 settings 表。現在要同時經營三種角色：
--   customer 客戶用：既有的訂房詢問／AI 問答／轉真人，全功能。
--   vendor   廠商用：接收訂單完成統計，並可回覆簡短確認（例如「已備貨」）。
--   internal 團隊內部用：接收訂單完成統計。
--
-- ⚠️ 最關鍵的一點：LINE 的 user ID 是「每個官方帳號各自獨立」的——同一個人在客戶帳號
-- 和廠商帳號會拿到兩組完全不同的 userId，彼此無法對應。所以聯絡人、對話、訂單都必須
-- 標記自己屬於哪個 channel，user_states 的主鍵也要從 line_user_id 改成
-- (channel_id, line_user_id) 複合鍵，否則兩個帳號的同名 userId 會互相覆蓋。
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.line_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                       -- 官方帳號名稱，後台各處顯示用
    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'vendor', 'internal')),
    channel_access_token TEXT NOT NULL DEFAULT '',
    channel_secret TEXT NOT NULL DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_line_channels_role ON public.line_channels(role) WHERE is_active;

-- 既有專案升級：把 settings 裡原本那組憑證搬成第一個 customer 角色的頻道。
-- 只在 line_channels 全空時執行一次，避免重跑腳本又多長一筆重複的頻道。
INSERT INTO public.line_channels (name, role, channel_access_token, channel_secret, display_order)
SELECT '客戶用官方帳號', 'customer',
       COALESCE(s.line_channel_access_token, ''), COALESCE(s.line_channel_secret, ''), 0
FROM public.settings s
WHERE NOT EXISTS (SELECT 1 FROM public.line_channels)
LIMIT 1;

-- 各表補上 channel_id。既有資料一律歸到「第一個 customer 頻道」——升級前的資料本來就
-- 全部來自那個唯一的官方帳號，這個歸屬是事實而不是猜測。
ALTER TABLE public.user_states   ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES public.line_channels(id) ON DELETE CASCADE;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES public.line_channels(id) ON DELETE SET NULL;
ALTER TABLE public.handover_logs ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES public.line_channels(id) ON DELETE SET NULL;
ALTER TABLE public.bookings      ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES public.line_channels(id) ON DELETE SET NULL;

DO $$
DECLARE
  default_channel UUID;
BEGIN
  SELECT id INTO default_channel FROM public.line_channels
   WHERE role = 'customer' ORDER BY display_order, created_at LIMIT 1;
  IF default_channel IS NULL THEN RETURN; END IF;

  UPDATE public.user_states   SET channel_id = default_channel WHERE channel_id IS NULL;
  UPDATE public.conversations SET channel_id = default_channel WHERE channel_id IS NULL;
  UPDATE public.handover_logs SET channel_id = default_channel WHERE channel_id IS NULL;
  UPDATE public.bookings      SET channel_id = default_channel WHERE channel_id IS NULL;

  -- 補完才能設 NOT NULL，也才能把它放進主鍵
  ALTER TABLE public.user_states ALTER COLUMN channel_id SET NOT NULL;

  -- 主鍵從 line_user_id 換成 (channel_id, line_user_id)。
  -- 用 DO 區塊判斷是不是已經換過，讓整份腳本重跑時不會炸掉。
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.user_states'::regclass AND c.contype = 'p'
       AND (SELECT COUNT(*) FROM unnest(c.conkey)) = 1
  ) THEN
    ALTER TABLE public.user_states DROP CONSTRAINT user_states_pkey;
    ALTER TABLE public.user_states ADD CONSTRAINT user_states_pkey PRIMARY KEY (channel_id, line_user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_states_channel ON public.user_states(channel_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON public.conversations(channel_id, created_at DESC);

-- 訂單完成（退房後）統計推播用：記錄這筆訂單已經推播過，避免排程每次跑都重複發送。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS completion_notified_at TIMESTAMPTZ;

-- 通知名單：排程管理的各種自動通知（尾款提醒、待確認訂單通知、押金處理通知、洗滌排程…）
-- 要發給「某個官方帳號底下的某幾位聯絡人，或群組」，不是整個帳號的全部聯絡人。
-- 在後台勾選聯絡人存成具名清單，各排程可以共用同一份、也可以各自建立自己的名單。
CREATE TABLE IF NOT EXISTS public.notification_recipient_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES public.line_channels(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    line_user_ids JSONB NOT NULL DEFAULT '[]', -- 該 channel 底下被勾選的 user_states.line_user_id 陣列
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_groups_channel ON public.notification_recipient_groups(channel_id);

-- 顧客喊「真人客服」時要通知誰。指到上面那張表的一筆名單，名單本身就帶了「用哪個官方帳號發、
-- 發給哪些人」，所以要通知團隊內部用帳號的聯絡人，直接在後台勾選即可，換人不用改程式。
-- 這個 ALTER 必須放在 notification_recipient_groups 建立之後，不然全新安裝時外鍵會找不到目標。
-- 沒設定時退回舊行為：用客戶用官方帳號推播給 settings.agent_user_ids，既有安裝不會突然收不到通知。
ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS handover_notification_group_id UUID REFERENCES public.notification_recipient_groups(id) ON DELETE SET NULL;

-- LINE 群組（機器人被邀進去的群組聊天，例如內部用來接收推播通知的群組），
-- 跟上面的 notification_recipient_groups（本系統自訂的收件人名單）是完全不同的兩件事——
-- 這裡存的是「LINE 平台本身的群組」，group_id 是 LINE 那邊的群組識別碼。
-- 沒辦法主動查「機器人在哪些群組裡」，只能被動從 webhook 事件（join／群組內的訊息）
-- 收到 groupId 才記錄下來，見 line-webhook.ts 的 handleGroupEvent()。
CREATE TABLE IF NOT EXISTS public.line_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id UUID NOT NULL REFERENCES public.line_channels(id) ON DELETE CASCADE,
    group_id TEXT NOT NULL,
    name TEXT, -- 呼叫 LINE 的 getGroupSummary() 取得，拿不到（權限不足／群組已解散）就留空，後台顯示群組 ID 代替
    is_active BOOLEAN NOT NULL DEFAULT true, -- 機器人被踢出/離開群組時設 false，保留歷史紀錄不刪列
    last_message_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (channel_id, group_id)
);
CREATE INDEX IF NOT EXISTS idx_line_groups_channel_active ON public.line_groups(channel_id) WHERE is_active;

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

-- 預設變數：只在「這張表完全空的」時候才寫入，也就是全新專案第一次執行這份腳本時。
--
-- ⚠️ 這裡刻意不用 `INSERT ... ON CONFLICT (variable_name) DO NOTHING`（原本的寫法）。
-- ON CONFLICT 只會跳過「還存在」的資料列；管理員在「訊息變數資料維護」刪掉的變數已經不存在，
-- 不會產生衝突，於是每次重跑整份腳本就會被原封不動地種回來——管理員刪掉的變數一直復活，
-- 而且會重新出現在訊息編輯器下方的快捷插入鈕裡。這份腳本本來就設計成可以重複執行
-- （既有專案升級都是整份重跑），所以這個復活是必然會發生、不是偶發。
--
-- 改成「整張表是空的才種」之後：全新專案照樣拿到完整預設值；既有專案已經自己整理過的清單
-- （含刻意刪除的項目）不會被腳本覆寫。
--
-- 「客戶姓名」跟「姓名」、「入住人數」跟「人數」、「總報價」跟「總金額」是同一個欄位的兩種命名
-- （客製訊息發送 vs 罐頭訊息歷史上取的名字不同），兩個都保留，管理員可以自行刪除不需要的那個。
INSERT INTO public.message_variables (variable_name, source, field_key, display_order)
SELECT v.variable_name, v.source, v.field_key, v.display_order
FROM (VALUES
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
) AS v(variable_name, source, field_key, display_order)
WHERE NOT EXISTS (SELECT 1 FROM public.message_variables)
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

-- flow_type：走完所有步驟之後要做什麼，三種類型互斥。
--   'quote'（預設，等同改版前的唯一行為）：算價欄位收集齊才進報價引擎，跑報價確認／付款確認；
--     沒收集齊就送 incomplete_message 給顧客並轉真人，不進報價引擎、不建立房間/布巾成本紀錄。
--   'collect'：純問答/收集資訊用，不管有沒有算價欄位，走完最後一步直接送 completion_message 結束，
--     完全不碰 bookings 表——不建立訂單紀錄，因為這類流程本來就不是訂房（例如常見問題、需求登記），
--     硬塞進 bookings 只會在「訂單管理」留下一堆沒有入住日期的空白列。
--   'query'：純查詢既有訂單，只讀不寫。用顧客提供的訂單編號查 bookings，同時比對 line_user_id
--     （只有訂單本人的 LINE 帳號能查到自己的訂單，避免拿到別人的訂單編號就能看到別人的訂房資料）。
--     查到就用查到的那筆訂單資料組 found_message；查不到就回 not_found_message。跟 collect 一樣
--     不建立新的 bookings 紀錄，差別是這個類型會去讀既有資料、回覆內容依查詢結果動態變化。
-- incomplete_message：quote 型專用，算價欄位沒收集齊時的回覆；NULL 用程式內建的預設文字。
-- completion_message：collect 型專用，走完步驟後送給顧客的完成訊息；NULL 用程式內建的預設文字。
-- notify_agent_on_complete：collect 型專用，完成後要不要推播通知 agent_user_ids（每個流程各自決定，
--   不是全站一個開關——像「特殊需求登記」會想馬上知道，「入住須知查詢」通常不用驚動真人）。
-- found_message / not_found_message：query 型專用，查到/查無訂單時的回覆；NULL 用程式內建的預設文字。
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS flow_type TEXT NOT NULL DEFAULT 'quote';
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS incomplete_message TEXT;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS completion_message TEXT;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS notify_agent_on_complete BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS found_message TEXT;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS not_found_message TEXT;

-- quote 型流程在「報價之後」會用到的三則訊息，全部 NULL 時各自用程式內建的預設文字。
-- taken_message：顧客回「是」的當下才發現房間已被別人訂走時的回覆。報價階段不鎖房
--   （見 src/lib/bookingStatus.ts 的 OCCUPYING_STATUSES），所以兩個人可能同時拿到同一批房的
--   報價，先回「是」的人拿走，後回的人會收到這則訊息、訂單直接取消。
-- remittance_received_message：顧客回報匯款（末五碼或轉帳成功截圖）且確認內容真的是轉帳資訊後的回覆。
-- remittance_unclear_message：顧客傳了圖，但看不出是轉帳/交易成功、或抓不到金額與末五碼時的回覆。
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS taken_message TEXT;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS remittance_received_message TEXT;
ALTER TABLE public.booking_flows ADD COLUMN IF NOT EXISTS remittance_unclear_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_flows_flow_type_check') THEN
    ALTER TABLE public.booking_flows ADD CONSTRAINT booking_flows_flow_type_check CHECK (flow_type IN ('quote', 'collect', 'query'));
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

-- 8.6 訂房紀錄（唯一資料來源；原本另外鏡射一份到 Google「報價」試算表，該功能已移除）
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
    sheet_row_number INTEGER, -- 【已停用】原本記錄這筆訂單鏡射到 Google「報價」試算表的第幾列，該功能已移除，程式不再讀寫
    reserved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
    -- order_number / room_type_label / notes 由後面的 ALTER TABLE 補齊，新舊專案都適用
);

-- bookings 後來加的欄位（新專案 CREATE TABLE 時不含這些，靠這幾行 ALTER 補齊，既有專案升級也適用）
-- 建立訂單時產生，供客服人員與顧客溝通時使用的可讀編號。
-- 6 碼大寫英數混和（見 src/lib/orderNumber.ts）；改版前是 YYYYMMDD-XXXX 格式，
-- 舊訂單的編號不會被改動，新舊格式並存。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS order_number TEXT UNIQUE;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS room_type_label TEXT; -- 算完報價時寫入的人類可讀房型摘要（包棟＝「包棟」，個別租房＝房型名稱組合），列表顯示用，不用每次 join booking_room_nights
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS notes TEXT; -- 訂單管理頁的管理員備註，系統不會自動寫入
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS remit_last5 TEXT; -- 匯款末5碼，狀態改成「已預定」時訂單管理頁會要求填寫（僅前端表單驗證，不是資料庫層級限制，避免擋到 LINE 自動流程寫入）
-- 入住密碼／門禁碼，客服手動輸入的明碼（客人到現場要能報這組密碼，所以不能加密存）。
-- 只有狀態為「待入住」時前端才會開放編輯這個欄位（僅前端表單驗證，不是資料庫層級限制）。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS check_in_password TEXT;

-- ========================================================================
-- 第三方平台（Airbnb／Booking.com／Agoda／Trip）iCal 雙向同步。
--
-- 匯出：每個頻道有自己的 export_token，netlify/functions/calendar-feed.ts 依這個 token
--   產生專屬的訂閱網址給該平台貼上，內容排除「來源就是該平台自己」的訂單，避免同步迴圈
--   （平台匯出自己剛匯入的訂單，我們又原樣匯出回去）。
-- 匯入：room_type_id 決定這個頻道的日期要拿去佔用哪個房型（null＝整棟）；import_ics_url 是
--   管理員貼上的、該平台自己提供的匯出網址；scheduled_tasks 的 sync_ota_calendars 排程會定期
--   抓取、解析，寫回 bookings（status='external_synced'，見 bookingStatus.ts）。
--
-- ota_channels 要建在 bookings 拿到 external_channel_id 這個外鍵之前，所以放在這裡。
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.ota_channels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT NOT NULL CHECK (platform IN ('airbnb', 'booking', 'agoda', 'trip')),
    name TEXT NOT NULL, -- 顯示用名稱，同一平台有多個房源/多筆訂閱時用來區分（例如「Airbnb - 暖木」）
    room_type_id UUID REFERENCES public.room_types(id) ON DELETE SET NULL, -- null＝整棟
    import_ics_url TEXT, -- 該平台自己提供的匯出網址，管理員貼上，null＝這個頻道不匯入
    -- 我方匯出給該平台訂閱用。前端建立時用 crypto.getRandomValues() 產生（跟 settings.calendar_feed_token
    -- 同一套做法，見 SystemSettings.tsx），不用資料庫端的 gen_random_bytes()——那需要另外啟用
    -- pgcrypto 擴充套件，這個專案目前完全不依賴它，沒必要為了這一個欄位多引入一個相依性。
    export_token TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT true,
    display_order INTEGER NOT NULL DEFAULT 0,
    last_imported_at TIMESTAMPTZ,
    last_import_status TEXT, -- 'success' | 'failed'，還沒同步過是 NULL
    last_import_summary TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
-- 這個頻道專屬的「關房字樣」補充清單（逗號分隔，比對時不分大小寫）。
-- 判斷「真訂單 vs 關房」的內建規則在 src/lib/otaEventFilter.ts，平台改措辭時管理員可以在後台
-- 直接補字樣、不用改程式。留空就只套內建規則。
ALTER TABLE public.ota_channels ADD COLUMN IF NOT EXISTS extra_block_keywords TEXT;
CREATE INDEX IF NOT EXISTS idx_ota_channels_active ON public.ota_channels(is_active) WHERE is_active;

-- booking_source：這筆訂單是怎麼來的。'direct' 涵蓋 LINE 訂房流程與後台手動建單，
-- 其餘四個對應 ota_channels.platform，只有 external_synced 狀態的訂單才會是非 direct。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS booking_source TEXT NOT NULL DEFAULT 'direct'
  CHECK (booking_source IN ('direct', 'airbnb', 'booking', 'agoda', 'trip'));
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS external_channel_id UUID REFERENCES public.ota_channels(id) ON DELETE SET NULL;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS external_uid TEXT; -- 來源平台 iCal 裡的 VEVENT UID，供比對是否為同一筆、是否已從來源移除
-- 平台端的訂單確認碼（Airbnb 的 HMYSQ5EZ8R 這種，藏在 DESCRIPTION 的訂房連結裡）。
-- 跟 external_uid 是兩個不同的東西：UID 一定存在、格式穩定，所以拿它當去重鍵；確認碼可能撈不到，
-- 只用來顯示與人工對帳（Google 行事曆標題、客服到平台後台查訂單）。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS external_confirmation_code TEXT;
-- 來源事件原文（該筆 VEVENT 的完整內容），規格要求保留原始資料供日後查核與重新同步；
-- 平台改格式導致判讀出錯時，有原文才查得出當初實際收到什麼。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS external_raw_payload TEXT;
-- 第三方訂單跟其他訂單撞期時的旗標。刻意不改 status——status 表達的是訂單生命週期，
-- 而「撞期待查核」是額外的註記，混在一起會分不出「外部匯入的撞期」跟「LINE 訂房流程的撞期」。
-- 依規格：只標記第三方那一筆，本地訂單不動。處理完由人工在「訂單管理」清除。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS ota_conflict_with UUID REFERENCES public.bookings(id) ON DELETE SET NULL;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS ota_conflict_detected_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bookings_ota_conflict ON public.bookings(ota_conflict_detected_at) WHERE ota_conflict_detected_at IS NOT NULL;
-- 同一個頻道底下 external_uid 不能重複，但允許多個頻道各自用到相同的 UID 字串（不同平台的 UID 互不相關），
-- 也允許 external_channel_id 是 null（一般訂單，這個限制不適用）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_external_uid ON public.bookings(external_channel_id, external_uid) WHERE external_channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_external_channel ON public.bookings(external_channel_id) WHERE external_channel_id IS NOT NULL;

-- Google 行事曆同步（sync_calendars 排程）用來記錄「這筆訂單目前對應到 Google 行事曆的哪一個事件」，
-- 才能在訂單異動時用 PATCH 更新既有事件、而不是每次都重新建立一筆。google_synced_at 是「上次成功
-- 同步當下」的時間戳，排程只挑 updated_at 比它新（或還沒同步過）的訂單處理，避免每次排程執行都要
-- 把所有訂單重新 push 一次、白白浪費 Google API 額度。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS google_event_id TEXT;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS google_synced_at TIMESTAMPTZ;
-- 這趟住宿的布巾換洗次數。預設 1＝整趟只在退房後洗一次（最常見）；客人中途想再洗就填 2。
-- 放在訂單而不是房間設定，因為這是每趟住宿的實際狀況，事先決定不了。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS linen_change_count INTEGER NOT NULL DEFAULT 1;

-- 金額結構（四個欄位的關係，改動任何一個都要維持這個等式）：
--   room_amount      房價，報價引擎算出來的住宿費用
--   security_deposit 押金，每筆固定（settings.security_deposit_amount），可退款、不算房價
--   total_amount     訂單總額 ＝ room_amount + security_deposit
--   deposit          本次需匯訂金 ＝ room_amount × settings.deposit_percent%（以房價為基數，不含押金）
--   尾款             ＝ total_amount − deposit（沿用既有的 balance_due 算法）
--
-- 改版前 total_amount 存的是「房價」、deposit 要人工到 Google 試算表填。
-- 既有資料回填：把原本的 total_amount 當成房價，押金補 0（不是 3000——過去這些訂單
-- 實際上沒收押金，硬填會讓歷史金額對不上帳），total_amount 維持原值不動。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS room_amount NUMERIC;
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS security_deposit NUMERIC NOT NULL DEFAULT 0;

-- 這筆訂單的匯款截止時間（真實時間戳，不是給人看的字串）。訂房確認當下寫入
-- （見 line-webhook.ts 的 computePaymentDeadlineDate()），供「排程管理」的自動取消逾期
-- 未匯款訂單使用。改版前這個期限只算出來塞進訊息文字就丟掉、沒有存下來，所以沒辦法回填舊訂單。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS payment_deadline_at TIMESTAMPTZ;

-- 候補自動回報：訂單因為排不出房/檔期衝突被系統擋下（status='pending_manual_conflict'）時，
-- 順便記下「卡住它的是哪一筆訂單」——排程管理的候補排程（process_waitlist）會定期檢查這筆
-- 被監看的訂單有沒有「有結果」了（變成已預定，或取消/待退款/已退款），一旦有結果就自動重新
-- 試算一次報價並主動推播給客人，不用客人自己再問一次。只是「監看對象」，不要求精準對應到
-- 哪個房型卡到——監看對象一有動靜就重新試算，真正可不可以訂還是看當下即時房況，抓錯監看對象
-- 頂多晚一點才重新檢查，不影響正確性。重新試算過（不管成功或放棄）就會清空，不會一直重試。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS waitlist_blocked_by UUID REFERENCES public.bookings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_waitlist_blocked_by ON public.bookings(waitlist_blocked_by) WHERE waitlist_blocked_by IS NOT NULL;

-- 顧客在報價之後、還沒走完訂房流程之前，又丟了一組新的日期/人數要重新報價時，系統會另外開一筆
-- 新訂單，並在這裡記下它取代的是哪一筆舊訂單。兩個用途：
--   1. 重新報價時要把舊那筆排除在「這幾天哪些房被佔用」之外，否則客人會被自己上一筆訂單擋住，
--      新報價永遠算不出來。
--   2. 新訂單被顧客確認（回「是」）的當下，把舊那筆一併取消——舊訂單如果還停在「待預定」則是
--      在重新報價的當下就直接取消（那個狀態沒鎖房，留著沒有意義）。
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS supersedes_booking_id UUID REFERENCES public.bookings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_supersedes ON public.bookings(supersedes_booking_id) WHERE supersedes_booking_id IS NOT NULL;

UPDATE public.bookings SET room_amount = total_amount WHERE room_amount IS NULL AND total_amount IS NOT NULL;

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

-- 訂單狀態第二次改版（2026-08）：9 步驟主流程＋3 步驟例外分支，取代原本 10 種狀態。
-- 新增 awaiting_confirmation（待確認）／checked_in（入住中）／deposit_processing（押金處理）／
-- completed（已處理），細分「已收尾款」到「真正結案」之間的過程。
-- 舊 quoted（已報價）→ 併入 inquiring（待報價，本來就涵蓋「還沒報價」跟「已報價、等客人決定」兩種情況）
-- 舊 confirmed（已確認：已收尾款、等入住日到）→ 改名 awaiting_checkin（語意完全相同，只是原本的
-- 「已確認」在新流程裡不再適合當終點，改成入住前的等待狀態，入住當天/退房當天由排程自動推進到
-- checked_in／deposit_processing）。
UPDATE public.bookings SET status = 'inquiring' WHERE status = 'quoted';
UPDATE public.bookings SET status = 'awaiting_checkin' WHERE status = 'confirmed';

-- external_synced：第三方平台（Airbnb／Booking.com／Agoda／Trip）iCal 同步匯入用的系統專用狀態，
-- 見 bookingStatus.ts 的 SYSTEM_ONLY_STATUSES 說明。
ALTER TABLE public.bookings ADD CONSTRAINT bookings_status_check CHECK (status IN (
  'inquiring', 'awaiting_deposit', 'awaiting_confirmation', 'reserved', 'awaiting_balance',
  'awaiting_checkin', 'checked_in', 'deposit_processing', 'completed',
  'cancelled', 'awaiting_refund', 'refunded', 'pending_manual_conflict', 'external_synced'
));
DROP INDEX IF EXISTS idx_bookings_confirmed_dates; -- 舊索引，條件只認舊的 'confirmed' 狀態，被下面新的取代
DROP INDEX IF EXISTS idx_bookings_occupying_dates; -- 舊索引條件只認第一版的狀態集合，CREATE IF NOT EXISTS 不會更新既有索引的 WHERE 條件，要砍掉重建

CREATE INDEX IF NOT EXISTS idx_bookings_user ON public.bookings(line_user_id, created_at DESC);
-- 「佔用中」的狀態（房間已鎖定、還沒到取消/退款的訂單），供檔期衝突檢查跟房況行事曆使用
CREATE INDEX IF NOT EXISTS idx_bookings_occupying_dates ON public.bookings(checkin_date, checkout_date)
  WHERE status IN (
    'awaiting_deposit', 'awaiting_confirmation', 'reserved', 'awaiting_balance',
    'awaiting_checkin', 'checked_in', 'deposit_processing', 'completed',
    'pending_manual_conflict', 'external_synced'
  );
CREATE INDEX IF NOT EXISTS idx_bookings_order_number ON public.bookings(order_number);
-- 排程管理新增的三個自動狀態轉換都是「狀態=X 且日期到了」的查詢，各自建一個部分索引。
CREATE INDEX IF NOT EXISTS idx_bookings_reserved_checkin ON public.bookings(checkin_date) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS idx_bookings_awaiting_checkin_date ON public.bookings(checkin_date) WHERE status = 'awaiting_checkin';
CREATE INDEX IF NOT EXISTS idx_bookings_checked_in_checkout ON public.bookings(checkout_date) WHERE status = 'checked_in';
-- 排程管理的通知排程（尾款提醒／待預定匯款通知／押金處理通知／洗滌排程）各自的查詢條件。
CREATE INDEX IF NOT EXISTS idx_bookings_awaiting_balance_checkin ON public.bookings(checkin_date) WHERE status = 'awaiting_balance';
CREATE INDEX IF NOT EXISTS idx_bookings_awaiting_deposit_created ON public.bookings(created_at) WHERE status = 'awaiting_deposit';
CREATE INDEX IF NOT EXISTS idx_bookings_deposit_processing_checkout ON public.bookings(checkout_date) WHERE status = 'deposit_processing';

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
--   某張訂單的用量 = Σ（這張訂單開的每一間房 × 該房間的預設組合數量）× 這張訂單的換洗次數
--
--   換洗次數存在訂單上（bookings.linen_change_count），不是房間的固定屬性：
--   同樣住 3 晚，有的客人整趟只在退房後洗一次，有的中途想再洗一次，這是每趟住宿的實際
--   狀況，沒辦法在房間設定裡事先決定。
--
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

-- 每個房間的預設布巾組合：一間房整理一次要用哪些布巾、各幾件
CREATE TABLE IF NOT EXISTS public.room_type_linen_defaults (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_type_id UUID NOT NULL REFERENCES public.room_types(id) ON DELETE CASCADE,
    linen_item_id UUID NOT NULL REFERENCES public.linen_items(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1,
    UNIQUE (room_type_id, linen_item_id)
);

-- 換洗次數原本設計在這張表（幾晚換一次），後來改放到訂單上——同樣住 3 晚，有人只在
-- 退房後洗一次、有人中途想再洗一次，這是每趟住宿的狀況，不是房間的固定屬性。
-- 已經建過舊版欄位的資料庫用這行移除，沒建過的不受影響。
ALTER TABLE public.room_type_linen_defaults DROP COLUMN IF EXISTS change_every_nights;

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

-- 同 message_variables：只在整張表空的時候種預設值。
-- 用 ON CONFLICT 的話，管理員在「備品管理」刪掉的品項會在每次重跑腳本時復活。
INSERT INTO public.linen_items (category, spec, unit_price, display_order)
SELECT v.category, v.spec, v.unit_price, v.display_order
FROM (VALUES
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
) AS v(category, spec, unit_price, display_order)
WHERE NOT EXISTS (SELECT 1 FROM public.linen_items)
ON CONFLICT (category, spec) DO NOTHING;

-- 既有訂單的房間紀錄回填：LINE 個別租房的訂單有 booking_room_nights，可以直接推出開了哪幾間房。
-- 包棟與手動建立的訂單沒有任何房間資料，只能由管理員在訂單管理頁補選，這裡不亂猜。
INSERT INTO public.booking_rooms (booking_id, room_type_id)
SELECT DISTINCT booking_id, room_type_id FROM public.booking_room_nights
ON CONFLICT (booking_id, room_type_id) DO NOTHING;

-- ========================================================================
-- 8.9 排程管理
--
-- Netlify 排程函式的執行間隔是部署時寫死在 netlify.toml、後台無法動態改，所以做法是：
-- netlify/functions/scheduled-tasks-run.ts 每 15 分鐘固定跑一次（見 netlify.toml），
-- 檢查 next_run_at 到期的排程、依 task_type 執行對應邏輯，執行完再算出下一次時間。
-- 執行時間的計算邏輯見 src/lib/scheduleRecurrence.ts，後台編輯畫面跟 ticker 共用同一份，
-- 才不會兩邊算出不同答案。
--
-- task_type 目前只有 'cancel_unpaid_bookings'（取消逾期未匯款的訂單），
-- 之後新增排程類型（例如定時寄信、到期通知、LINE 分眾發送）都是多一個 task_type，
-- 不需要改這張表的結構——各類型專屬的參數放在 config JSONB 裡。
-- ========================================================================
CREATE TABLE IF NOT EXISTS public.scheduled_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    task_type TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    recurrence TEXT NOT NULL DEFAULT 'daily' CHECK (recurrence IN ('once', 'daily', 'weekly', 'monthly')),
    run_at_time TEXT NOT NULL DEFAULT '09:00', -- 'HH:MM'，24 小時制，台灣時間
    run_at_date DATE,     -- recurrence='once' 專用
    weekday INTEGER,      -- recurrence='weekly' 專用，0=週日...6=週六
    day_of_month INTEGER, -- recurrence='monthly' 專用，1-31；當月天數不足時自動用該月最後一天
    is_active BOOLEAN NOT NULL DEFAULT true,
    next_run_at TIMESTAMPTZ, -- ticker 查詢到期排程用這個欄位；單次排程執行後 is_active 會自動關閉
    last_run_at TIMESTAMPTZ,
    last_run_status TEXT, -- 'success' | 'failed'，還沒執行過是 NULL
    last_run_summary TEXT, -- 執行結果摘要，例如「取消了 3 筆逾期未匯款訂單」
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON public.scheduled_tasks(next_run_at) WHERE is_active = true;

-- recurrence 的合法值後來多了 'hourly'（每小時）跟 'every_n_minutes'（每 N 分鐘，google 行事曆同步用），
-- 但建表當下的 CHECK 只認得最早的四種——用跟 bookings.status 同一套「動態找舊 CHECK 名稱再砍掉重建」
-- 手法補上，這樣不管資料庫是哪個版本開始建的，重跑這份 schema 都能補齊到最新的合法值清單。
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.scheduled_tasks'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%recurrence%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.scheduled_tasks DROP CONSTRAINT %I', con_name);
  END IF;
END $$;
ALTER TABLE public.scheduled_tasks ADD CONSTRAINT scheduled_tasks_recurrence_check
  CHECK (recurrence IN ('once', 'every_n_minutes', 'hourly', 'daily', 'weekly', 'monthly'));

ALTER TABLE public.scheduled_tasks ADD COLUMN IF NOT EXISTS interval_minutes INTEGER; -- recurrence='every_n_minutes' 專用

-- 9. 啟用 RLS（僅限已登入使用者存取，用 DROP + CREATE 讓整份腳本可重複執行）
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_recipient_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ota_channels ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE public.special_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_capacity_pricing ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE public.scheduled_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow Auth Access" ON public.settings;
CREATE POLICY "Allow Auth Access" ON public.settings FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access States" ON public.user_states;
CREATE POLICY "Allow Auth Access States" ON public.user_states FOR ALL USING (auth.role() = 'authenticated');
-- line_channels 存的是各官方帳號的 access token / secret，等同密碼。
-- webhook 端一律用 service role key 讀取（略過 RLS），這裡只開放已登入的管理員，
-- 不讓 anon key 讀得到憑證。
DROP POLICY IF EXISTS "Allow Auth Access Line Channels" ON public.line_channels;
CREATE POLICY "Allow Auth Access Line Channels" ON public.line_channels FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Notification Groups" ON public.notification_recipient_groups;
CREATE POLICY "Allow Auth Access Notification Groups" ON public.notification_recipient_groups FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Line Groups" ON public.line_groups;
CREATE POLICY "Allow Auth Access Line Groups" ON public.line_groups FOR ALL USING (auth.role() = 'authenticated');
-- export_token 等同密碼（外部平台訂閱時無法帶 Authorization 標頭，只能靠網址裡的 token 驗證），
-- 一般前台不能讀到，只有已登入的管理員能在後台看到／管理。
DROP POLICY IF EXISTS "Allow Auth Access OTA Channels" ON public.ota_channels;
CREATE POLICY "Allow Auth Access OTA Channels" ON public.ota_channels FOR ALL USING (auth.role() = 'authenticated');
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
DROP POLICY IF EXISTS "Allow Auth Access Special Prices" ON public.special_prices;
CREATE POLICY "Allow Auth Access Special Prices" ON public.special_prices FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Allow Auth Access Room Capacity Pricing" ON public.room_capacity_pricing;
CREATE POLICY "Allow Auth Access Room Capacity Pricing" ON public.room_capacity_pricing FOR ALL USING (auth.role() = 'authenticated');
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
-- scheduled-tasks-run.ts 用 service role key 讀寫（略過 RLS），這裡開 RLS 只是不讓 anon key 直接存取，
-- 前端排程管理頁的存取要靠已登入的管理員 session。
DROP POLICY IF EXISTS "Allow Auth Access Scheduled Tasks" ON public.scheduled_tasks;
CREATE POLICY "Allow Auth Access Scheduled Tasks" ON public.scheduled_tasks FOR ALL USING (auth.role() = 'authenticated');

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

-- ========================================================================
-- 12. 既有資料補正
-- 這一節動的是「資料」不是「結構」，所以放在最後——上面所有表格與欄位都建好之後才執行。
-- 全新專案執行到這裡時資料表還是空的，這些語句只會影響 0 筆、不會出錯；
-- 既有專案重新執行整份腳本時才會實際補到資料。每一段都必須可重複執行不重複套用。
-- ========================================================================

-- 12.1 幫「報價訂房」類型的流程補上常見問法的觸發關鍵字，避免客人問「還有空房嗎」
-- 「一晚多少錢」這類問題時，繞過自動報價流程、掉進知識庫拿到一句「請提供資訊」
-- 卻沒有真的進入自動算價（知識庫 FAQ 只當備援，不會記住客人接下來回的日期/人數）。
--
-- 只針對啟用中、類型是「報價訂房」(flow_type='quote') 的流程加關鍵字，用 IN 比對
-- （客人句子裡出現就觸發），已經存在的關鍵字不會重複加。可重複執行不會出錯。
--
-- 關鍵字選字說明（避免跟其他常見問題誤觸發）：
--   有空房 / 還有房：對應「有空房嗎」「還有房間嗎」，避免用單獨的「房間」兩字，
--     因為「房間」也會出現在「房間設備壞了」「房間會打掃嗎」這類完全不相關的問題裡。
--   房價 / 多少錢：對應「房價多少」「一晚多少錢」，避免用單獨的「多少」，理由同上。
-- 執行完後建議自己到「LINE 自定訊息流程」頁打開這個流程看一下，確認關鍵字符合預期、
-- 也沒有跟其他流程重疊（存檔時後台會自動提醒重疊，但這裡是直接改資料庫、不會經過那個提醒）。
UPDATE public.booking_flows
SET
  trigger_rules = trigger_rules || COALESCE((
    SELECT jsonb_agg(jsonb_build_object('keyword', k, 'match', 'contains'))
    FROM unnest(ARRAY['有空房', '還有房', '房價', '多少錢']) AS k
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(trigger_rules) existing
      WHERE existing->>'keyword' = k
    )
  ), '[]'::jsonb),
  updated_at = now()
WHERE flow_type = 'quote' AND is_active = true;

-- 執行後查詢確認結果：
-- SELECT name, trigger_rules FROM public.booking_flows WHERE flow_type = 'quote' AND is_active = true;

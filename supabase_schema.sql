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

-- 3. 啟用 RLS
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow Auth Access" ON public.settings FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access States" ON public.user_states FOR ALL USING (auth.role() = 'authenticated');

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
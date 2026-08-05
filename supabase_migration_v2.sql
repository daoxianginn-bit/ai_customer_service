-- ============================================================
-- Migration v2：選單重組 + CRUD 化功能所需的資料表
-- 請在 Supabase SQL Editor 執行（在 supabase_schema.sql 之後執行一次即可）
-- ============================================================

-- [1] settings 表新增：對話紀錄保留天數（預設 3 天，可在後台調整）
ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS conversation_retention_days INTEGER DEFAULT 3;

-- [2] 知識庫項目（取代單一 reference_text / reference_file_url 欄位）
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

-- [3] 真人客服歷史紀錄（append-only，轉回 AI 時寫入一筆，不覆蓋）
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

-- [4] 完整對話紀錄（預設保留 3 天，由排程功能清除）
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

-- [5] 管理員個人資料（銜接 Supabase Auth 帳號，之後角色權限掛在這）
CREATE TABLE IF NOT EXISTS public.admin_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    role TEXT DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- [6] RLS（比照現有 policy 風格：僅限已登入使用者存取）
ALTER TABLE public.knowledge_base_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handover_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow Auth Access KB" ON public.knowledge_base_items;
CREATE POLICY "Allow Auth Access KB" ON public.knowledge_base_items FOR ALL USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow Auth Access Handover Logs" ON public.handover_logs;
CREATE POLICY "Allow Auth Access Handover Logs" ON public.handover_logs FOR ALL USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow Auth Access Conversations" ON public.conversations;
CREATE POLICY "Allow Auth Access Conversations" ON public.conversations FOR ALL USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS "Allow Auth Access Profiles" ON public.admin_profiles;
CREATE POLICY "Allow Auth Access Profiles" ON public.admin_profiles FOR ALL USING (auth.role() = 'authenticated');

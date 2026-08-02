# 🤖 企業級 AI 客服系統 (LINE + Supabase + React)

這是一個完整、現代化的 AI 客服解決方案。整合了 **OpenAI GPT-5/4**、**Google Gemini 3/1.5**，並具備知識庫（PDF/純文字）讀取能力與 LINE 真人客服轉接系統。

---

## 🌟 功能亮點

*   **頂級 AI 支援**：首創支援 GPT-5 (Responses API) 與 Gemini 3 (Thinking Level) 最新規格。
*   **多模態知識庫**：可直接上傳產品手冊 (PDF) 或輸入文字，讓 AI 成為領域專家。
*   **Google 試算表問答庫**：用一張試算表管理「分類／問題 → 標準答案」的 FAQ 知識庫，AI 回答時意思必須與您寫的答案一致（僅可潤飾語氣），未命中則依系統指令與參考資料自由回答。
*   **真人轉接系統**：自動偵測關鍵字，即時發送 LINE 推送通知給客服專員。
*   **訂房報價引擎（開發中）**：房型、定價、包棟方案、加人規則、旺季／連假日期區間皆可在後台維護，報價由程式碼確定性計算（非 AI 生成），確保金額不會算錯。目前為 Phase 1（資料設定 + 後台試算工具），尚未串接 LINE 對話。
*   **極致穩定性**：內建資料庫級去重機制，解決 LINE Webhook 重複發送導致的誤觸問題。
*   **現代化後台**：使用 React + Tailwind CSS 打造，支援深色模式與行動裝置。

---

## 🚀 快速安裝手冊

請依照以下四個步驟完成您的系統搭建：

### 步驟一：獲取專案程式碼
您可以選擇以下 **其中一種** 方式開始：

#### 方案 A：標準 Fork (推薦)
1.  點擊頁面右上角的 **Fork** 按鈕，將此專案複製到您的 GitHub 帳號。
2.  這能讓您自由修改程式碼並保有自己的版本紀錄。

#### 方案 B：一鍵自動部署 (最快)
點擊下方按鈕，Netlify 會自動幫您 Fork 專案並連結部署：

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/scorpioliu0953/ai_customer_service)

---

### 步驟二：Supabase 資料庫設定
1.  登入 [Supabase 控制台](https://supabase.com/) 並建立一個新專案。
2.  **執行 SQL 腳本**：
    *   點擊左側 **SQL Editor** -> **New Query**。
    *   複製並貼上本頁下方的 **[完整資料庫腳本]** 並執行。
3.  **建立管理員**：
    *   前往 **Authentication > Users** -> **Add User**。
    *   手動建立一組 Email 與密碼（用於登入客服後台）。

### 步驟三：Netlify 雲端設定
1.  進入您的 Netlify 專案控制台。
2.  在 **Site configuration > Environment variables** 中設定以下四個必填變數：

| 變數名稱 | 來源 (Supabase Project Settings > API) | 說明 |
| :--- | :--- | :--- |
| `VITE_SUPABASE_URL` | **Project URL** | 前端連接資料庫 |
| `VITE_SUPABASE_ANON_KEY` | **API Key (anon/public)** | 前端公開金鑰 |
| `SUPABASE_URL` | **Project URL** | 後端 Function 呼叫 (與前端相同) |
| `SUPABASE_SERVICE_ROLE_KEY` | **API Key (service_role)** | **絕對機密！** 後端專用最高權限 |

3.  設定完畢後，前往 **Deploys** 點擊 **Trigger deploy** 重新發布，使變數生效。

### 步驟四：LINE Messaging API 串接
1.  登入 [LINE Developers Console](https://developers.line.biz/)。
2.  建立 Provider 與 Messaging API Channel。
3.  將以下資訊填入您的 **AI 客服後台 > 系統設定** 中：
    *   `Channel Access Token`
    *   `Channel Secret`
4.  **設定 Webhook**：
    *   在 LINE 後台將 Webhook URL 設為：`https://您的專案名稱.netlify.app/.netlify/functions/line-webhook`
    *   開啟 **"Use webhook"** 選項。

### 步驟五：Google 試算表知識庫設定（選填，FAQ 問答用）

若您希望顧客詢問常見問題（訂房查詢、價格、付款、入住、退房...）時，AI 能依照您預先寫好的標準答案回覆，可以串接 Google 試算表：

1.  **建立試算表**：新增一份 Google 試算表，欄位格式如下（第一列為標題列）：

    | A 欄：category 分類（選填） | B 欄：question 問題 | C 欄：answer 答案 |
    | :--- | :--- | :--- |
    | 訂房查詢 | 還有房間嗎？有空房嗎？ | （您的回覆文字）|
    | 價格 | 一晚多少錢？房價怎麼算？ | （您的回覆文字）|
    | 付款 | 可以刷卡嗎？怎麼付訂金？ | （您的回覆文字）|
    | 入住 | 幾點可以入住？入住須知有哪些？ | （您的回覆文字）|
    | 退房 | 幾點要退房？可以延遲退房嗎？ | （您的回覆文字）|

    B 欄支援兩種寫法，系統會自動判斷：
    *   **完整問句**（如「還有房間嗎？有空房嗎？」）：AI 會判斷使用者輸入與哪一筆「意思最相符」，命中後回答意思必須與該筆 C 欄答案一致（可換句話說讓語氣更自然，但不能新增、刪除或竄改任何事實、數字、日期、金額、政策）。
    *   **逗號分隔的短關鍵字**（如「房型,房型介紹」）：使用者輸入若**精準命中**其中一個關鍵字，會直接以該筆 C 欄答案潤飾語氣後回覆，不經過一般問答判斷。

    若使用者的問題不在試算表清單中，AI 才會依「系統設定」中的指令與參考資料自由回答；若不確定答案，AI 會誠實告知並建議使用者聯繫真人客服，不會編造內容。

2.  **建立 Google 服務帳戶（Service Account）**：
    *   前往 [Google Cloud Console](https://console.cloud.google.com/) 建立一個新專案（或使用現有專案）。
    *   在左側選單找到 **API 和服務 > 程式庫**，搜尋並啟用 **Google Sheets API**。
    *   前往 **API 和服務 > 憑證** -> **建立憑證** -> **服務帳戶**，依指示建立完成。
    *   建立完成後點進該服務帳戶 -> **金鑰** 分頁 -> **新增金鑰** -> 選擇 **JSON** 格式下載。
    *   打開下載的 JSON 檔，裡面的 `client_email` 就是服務帳戶 Email，`private_key` 就是私鑰。

3.  **將試算表共用給服務帳戶**：
    *   回到您的 Google 試算表，點右上角 **共用**。
    *   貼上服務帳戶的 Email（`xxxxx@xxxxx.iam.gserviceaccount.com`），權限設為 **檢視者** 即可，取消勾選「通知使用者」後送出。

4.  **在 Netlify 設定環境變數**：

    | 變數名稱 | 來源 | 說明 |
    | :--- | :--- | :--- |
    | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | JSON 金鑰裡的 `client_email` | 後端 Function 讀取試算表用 |
    | `GOOGLE_PRIVATE_KEY` | JSON 金鑰裡的 `private_key`（含 `-----BEGIN PRIVATE KEY-----` 完整內容） | 後端專用，**絕對機密**，請勿外流 |

    設定完成後，同樣要到 **Deploys > Trigger deploy > Clear cache and deploy site** 重新部署才會生效。

5.  **在後台填入試算表 ID**：
    *   進入 **AI 客服後台 > AI 指令與知識庫**，找到「Google 試算表知識庫」區塊。
    *   從試算表網址 `https://docs.google.com/spreadsheets/d/【這一段就是試算表ID】/edit` 複製 ID 填入。
    *   若使用多分頁，可額外填入分頁 GID（網址結尾 `#gid=數字` 的那個數字），預設為 `0`（第一頁）。

6.  **比對邏輯說明**：使用者傳訊息進來後，系統會依序嘗試三層比對，只要任一層命中就不會往下走：
    *   **Tier 1 精準關鍵字**：訊息完整包含 B 欄內容（逗號分隔關鍵字模式）時，直接用該筆 C 欄答案潤飾語氣回覆，速度最快、零額外 AI 成本。
    *   **Tier 1.5 AI 語意路由**：Tier 1 沒命中時，會多打一次 AI，請 AI 只從試算表清單中挑出語意最相符的一筆（例如使用者問「付款方式」，可對應到 B 欄「怎麼付款？」），命中後一樣只潤飾語氣、不能竄改答案內容，確保只要試算表有寫答案，回覆意思一定跟您寫的一致。
    *   **Tier 2 一般問答**：以上都沒命中，才把整份試算表當參考資料，讓 AI 依系統指令自由回答；若不確定，AI 會誠實告知並建議使用者聯繫真人客服。

### ⚠️ 若圖文選單已有 LINE 官方「自動回應」，請避免與 AI 重複回覆

若您在 **LINE 官方帳號管理後台**（[manager.line.biz](https://manager.line.biz/)）另外針對圖文選單按鈕設定了「自動回應/關鍵字回覆」功能，要注意：LINE 會把使用者點擊按鈕送出的**同一則文字訊息**同時送進「LINE 原生自動回應」與「本系統的 Webhook」，導致顧客會收到**兩則回覆**（LINE 官方的固定回覆 + 本系統 AI 又多回一次，甚至內容互相矛盾）。

解法：進入 **AI 客服後台 > 系統設定**，在「AI 略過不回覆的訊息」欄位填入這些按鈕的文字（逗號分隔，訊息中有包含就會略過，不需要完全相同），例如：
```
房型介紹, 設施及設備, 民宿位置, 入住須知
```
設定後，AI 收到這些訊息會直接略過、不再另外回覆，畫面上只會保留 LINE 原生的自動回應，不會重複。

---

## 📜 完整資料庫腳本 (SQL)

請將以下內容完整複製並在 Supabase SQL Editor 中執行：

```sql
-- [1] 系統設定表
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
    knowledge_sheet_id TEXT DEFAULT '',
    knowledge_sheet_gid TEXT DEFAULT '0',
    line_channel_access_token TEXT,
    line_channel_secret TEXT,
    handover_keywords TEXT DEFAULT '真人,客服,人工',
    handover_timeout_minutes INTEGER DEFAULT 30,
    agent_user_ids TEXT DEFAULT '',
    skip_ai_keywords TEXT DEFAULT ''
);

-- [2] 用戶狀態表
CREATE TABLE IF NOT EXISTS public.user_states (
    line_user_id TEXT PRIMARY KEY,
    nickname TEXT,
    is_human_mode BOOLEAN DEFAULT false,
    last_human_interaction TIMESTAMP WITH TIME ZONE,
    last_ai_reset_at TIMESTAMP WITH TIME ZONE,
    last_event_id TEXT, -- LINE 去重機制關鍵
    conversation_history TEXT DEFAULT '[]' -- AI 對話記憶：最近幾輪對話紀錄（JSON 陣列）
);

-- [3] 事件去重表
CREATE TABLE IF NOT EXISTS public.processed_events (
    event_id TEXT PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- [4] 安全權限設定 (RLS)
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow Auth Access" ON public.settings FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Allow Auth Access States" ON public.user_states FOR ALL USING (auth.role() = 'authenticated');

-- [5] 初始化預設資料
INSERT INTO public.settings (id) SELECT gen_random_uuid() WHERE NOT EXISTS (SELECT 1 FROM public.settings);

-- [6] 儲存空間 (Storage) 權限設定
INSERT INTO storage.buckets (id, name, public) VALUES ('knowledge_base', 'knowledge_base', true) ON CONFLICT (id) DO NOTHING;
CREATE POLICY "Allow Public Select" ON storage.objects FOR SELECT TO public USING (bucket_id = 'knowledge_base');
CREATE POLICY "Allow Auth Insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'knowledge_base');
CREATE POLICY "Allow Auth Update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'knowledge_base');
CREATE POLICY "Allow Auth Delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'knowledge_base');
```

> **既有專案升級提醒**：若您先前已建立過資料庫，上方的 `CREATE TABLE IF NOT EXISTS` 不會自動補上新欄位，請額外執行以下語句以支援「Google 試算表知識庫」「AI 略過重複回覆」與「AI 對話記憶」功能：
> ```sql
> ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS knowledge_sheet_id TEXT DEFAULT '';
> ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS knowledge_sheet_gid TEXT DEFAULT '0';
> ALTER TABLE public.settings ADD COLUMN IF NOT EXISTS skip_ai_keywords TEXT DEFAULT '';
> ALTER TABLE public.user_states ADD COLUMN IF NOT EXISTS conversation_history TEXT DEFAULT '[]';
> ```

### 🧠 AI 對話記憶

AI 會記住每位顧客最近約 3 輪（6 則）的對話內容，超過 30 分鐘沒有新訊息則視為新話題、不再帶入舊的對話紀錄。這讓顧客可以像「有哪幾種房型？」→「好，麻煩介紹」這樣自然接續發問，AI 也能正確理解上下文，不會答非所問。此功能僅記錄「AI 回覆」的對話，轉真人客服期間的訊息不會計入。

### 🏨 訂房報價（Phase 1：資料設定 + Phase 2：LINE 對話流程）

新增「訂房管理」後台頁面（側邊選單），用來維護：

*   **房型與定價**：房型名稱、樓層、容納人數，以及各定價 tier（平日／小假日／連假／旺季／定價）的價格。某個 tier 留空＝該 tier 不開放個別租房（只能包棟），之後把價格填上即可自動開放，不需要另外維護「開放日期」。
*   **個別租房「加人不加房」**：每個房型可設定「最多加人數」與各 tier 的每人加價（例如 4 人房最多加 1 人變 5 人）。報價時系統會同時算出「加開房」與「加人不加房」兩種方案（例如 5 人時，是要多開一間小房間、還是在已選的房間加床加價），兩種都呈現讓顧客選，不會自動幫顧客決定。
*   **包棟方案與定價（可開關）**：頁面上有「啟用包棟方案」開關，不需要包棟功能的民宿可以直接關掉、整塊設定收起來。啟用後，只要輸入動人數，系統會用跟「個別租房」同一套演算法**自動建議房型組合**（打勾即可，不用手打「4+4+2」這種文字），加人規則就在同一張卡片下方，不用來回切換。
*   **自動報價總表**：包棟方案卡片最下方會即時算出每個人數、每個 tier 的最終價格，並自動跟「個別租房」比較、標示「包棟省 NT$X」，不需要自己心算或一組一組用測試報價確認。人數卡在兩個級距中間時（例如 11、13、15人），會多顯示「開房」（直接跳去用更大級距的整組價格）跟「不開房」（維持較小級距、超額用加人規則計算）兩種價格供比較。
*   **旺季／連假日期區間**：完全由後台「訂房管理」頁面新增/編輯/刪除；一般日期（不在旺季/連假）純粹依星期幾判斷平日(日~四)/小假日(五~六)。另有「旺季期間的平日要套用哪種價格」開關：預設不分平假日一律旺季價，也可以改成旺季期間的平日（日~四）套用平日價、小假日（五、六）仍是旺季價；同時套用在個別租房與包棟。
*   **促銷方案**：可新增多組「名稱＋折扣%」的促銷方案，存在資料庫可重複使用，測試報價時選用，折扣只套用在入住第一晚。
*   **連住折扣**：固定金額折扣（不分 tier），分「需打掃」／「無需打掃」兩種金額，套用在第二晚（含）以後的每一晚。這是民宿自訂政策、不是問顧客的選項，另外可設定「LINE 自動報價套用哪一種」，LINE 對話流程會自動套用這個預設類型，跟後台測試報價選同一種類型時金額會一致。
*   **測試報價工具（支援多晚）**：輸入日期、人數、晚數、要不要套用促銷方案、第二晚起需不需要打掃，系統會逐晚判斷 tier 各自算價，第一晚套促銷%、第二晚起套連住折扣固定金額，個別租房與包棟分別加總比較，用畫面上目前（含尚未儲存）的資料試算，方便調整完馬上驗證。

**整頁採「暫存＋單一儲存」設計**：所有新增/修改/刪除都只會先反映在畫面上，按頁面右上角「儲存變更」才會真正寫入資料庫，避免不小心異動誤觸就直接生效。

目前報價計算完全由程式碼確定性運算（`src/lib/bookingEngine.ts`），AI 不參與金額計算，避免報價出錯。

#### Phase 2：LINE 訂房對話流程

顧客訊息包含「訂房觸發關鍵字」（後台可設定，預設「我要訂房,訂房」）就會開始追蹤這位顧客的訂房詢問狀態：

1. AI 只負責從對話中**擷取**入住日期、退房日期、人數、是否包棟等欄位（絕對不計算晚數或金額），欄位不齊全就用固定文字詢問還缺什麼
2. 欄位齊全後，晚數＝退房日期－入住日期，由**程式碼**確定性計算（避免像實測發現的「7/30 入住、7/31 退房被誤算成兩晚」這種 AI 自己算錯的情況）
3. 呼叫 `computeMultiNightQuote()` 算出正確報價，AI 只負責把數字包裝成口語化回覆
4. 顧客回答「是否包棟：是」就直接呈現包棟報價，答「否」則呈現個別租房報價；「是否有小朋友」「是否有特殊需求」純資訊性附註在回覆裡，不影響報價
5. 顧客分好幾則訊息才回答完所有欄位也沒關係，狀態會保留；超過 30 分鐘沒有新回覆就視為放棄這次詢問

**目前範圍只到自動報價，不會產生訂單編號或處理訂金／退款**（那是後續規劃中的 Phase 3），回覆結尾會提醒顧客仍需真人客服確認才算完成訂房。

完整資料表結構請參考 [`supabase_schema.sql`](./supabase_schema.sql) 中的 `room_types`、`room_pricing`、`room_extra_person_pricing`、`whole_house_packages`、`whole_house_package_pricing`、`whole_house_package_rooms`、`whole_house_extra_person_rules`、`promotions`、`booking_date_ranges`。若您先前已建立過資料庫，請執行該檔案第 7 節的升級用 SQL。

---

## 🛠️ 本地開發環境

如果您想修改程式碼，建議使用以下方式同步雲端環境變數：

```bash
# 1. 安裝依賴
npm install

# 2. 安裝 Netlify CLI (推薦)
npm install -g netlify-cli

# 3. 連結雲端專案並啟動
netlify login
netlify link
netlify dev
```

---

## ⚖️ 免責聲明
本專案僅供學習與企業原型搭建使用。請確保在使用 AI API (OpenAI/Google) 時遵守相關服務條款，並妥善保護您的 API 金鑰。
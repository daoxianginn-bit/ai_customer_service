# Supabase 登入相關設定

程式碼改不到的部分，需要到 Supabase 後台手動設定。改完不用重新部署，是即時生效的。

---

## 目前的登入機制

- **零公開註冊**：只有被邀請的 Google 信箱能進來，其他人用 Google 登入會被直接擋下並登出。
- **強制 Google 登入**：不提供密碼登入。
- **強制雙因素驗證**：每次登入都要輸入 Google Authenticator 的 6 位數驗證碼。
  沒通過 2FA 的登入狀態（aal1）在資料庫層就被擋住，一張表都讀不到。

### 新同事上線的完整流程

1. 管理員在「帳號管理 → 邀請新帳號」輸入對方的 **Google 信箱** 與角色
2. 系統寄出邀請信（效期 24 小時）
3. 對方點開信件 → 邀請確認頁 → 點「使用 Google 登入」
4. 系統核對 Google 帳號的信箱與邀請是否完全一致，不一致直接拒絕
5. 強制綁定 Google Authenticator（掃 QR Code → 輸入 6 碼）
6. 綁定完成，帳號狀態變成「已啟用」，開始使用

> 如果對方沒收到信（例如進了垃圾郵件），不用重寄也可以：
> 請他直接到登入頁點「使用 Google 登入」即可。真正的把關是邀請名單比對，
> 不是信件本身。

---

## 一、URL 設定（**必做，否則邀請信連結會指向 localhost:3000**）

**Authentication → URL Configuration**

| 欄位 | 要填的值 |
|---|---|
| **Site URL** | 你的正式網址，例如 `https://your-site.netlify.app` |
| **Redirect URLs** | 加入這幾筆（一行一筆）：<br>`https://your-site.netlify.app/**`<br>`http://localhost:5173/**`（本機開發用，不需要可省略） |

> `Redirect URLs` 一定要加。Supabase 只允許導回這份清單裡的網址，不在清單裡的會被忽略、
> 退回 Site URL——那就又變回連到 localhost 的問題了。用 `/**` 萬用字元一次涵蓋所有子路徑最省事。

### Netlify 環境變數（建議加）

**Site settings → Environment variables** 新增：

```
PUBLIC_SITE_URL = https://your-site.netlify.app
```

不加也可以運作（程式會自動用 Netlify 內建的 `URL` 變數），但自訂網域時明確指定比較保險。

---

## 二、Google 登入設定（**必做，不設定就完全無法登入**）

### 1. Google Cloud Console

1. 建立專案 → **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type 選 **Web application**
3. **Authorized redirect URIs** 填入 **Supabase 的網址**（不是你自己的網站，原因見下方說明）：
   ```
   https://<你的專案代號>.supabase.co/auth/v1/callback
   ```
   > 專案代號在 Supabase 後台 **Settings → API → Project URL** 可以看到，
   > 把那個網址後面接上 `/auth/v1/callback` 就是要填的內容。
4. 建立後取得 **Client ID** 與 **Client Secret**

### 2. Supabase 後台

**Authentication → Providers → Google** → 開啟，貼上 Client ID 與 Client Secret → Save。

### 為什麼 Google 那格要填 Supabase 的網址？

這裡有**兩個都叫 redirect 的設定**，很容易搞混。先看 Google 登入實際的流程：

```
① 使用者在你的網站點「使用 Google 登入」
      ↓
② 瀏覽器跳到 Google 登入畫面
      ↓
③ 使用者同意授權
      ↓
④ Google 把結果送回 ★Supabase★      ← Google 的 Authorized redirect URIs
      ↓
⑤ Supabase 驗證完，把使用者送回 ★你的網站★  ← Supabase 的 Redirect URLs
      ↓
⑥ 使用者回到你的網站，已登入
```

關鍵在第 ④ 步：Google **不會**直接把結果送回你的網站，而是送給 Supabase——
因為持有 Client Secret、負責跟 Google 交換憑證的是 Supabase，不是瀏覽器裡的前端程式碼
（Secret 放前端等於公開）。所以 Google 那邊登記的接收位址是 Supabase 的。

| 設定位置 | 欄位名稱 | 填誰的網址 | 對應步驟 |
|---|---|---|---|
| Google Cloud Console | Authorized redirect URIs | **Supabase 的** | ④ |
| Supabase 後台 | Redirect URLs（本文第一節） | **你的網站的** | ⑤ |

兩個都要設定，缺一個登入就會在對應的那一步失敗。

---

## 三、把邀請信改成中文

**Authentication → Emails → Templates**，選 **Invite user** 分頁。

### 主旨（Subject heading）

```
【AI 客服後台】您的帳號邀請
```

### 內容（Message body）

```html
<div style="font-family:-apple-system,'Segoe UI','Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1f2937;line-height:1.7;">

  <h2 style="margin:0 0 8px;font-size:20px;color:#111827;">AI 客服後台 · 帳號邀請</h2>
  <p style="margin:0 0 24px;color:#6b7280;font-size:14px;">您好，管理員已為您建立一組後台帳號。</p>

  <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;margin-bottom:24px;">
    <tr>
      <td style="padding:12px 16px;color:#6b7280;font-size:14px;width:90px;">登入帳號</td>
      <td style="padding:12px 16px;font-size:14px;font-weight:600;">{{ .Email }}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">您的角色</td>
      <td style="padding:12px 16px;font-size:14px;font-weight:600;border-top:1px solid #e5e7eb;">{{ .Data.invited_role_label }}</td>
    </tr>
    <tr>
      <td style="padding:12px 16px;color:#6b7280;font-size:14px;border-top:1px solid #e5e7eb;">邀請人</td>
      <td style="padding:12px 16px;font-size:14px;border-top:1px solid #e5e7eb;">{{ .Data.invited_by }}</td>
    </tr>
  </table>

  <p style="margin:0 0 12px;font-size:15px;font-weight:600;">接下來要做兩件事：</p>
  <ol style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#374151;">
    <li style="margin-bottom:6px;">點下方按鈕，用<strong>這個 Google 帳號</strong>登入</li>
    <li>用手機的 <strong>Google Authenticator</strong> 掃描 QR Code 完成雙因素驗證綁定</li>
  </ol>

  <p style="margin:0 0 28px;">
    <a href="{{ .ConfirmationURL }}"
       style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;">
      接受邀請並登入
    </a>
  </p>

  <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
    ⚠️ 這個邀請 24 小時內有效，逾時請聯繫管理員重新寄送。
  </p>
  <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
    ⚠️ 必須使用與上方相同的 Google 帳號登入，使用其他帳號會被系統拒絕。
  </p>
  <p style="margin:0 0 24px;font-size:13px;color:#6b7280;">
    如果您並未預期收到這封信，請直接忽略即可，不會有任何帳號被啟用。
  </p>

  <p style="margin:0;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
    按鈕無法點擊時，請複製以下網址貼到瀏覽器：<br>
    <span style="word-break:break-all;">{{ .ConfirmationURL }}</span>
  </p>

</div>
```

> `{{ .Data.invited_role_label }}` 與 `{{ .Data.invited_by }}` 讀的是建立帳號時寫入的
> user metadata，由 `netlify/functions/invite-admin.ts` 帶入。改那支函式的欄位名稱時，
> 這裡也要跟著改，否則信裡會空白。

---

## 四、緊急處理：管理員自己遺失驗證器

一般情況下，**管理員可以在「帳號管理」點盾牌圖示幫其他人重置 2FA**，對方下次登入重新綁定即可。

但如果**系統唯一的管理員自己遺失手機**，就沒有人能幫他重置了。這時要直接到
**Supabase 後台 → SQL Editor** 執行下面的指令（用你自己的信箱取代 `你的信箱@gmail.com`）：

```sql
-- 1) 解除該帳號目前綁定的所有驗證器
DELETE FROM auth.mfa_factors
WHERE user_id = (SELECT id FROM auth.users WHERE email = '你的信箱@gmail.com');

-- 2) 把帳號退回「待綁定 2FA」，下次登入會重新要求掃描 QR Code
UPDATE public.admin_profiles
SET status = 'pending_mfa', mfa_enrolled_at = NULL
WHERE id = (SELECT id FROM auth.users WHERE email = '你的信箱@gmail.com');

-- 3) 清掉失敗次數的鎖定（如果剛才試錯太多次被鎖住）
DELETE FROM public.mfa_login_attempts
WHERE user_id = (SELECT id FROM auth.users WHERE email = '你的信箱@gmail.com');
```

執行完直接回登入頁用 Google 登入，就會走到重新綁定驗證器的畫面。

### 其他救援情境

**完全沒有任何管理員可用**（例如唯一的管理員帳號被刪掉了）：

```sql
-- 把指定帳號提升為管理員並退回待綁定 2FA
UPDATE public.admin_profiles
SET role = 'admin', status = 'pending_mfa'
WHERE id = (SELECT id FROM auth.users WHERE email = '你的信箱@gmail.com');
```

---

## 五、其他信件樣板（選用）

同一個地方（**Authentication → Emails → Templates**）還有幾個分頁，目前都還是英文預設值。

| 分頁 | 什麼時候會寄 | 現在會用到嗎 |
|---|---|---|
| **Invite user** | 管理員從帳號管理寄邀請 | ✅ 會（上面已提供中文版） |
| **Confirm signup** | 使用者自行註冊需驗證信箱 | 用不到（不開放自行註冊） |
| **Reset password** | 使用者忘記密碼 | 用不到（不提供密碼登入） |
| **Magic Link** | 免密碼登入連結 | 用不到 |

# Supabase 登入相關設定

程式碼改不到的部分，需要到 Supabase 後台手動設定。改完不用重新部署，是即時生效的。

---

## 一、修正邀請信連結指向 localhost:3000

邀請信裡的連結會變成 `http://localhost:3000/#access_token=...`，是因為 Supabase 專案的
**Site URL** 還是預設值。有兩個地方要改：

### 1. Supabase 後台

**Authentication → URL Configuration**

| 欄位 | 要填的值 |
|---|---|
| **Site URL** | 你的正式網址，例如 `https://your-site.netlify.app` |
| **Redirect URLs** | 加入這兩筆（一行一筆）：<br>`https://your-site.netlify.app/**`<br>`http://localhost:5173/**`（本機開發用，不需要可省略） |

> `Redirect URLs` 一定要加，而且要包含 `/set-password`。Supabase 只允許導回這份清單裡的網址，
> 不在清單裡的會被忽略、退回 Site URL——那就又變回原本的問題了。用 `/**` 萬用字元一次涵蓋所有子路徑最省事。

### 2. Netlify 環境變數（建議加，但非必要）

**Site settings → Environment variables** 新增：

```
PUBLIC_SITE_URL = https://your-site.netlify.app
```

不加也可以運作（程式會自動用 Netlify 內建的 `URL` 變數），但自訂網域的情況下明確指定比較保險。

---

## 二、把信件改成中文

**Authentication → Emails → Templates**，選 **Invite user** 分頁。

### 主旨（Subject heading）

```
【AI 客服後台】您的帳號已建立，請設定密碼
```

### 內容（Message body）

把原本的英文整段刪掉，換成下面這段：

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

  <p style="margin:0 0 16px;font-size:15px;">請點下面的按鈕設定您的登入密碼，設定完成後就能直接進入後台：</p>

  <p style="margin:0 0 28px;">
    <a href="{{ .ConfirmationURL }}"
       style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:15px;">
      設定密碼並啟用帳號
    </a>
  </p>

  <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
    ⚠️ 這個連結有時效性，逾時請聯繫管理員重新寄送。
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

### 這封信為什麼能寫出「角色」和「邀請人」

`{{ .Data.xxx }}` 讀的是建立帳號時寫入的 user metadata。
`netlify/functions/invite-admin.ts` 在寄邀請時已經帶入 `invited_role_label` 與 `invited_by`，
所以樣板才取得到。**如果你改了那支函式裡的欄位名稱，這裡也要跟著改**，否則信裡會是空白。

---

## 三、Google 登入設定

### 1. Google Cloud Console

1. 建立專案 → **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type 選 **Web application**
3. **Authorized redirect URIs** 填入（注意是 Supabase 的網址，不是你的網站）：
   ```
   https://<你的專案代號>.supabase.co/auth/v1/callback
   ```
4. 建立後取得 **Client ID** 與 **Client Secret**

### 2. Supabase 後台

**Authentication → Providers → Google** → 開啟，貼上剛才的 Client ID 與 Client Secret → Save。

---

## 四、其他信件樣板（選用）

同一個地方（**Authentication → Emails → Templates**）還有這幾個分頁，目前都還是英文預設值。
現在系統用不到的可以先不管，之後有需要再照上面的格式改成中文：

| 分頁 | 什麼時候會寄 | 現在會用到嗎 |
|---|---|---|
| **Invite user** | 管理員從帳號管理寄邀請 | ✅ 會（上面已提供） |
| **Reset password** | 使用者忘記密碼 | 目前登入頁沒有「忘記密碼」入口，暫時用不到 |
| **Confirm signup** | 使用者自行註冊需驗證信箱 | 用不到（本系統不開放自行註冊，一律 Google 登入或管理員邀請） |
| **Magic Link** | 免密碼登入連結 | 用不到 |

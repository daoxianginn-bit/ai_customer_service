// LINE 推播相關的共用判斷（前端表單與 Netlify functions 都用）。

/** LINE 的 user ID：U 開頭加 32 碼十六進位。群組（C 開頭）、多人聊天室（R 開頭）不是個人。 */
const LINE_USER_ID_RE = /^U[0-9a-fA-F]{32}$/;

export function isLineUserId(id: unknown): boolean {
  return typeof id === 'string' && LINE_USER_ID_RE.test(id.trim());
}

/**
 * LINE API 失敗時，SDK 拋出的錯誤訊息只有「Request failed with status code 400」——LINE 真正說的
 * 原因（哪個欄位、為什麼）在回應內文裡。不取出來的話，錯誤紀錄只看得到 400，分不出是收件人 ID 錯、
 * 訊息太長還是其他問題。
 *
 * 舊版 Client（axios）把回應放在 originalError.response；新版（fetch）放在 status／body。兩種都讀。
 */
export function lineErrorDetail(e: any): { status: number | null; message: string; invalidRecipient: boolean } {
  const status: number | null = e?.statusCode ?? e?.status ?? e?.originalError?.response?.status ?? null;
  let body: any = e?.originalError?.response?.data ?? e?.body ?? null;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { /* 不是 JSON 就保留原字串 */ }
  }
  const details: { message?: string; property?: string }[] = Array.isArray(body?.details) ? body.details : [];
  const parts = [
    typeof body === 'string' ? body : body?.message,
    ...details.map((d) => [d.property, d.message].filter(Boolean).join(': ')),
  ].filter(Boolean);
  // 收件人不對時 LINE 回「The property, 'to', in the request body is invalid」：ID 打錯、不是 user ID，
  // 或是別的官方帳號的聯絡人（LINE user ID 只在它所屬的官方帳號有效）。
  const invalidRecipient = status === 400 && (details.some((d) => d.property === 'to') || /'to'/.test(String(body?.message ?? body ?? '')));
  return { status, message: parts.join('；') || e?.message || '未知錯誤', invalidRecipient };
}

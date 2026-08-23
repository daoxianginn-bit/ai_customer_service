// 前端專用的操作紀錄寫入捷徑：自動帶入目前登入者的帳號，呼叫端不用每次自己去問 auth。
// 純邏輯（欄位中文對照、前後比對）在 operationLog.ts，那份 Netlify functions 也會用到，
// 不能 import 這個檔案——supabase.ts 走的是瀏覽器端的 import.meta.env。
import { supabase } from './supabase';
import { OperationLogEntry, writeOperationLog } from './operationLog';

let cachedActor: string | null = null;

/** 目前登入者的帳號（email）。查不到時退回 '未知帳號'，不要讓紀錄整筆寫不進去。 */
async function currentActor(): Promise<string> {
  if (cachedActor) return cachedActor;
  try {
    const { data } = await supabase.auth.getUser();
    cachedActor = data.user?.email || data.user?.id || '未知帳號';
  } catch {
    cachedActor = '未知帳號';
  }
  return cachedActor;
}

export async function logOperation(entry: Omit<OperationLogEntry, 'actorType' | 'actorName'>): Promise<void> {
  await writeOperationLog(supabase, { ...entry, actorType: 'user', actorName: await currentActor() });
}

/**
 * 後台操作失敗時記一筆。原本這些錯誤只會 alert 一次，關掉分頁就什麼都不剩，
 * 使用者事後回報「昨天存不起來」時完全無從查起。
 */
export async function logUiError(params: {
  feature: string;
  action: string;
  target?: string | null;
  error: unknown;
}): Promise<void> {
  const err = params.error as any;
  await writeOperationLog(supabase, {
    feature: params.feature,
    action: params.action,
    target: params.target ?? null,
    actorType: 'user',
    actorName: await currentActor(),
    level: 'error',
    // Supabase 的錯誤帶 code（例如 23505 唯一鍵衝突），一併留下來比只有訊息好查很多。
    statusCode: typeof err?.status === 'number' ? err.status : null,
    errorMessage: [err?.message || String(err), err?.code ? `code: ${err.code}` : '', err?.details || '']
      .filter(Boolean)
      .join(' | '),
  });
}

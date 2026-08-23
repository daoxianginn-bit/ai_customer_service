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

import { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withErrorLogging } from '../../src/lib/operationLog';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const rawHandler: Handler = async () => {
  const { data: settings } = await supabase.from('settings').select('conversation_retention_days').single();
  const retentionDays = settings?.conversation_retention_days ?? 3;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const { error, count } = await supabase
    .from('conversations')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);

  if (error) {
    console.error('[Cleanup] Failed to delete old conversations:', error.message);
    return { statusCode: 500, body: error.message };
  }

  console.log(`[Cleanup] Deleted ${count ?? 0} conversations older than ${retentionDays} days`);
  return { statusCode: 200, body: `Deleted ${count ?? 0} rows` };
};

// 4XX/5XX 與未攔截的例外統一寫進「操作紀錄」，不然出錯時只剩 Netlify 的 function log 可查。
export const handler: Handler = withErrorLogging(supabase, 'cleanup-conversations', rawHandler);

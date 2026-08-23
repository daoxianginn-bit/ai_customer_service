import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ScrollText, Search, RotateCcw, ListFilter, UserCog, CalendarDays, ArrowRight } from 'lucide-react';
import { PageHeader, Button, EmptyState } from '../components/ui';
import { LOG_FEATURE_OPTIONS, formatLogValue } from '../lib/operationLog';

const PAGE_SIZE = 30;

interface LogRow {
  id: string;
  feature: string;
  action: string;
  target: string | null;
  actor_type: 'user' | 'system';
  actor_name: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const ACTION_STYLE: Record<string, string> = {
  新增: 'bg-green-50 text-green-700 border-green-200',
  修改: 'bg-blue-50 text-blue-700 border-blue-200',
  狀態變更: 'bg-amber-50 text-amber-700 border-amber-200',
  刪除: 'bg-red-50 text-red-700 border-red-200',
  批次刪除: 'bg-red-50 text-red-700 border-red-200',
};

// 異動前後並排，一行一個欄位。只列出真的有變的欄位（寫入時就已經比對過，見 operationLog.ts），
// 所以這裡不用再過濾，直接把兩邊的鍵聯集起來顯示即可。
function ChangeTable({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = Array.from(new Set([...Object.keys(before || {}), ...Object.keys(after || {})]));
  if (keys.length === 0) return <span className="text-xs text-gray-400">—</span>;

  return (
    <div className="space-y-1">
      {keys.map((key) => (
        <div key={key} className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-gray-500 shrink-0">{key}</span>
          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 break-all">
            {formatLogValue(before?.[key])}
          </span>
          <ArrowRight className="w-3 h-3 text-gray-300 shrink-0" />
          <span className="px-1.5 py-0.5 rounded bg-green-50 text-green-800 border border-green-100 break-all">
            {formatLogValue(after?.[key])}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function OperationLogs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [keyword, setKeyword] = useState('');
  const [feature, setFeature] = useState('');
  const [actorType, setActorType] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    runQuery(0);
  }, []);

  const runQuery = async (
    pageIndex: number,
    overrides?: Partial<{ keyword: string; feature: string; actorType: string; startDate: string; endDate: string }>
  ) => {
    const eff = {
      keyword: overrides?.keyword ?? keyword,
      feature: overrides?.feature ?? feature,
      actorType: overrides?.actorType ?? actorType,
      startDate: overrides?.startDate ?? startDate,
      endDate: overrides?.endDate ?? endDate,
    };
    setLoading(true);

    let query = supabase
      .from('operation_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE - 1);

    if (eff.feature) query = query.eq('feature', eff.feature);
    if (eff.actorType) query = query.eq('actor_type', eff.actorType);
    if (eff.startDate) query = query.gte('created_at', `${eff.startDate}T00:00:00`);
    // 迄日要含當天：日期欄位選 8/23 時，使用者要的是「8/23 整天」，不是 8/23 00:00 那一瞬間。
    if (eff.endDate) query = query.lt('created_at', `${eff.endDate}T23:59:59.999`);
    if (eff.keyword.trim()) {
      const kw = eff.keyword.trim().replace(/[%,()]/g, '');
      query = query.or(`target.ilike.%${kw}%,actor_name.ilike.%${kw}%,action.ilike.%${kw}%`);
    }

    const { data, error } = await query;
    if (!error) {
      setRows((data || []) as LogRow[]);
      setHasMore((data || []).length === PAGE_SIZE);
    }
    setPage(pageIndex);
    setLoading(false);
  };

  const clearFilters = () => {
    setKeyword('');
    setFeature('');
    setActorType('');
    setStartDate('');
    setEndDate('');
    runQuery(0, { keyword: '', feature: '', actorType: '', startDate: '', endDate: '' });
  };

  return (
    <div className="w-full space-y-5">
      <PageHeader
        icon={<ScrollText className="w-6 h-6 text-green-600" />}
        title="操作紀錄"
        description="查詢系統裡的資料被誰、在什麼時候、從什麼改成什麼。人工操作與系統自動異動都會記錄。"
      />

      <div className="bg-white p-4 rounded-xl shadow-sm border space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><Search className="w-3.5 h-3.5" />關鍵字</label>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runQuery(0)}
              placeholder="訂單編號、帳號或動作"
              className="w-full px-3 py-2 border rounded-lg text-sm"
            />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><ListFilter className="w-3.5 h-3.5" />功能</label>
            <select value={feature} onChange={(e) => setFeature(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">全部功能</option>
              {LOG_FEATURE_OPTIONS.map((f) => (<option key={f} value={f}>{f}</option>))}
            </select>
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><UserCog className="w-3.5 h-3.5" />異動者</label>
            <select value={actorType} onChange={(e) => setActorType(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm bg-white">
              <option value="">全部</option>
              <option value="user">使用者</option>
              <option value="system">系統</option>
            </select>
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><CalendarDays className="w-3.5 h-3.5" />起始日期</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
          <div>
            <label className="flex items-center gap-1 text-xs text-gray-500 mb-1"><CalendarDays className="w-3.5 h-3.5" />結束日期</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border rounded-lg text-sm" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={clearFilters} icon={<RotateCcw className="w-4 h-4" />}>清除條件</Button>
          <Button onClick={() => runQuery(0)} loading={loading} icon={<Search className="w-4 h-4" />}>查詢</Button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 border-b">
              <tr className="text-gray-600">
                <th className="py-3 px-4 whitespace-nowrap">更新時間</th>
                <th className="py-3 px-4 whitespace-nowrap">功能</th>
                <th className="py-3 px-4 whitespace-nowrap">動作</th>
                <th className="py-3 px-4 whitespace-nowrap">對象</th>
                <th className="py-3 px-4 whitespace-nowrap">異動者</th>
                <th className="py-3 px-4 min-w-[280px]">異動前 → 異動後</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="py-10 text-center text-gray-400">載入中...</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={6}><EmptyState icon={<ScrollText className="w-12 h-12 text-gray-200" />} message="查無操作紀錄" /></td></tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-gray-50">
                    <td className="py-3 px-4 whitespace-nowrap text-gray-500 text-xs">{formatDateTime(row.created_at)}</td>
                    <td className="py-3 px-4 whitespace-nowrap text-gray-700">{row.feature}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${ACTION_STYLE[row.action] || 'bg-gray-50 text-gray-600 border-gray-200'}`}>
                        {row.action}
                      </span>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap font-mono text-xs text-gray-600">{row.target || '—'}</td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {row.actor_type === 'system' ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">系統</span>
                      ) : (
                        <span className="text-xs text-gray-700">{row.actor_name}</span>
                      )}
                    </td>
                    <td className="py-3 px-4"><ChangeTable before={row.before} after={row.after} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center px-6 py-4 border-t text-sm text-gray-500">
          <button disabled={page === 0 || loading} onClick={() => runQuery(page - 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">上一頁</button>
          <span>第 {page + 1} 頁</span>
          <button disabled={!hasMore || loading} onClick={() => runQuery(page + 1)} className="px-3 py-1 border rounded-lg disabled:opacity-40">下一頁</button>
        </div>
      </div>
    </div>
  );
}

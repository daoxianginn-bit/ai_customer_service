import type { ReactNode } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * 一份欄位定義、兩種呈現：桌機給真正的 <table>，手機把每一列攤成一張卡片。
 *
 * 為什麼不是用 CSS 把 table 變成 block 就好——那種做法要在每個 <td> 上掛 data-label，
 * 欄位名稱會散在各處跟表頭重複一份；而且「手機上這欄不重要、不用顯示」這種判斷
 * 用 CSS 表達不了。改成一份欄位設定，兩邊都從它產生，就不會有兩份走鐘的版面。
 */
export type ResponsiveColumn<T> = {
  key: string;
  /** 表頭文字。也是手機卡片上的欄位標籤，所以請寫人看得懂的名稱而不是欄位代號。 */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  thClass?: string;
  tdClass?: string;
  /** 手機卡片的標題（每張卡最上面那行）。只有第一個標記的欄位會生效。 */
  cardTitle?: boolean;
  /** 手機卡片：貼在標題右側。狀態徽章、啟用開關這類一眼要看到的東西放這裡。 */
  cardAside?: boolean;
  /** 手機卡片：收進底部的操作列，不顯示欄位標籤。 */
  cardActions?: boolean;
  /** 手機卡片：整欄不顯示。桌機看得到、手機嫌佔位的次要欄位用這個。 */
  cardHidden?: boolean;
  /** 手機卡片：橫跨兩欄。內容較長的欄位（備註、設備清單）用這個才不會擠成一直條。 */
  cardFullWidth?: boolean;
  /**
   * 這一格的點擊不要冒泡成整列的 onRowClick。
   * 格子裡放開關或按鈕時一定要開，否則按開關會順便觸發「開啟編輯」。
   */
  stopRowClick?: boolean;
};

type Props<T> = {
  columns: ResponsiveColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  loadingText?: string;
  /** 沒有資料時顯示的內容，通常放 <EmptyState /> */
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** 依資料列回傳額外 class（例如依狀態上底色），表格列與卡片共用同一份。 */
  rowClass?: (row: T) => string;
};

/**
 * 可點擊的列預設給一個淺綠 hover，但頁面自己在 rowClass 裡指定 hover 樣式時要讓開——
 * 同時出現 hover:bg-green-50 和 hover:bg-red-50 的話，誰贏是看 Tailwind 產生的 CSS 順序，
 * 不是看 class 寫的順序，結果會變成看運氣。
 */
function defaultHover(onRowClick: unknown, rowClass?: string): string {
  if (!onRowClick) return '';
  return rowClass?.includes('hover:') ? '' : 'hover:bg-green-50';
}

export default function ResponsiveTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  loadingText = '載入中...',
  empty,
  onRowClick,
  rowClass,
}: Props<T>) {
  const isMobile = useIsMobile();

  if (loading) {
    return <p className="py-10 text-center text-gray-400 text-sm">{loadingText}</p>;
  }
  if (!rows.length) {
    return <>{empty}</>;
  }

  if (!isMobile) {
    return (
      // 表格比容器寬時讓表格自己捲，不要把整頁撐出橫向捲軸。
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 border-b">
            <tr className="text-gray-600">
              {columns.map((c) => (
                <th key={c.key} className={`py-3 px-4 ${c.thClass || ''}`}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={`${onRowClick ? 'cursor-pointer transition-colors' : ''} ${defaultHover(onRowClick, rowClass?.(row))} ${rowClass?.(row) || ''}`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`py-3 px-4 ${c.tdClass || ''}`}
                    onClick={c.stopRowClick ? (e) => e.stopPropagation() : undefined}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const titleCol = columns.find((c) => c.cardTitle);
  const asideCols = columns.filter((c) => c.cardAside);
  const actionCols = columns.filter((c) => c.cardActions);
  const bodyCols = columns.filter(
    (c) => !c.cardTitle && !c.cardAside && !c.cardActions && !c.cardHidden,
  );

  return (
    <div className="divide-y divide-gray-100">
      {rows.map((row) => (
        <div
          key={rowKey(row)}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
          className={`px-4 py-3 ${onRowClick ? 'cursor-pointer active:bg-green-50' : ''} ${rowClass?.(row) || ''}`}
        >
          <div className="flex items-start justify-between gap-2">
            {titleCol && (
              <div className="min-w-0 flex-1 font-semibold text-gray-800 text-sm">{titleCol.cell(row)}</div>
            )}
            {asideCols.length > 0 && (
              <div className="flex shrink-0 items-center gap-2">
                {asideCols.map((c) => (
                  <div key={c.key} onClick={c.stopRowClick ? (e) => e.stopPropagation() : undefined}>
                    {c.cell(row)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {bodyCols.length > 0 && (
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
              {bodyCols.map((c) => (
                <div key={c.key} className={`min-w-0 ${c.cardFullWidth ? 'col-span-2' : ''}`}>
                  <dt className="text-[11px] text-gray-400">{c.header}</dt>
                  {/* 卡片有的是縱向空間，長字串換行就好，不像表格那樣得截斷才排得下。 */}
                  <dd className="text-sm text-gray-700 break-words">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          )}

          {actionCols.length > 0 && (
            <div className="mt-2 flex items-center justify-end gap-1">
              {actionCols.map((c) => (
                <div key={c.key} onClick={c.stopRowClick ? (e) => e.stopPropagation() : undefined}>
                  {c.cell(row)}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

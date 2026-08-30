import { useState, type ReactNode } from 'react';
import { SlidersHorizontal, ChevronDown } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';

/**
 * 查詢條件的外框。桌機完全維持原樣（一直攤開），手機預設收起來。
 *
 * 起因：這幾頁的篩選區有 4～6 個欄位，在手機上垂直堆疊會吃掉整個第一屏，
 * 使用者得先滑過一整頁才看得到第一筆資料——而多數時候他只是想看預設清單。
 *
 * 收起來會讓「目前有沒有在篩」變成隱藏狀態，所以標題列一定要顯示生效中的條件數量，
 * 否則使用者會以為資料不見了。activeCount 由各頁自己算，因為只有頁面知道哪些值算「有填」。
 */
export default function FilterBar({
  activeCount = 0,
  always,
  children,
}: {
  activeCount?: number;
  /**
   * 收起來時仍然要看得到的內容。快速篩選膠囊放這裡——那是手機上最好按的控制項，
   * 一下就能切換，藏起來等於把最有用的東西收走。
   */
  always?: ReactNode;
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  if (!isMobile) {
    return (
      <div className="bg-white p-4 rounded-xl shadow-sm border space-y-3">
        {children}
        {always}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 py-3 text-sm"
      >
        <SlidersHorizontal className="w-4 h-4 text-gray-500 shrink-0" />
        <span className="font-medium text-gray-700">查詢條件</span>
        {activeCount > 0 && (
          <span className="px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-medium">
            {activeCount}
          </span>
        )}
        <ChevronDown
          className={`w-4 h-4 text-gray-400 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="px-4 pb-4 pt-3 space-y-3 border-t">{children}</div>}
      {/* 常駐區排在最後，緊貼下面的資料清單——切篩選跟看結果的距離越短越好。 */}
      {always && <div className="px-4 py-3 border-t">{always}</div>}
    </div>
  );
}

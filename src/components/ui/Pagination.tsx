interface PaginationProps {
  page: number; // 0-indexed
  hasMore: boolean;
  onPrev: () => void;
  onNext: () => void;
  label?: string;
}

export default function Pagination({ page, hasMore, onPrev, onNext, label }: PaginationProps) {
  return (
    <div className="flex justify-between items-center px-6 py-4 border-t text-sm text-gray-500">
      <button disabled={page === 0} onClick={onPrev} className="px-3 py-1 border rounded-lg disabled:opacity-40 hover:bg-gray-50">上一頁</button>
      <span>{label || `第 ${page + 1} 頁`}</span>
      <button disabled={!hasMore} onClick={onNext} className="px-3 py-1 border rounded-lg disabled:opacity-40 hover:bg-gray-50">下一頁</button>
    </div>
  );
}

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  inquiring: { label: '待報價', className: 'bg-gray-100 text-gray-600' },
  pending_confirmation: { label: '待確認', className: 'bg-yellow-100 text-yellow-700' },
  confirmed: { label: '已確認', className: 'bg-green-100 text-green-700' },
  cancelled: { label: '已取消', className: 'bg-red-100 text-red-600' },
  pending_manual_conflict: { label: '待人工確認', className: 'bg-orange-100 text-orange-700' },
  open: { label: '進行中', className: 'bg-red-100 text-red-700' },
  closed: { label: '已結束', className: 'bg-gray-100 text-gray-600' },
};

interface StatusBadgeProps {
  status: string;
  label?: string; // 覆蓋預設文字（例如已知文字但狀態代碼不在對照表裡時）
}

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] || { label: label || status, className: 'bg-gray-100 text-gray-600' };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${config.className}`}>
      {label || config.label}
    </span>
  );
}

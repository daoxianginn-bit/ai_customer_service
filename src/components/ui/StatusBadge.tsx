import { ALL_BOOKING_STATUSES } from '../../lib/bookingStatus';

const BOOKING_STATUS_CONFIG: Record<string, { label: string; className: string }> = Object.fromEntries(
  ALL_BOOKING_STATUSES.map((s) => [s.value, { label: s.label, className: s.badgeClassName }])
);

// 訂單狀態以外的其他狀態代碼（例如真人客服轉接紀錄），跟訂單狀態不共用同一份定義。
const OTHER_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  open: { label: '進行中', className: 'bg-red-100 text-red-700' },
  closed: { label: '已結束', className: 'bg-gray-100 text-gray-600' },
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  ...BOOKING_STATUS_CONFIG,
  ...OTHER_STATUS_CONFIG,
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

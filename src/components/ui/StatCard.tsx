import { ReactNode } from 'react';

interface StatCardProps {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  valueClassName?: string;
  sublabel?: string;
}

export default function StatCard({ icon, label, value, valueClassName = 'text-gray-800', sublabel }: StatCardProps) {
  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-col gap-2">
      <span className="text-sm text-gray-500 flex items-center gap-1">{icon} {label}</span>
      <span className={`text-lg font-bold ${valueClassName}`}>{value}</span>
      {sublabel && <span className="text-xs text-gray-400">{sublabel}</span>}
    </div>
  );
}

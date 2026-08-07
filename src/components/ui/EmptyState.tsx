import { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  message: string;
}

export default function EmptyState({ icon, message }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 py-16 text-gray-400">
      {icon}
      <p>{message}</p>
    </div>
  );
}

import { ReactNode } from 'react';

interface PageHeaderProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

export default function PageHeader({ icon, title, description, action }: PageHeaderProps) {
  return (
    <div className="bg-white p-6 rounded-xl shadow-sm border flex flex-wrap justify-between items-start gap-4">
      <div>
        <h2 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
          {icon}
          {title}
        </h2>
        {description && <p className="text-gray-500 mt-1">{description}</p>}
      </div>
      {action}
    </div>
  );
}

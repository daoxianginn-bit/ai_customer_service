import { useState, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

interface CollapsibleSectionProps {
  title: string;
  icon?: ReactNode;
  description?: string;
  headerExtra?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function CollapsibleSection({
  title,
  icon,
  description,
  headerExtra,
  defaultOpen = false,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
      <div className="flex justify-between items-start gap-4 p-6 border-b">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-start gap-2 text-left flex-1 min-w-0"
        >
          <ChevronRight className={`w-5 h-5 text-gray-400 mt-0.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          <span className="min-w-0">
            <span className="text-lg font-bold text-gray-800 flex items-center gap-2 flex-wrap">
              {icon}
              {title}
            </span>
            {description && <p className="text-sm text-gray-500 mt-1">{description}</p>}
          </span>
        </button>
        {headerExtra}
      </div>
      {open && <div>{children}</div>}
    </div>
  );
}

import { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string; // Tailwind max-w-* class
}

export default function Modal({ open, title, onClose, children, footer, maxWidth = 'max-w-2xl' }: ModalProps) {
  if (!open) return null;
  // 一定要 portal 到 body：留在原地的話，只要祖先有 transform（MUI 的收合動畫就會產生），
  // position:fixed 的定位基準就變成那個祖先而不是視窗，inset-0 會鋪不滿整個畫面。
  // z 值取 1300 對齊 MUI Dialog——後台外殼的 AppBar 是 1201，比它低就會被蓋住標題列。
  return createPortal(
    // 手機佔滿整個畫面（不留邊、不圓角）：表單本來就長，375px 上再讓出邊界只是把可填的空間變更小。
    // sm 以上維持原本置中的卡片。maxWidth 不用加斷點前綴——手機上 w-full 一定小於它，它不會生效。
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center sm:p-4 z-[1300]">
      <div className={`bg-white w-full ${maxWidth} flex flex-col h-full sm:h-auto sm:max-h-[90vh] sm:rounded-xl sm:shadow-xl overflow-hidden`}>
        {/* 改成 flex 直排、只有中間內容捲動：footer 的送出鈕因此永遠貼在底部看得到，
            不像原本靠 sticky——長表單在手機上捲到一半找不到送出鈕是最常見的抱怨。 */}
        <div className="flex justify-between items-center p-4 sm:p-6 border-b shrink-0">
          <h3 className="text-lg font-bold text-gray-800">{title}</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 sm:p-6 space-y-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="flex justify-end gap-2 p-4 sm:p-6 border-t shrink-0">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

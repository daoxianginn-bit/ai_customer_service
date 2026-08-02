import { useRef } from 'react';

interface MessageTemplateEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholders: string[]; // 不含方括號，例如 ['姓名', '入住日期']
  rows?: number;
  placeholder?: string;
}

/**
 * 罐頭訊息編輯器：文字框 + 快捷插入按鈕，點按鈕會把 [欄位名稱] 插入到目前游標位置
 * （沒有選取位置就插在最後面），插入後游標自動移到 token 後方方便接著打字。
 */
export default function MessageTemplateEditor({ value, onChange, placeholders, rows = 8, placeholder }: MessageTemplateEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertPlaceholder = (name: string) => {
    const token = `[${name}]`;
    const el = textareaRef.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-3 py-2 border rounded-lg font-mono text-sm"
      />
      {placeholders.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {placeholders.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => insertPlaceholder(p)}
              className="px-3 py-1 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full border border-gray-200"
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

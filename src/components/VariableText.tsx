import { parseTemplateSegments, ALWAYS_AVAILABLE_VARIABLES } from '../lib/messageVariables';

interface VariableTextProps {
  value: string;
  knownVariables: string[];
  className?: string;
}

/**
 * 檢視模式的訊息內容：把 [變數名稱] 渲染成綠色標籤，其餘保留原本的換行與空白。
 * 跟 MessageTemplateEditor 共用 parseTemplateSegments()，確保「哪些算變數」兩邊判斷一致；
 * 差別只在這裡不用跟 textarea 對齊字元寬度，所以標籤可以用真的 padding，看起來更接近 LINE 官方後台。
 */
export default function VariableText({ value, knownVariables, className = '' }: VariableTextProps) {
  const known = new Set([...knownVariables, ...ALWAYS_AVAILABLE_VARIABLES]);
  const segments = parseTemplateSegments(value);

  if (!value.trim()) {
    return <p className={`text-sm text-gray-400 italic ${className}`}>（尚未填寫內容）</p>;
  }

  return (
    <p className={`text-sm text-gray-800 whitespace-pre-wrap break-words leading-7 ${className}`}>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.value}</span>
        ) : known.has(seg.name) ? (
          <span key={i} className="inline-block align-baseline px-1.5 py-0.5 mx-0.5 rounded bg-green-600 text-white text-xs font-medium">
            {seg.name}
          </span>
        ) : (
          <span
            key={i}
            title="這個變數不在「訊息變數資料維護」清單裡，送出時不會被替換"
            className="inline-block align-baseline px-1.5 py-0.5 mx-0.5 rounded bg-amber-200 text-amber-900 text-xs font-medium"
          >
            {seg.name}？
          </span>
        )
      )}
    </p>
  );
}

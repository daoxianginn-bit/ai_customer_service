import { useMemo, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { parseTemplateSegments, findUnknownVariables, ALWAYS_AVAILABLE_VARIABLES, PlaceholderGroup } from '../lib/messageVariables';

interface MessageTemplateEditorProps {
  value: string;
  onChange: (v: string) => void;
  placeholders: string[]; // 不含方括號，例如 ['姓名', '入住日期']
  /**
   * 有給就把快捷插入改成兩層（先選分區、再點變數）。變數一多時，一整排幾十顆按鈕
   * 要用眼睛掃過去才找得到想要的；分區之後對應的是使用者本來就熟悉的訂單表單區塊。
   * 沒給就維持原本的一排按鈕，呼叫端不用一次全部改。
   */
  placeholderGroups?: PlaceholderGroup[];
  rows?: number;
  placeholder?: string;
}

// 疊在 textarea 底下的著色層樣式必須跟 textarea 完全一致（字型、字級、行高、內距、邊框寬度），
// 差一個 px 游標就會對不到字。改這裡時兩邊要一起改。
const SHARED_TEXT_CLASS = 'w-full px-3 py-2 border rounded-lg font-mono text-sm leading-6';

// 標籤只能用 background + box-shadow 來做出「有內距」的視覺，不能真的加 padding／改字級——
// 那會讓著色層比 textarea 的純文字寬，同一行後面的字就全部歪掉。
// box-shadow 是往外擴散、不佔版面空間，所以看起來有留白但寬度完全不變。
const KNOWN_CHIP_STYLE = { backgroundColor: '#16a34a', color: '#ffffff', boxShadow: '0 0 0 1.5px #16a34a' };
const UNKNOWN_CHIP_STYLE = { backgroundColor: '#fde68a', color: '#78350f', boxShadow: '0 0 0 1.5px #fde68a' };

// ALWAYS_AVAILABLE_VARIABLES 裡不是每個都適合放進快選按鈕：[入住密碼] 只有「排程管理」的
// 入住提醒範本用得到，其他地方點了也不會有值，放進來只會誤導。這裡只挑「任何範本都能用」的
// 那幾個，跟 findUnknownVariables() 用的完整清單刻意分開。
const QUICK_INSERT_EXTRA_VARIABLES = ['今日日期', '明日日期'];

/**
 * 罐頭訊息編輯器：文字框 + 快捷插入按鈕，點按鈕會把 [欄位名稱] 插入到目前游標位置
 * （沒有選取位置就插在最後面），插入後游標自動移到 token 後方方便接著打字。
 *
 * 打字時 [變數名稱] 會即時顯示成綠色標籤，跟 LINE 官方後台的「好友的顯示名稱」一樣，
 * 讓編輯者一眼看得出哪一段是會被替換掉的。作法是「透明文字的 textarea 疊在著色層上」，
 * 而不是 contentEditable——contentEditable 配中文輸入法在組字階段很容易吃掉字或跳游標。
 */
export default function MessageTemplateEditor({ value, onChange, placeholders, placeholderGroups, rows = 8, placeholder }: MessageTemplateEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  // 目前展開的分區。預設第一區，這樣打開就看得到東西，不會是一片空白。
  const [activeGroup, setActiveGroup] = useState('');

  const knownNames = useMemo(() => new Set([...placeholders, ...ALWAYS_AVAILABLE_VARIABLES]), [placeholders]);
  const segments = useMemo(() => parseTemplateSegments(value), [value]);
  const unknownNames = useMemo(() => findUnknownVariables(value, placeholders), [value, placeholders]);
  const quickInsertNames = useMemo(
    () => [...placeholders, ...QUICK_INSERT_EXTRA_VARIABLES.filter((n) => !placeholders.includes(n))],
    [placeholders]
  );

  const insertPlaceholder = (name: string) => {
    const token = `[${name}]`;
    const el = textareaRef.current;
    if (!el) {
      onChange(value + token);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // 中文輸入法組字中的暫定字串不在 value 裡，此時著色層會比實際看到的內容短。
  // 組字期間直接把著色層藏起來、讓 textarea 自己顯示文字，避免使用者看到殘影。
  const syncScroll = () => {
    if (backdropRef.current && textareaRef.current) {
      backdropRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div>
      <div className="relative">
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`${SHARED_TEXT_CLASS} absolute inset-0 overflow-hidden whitespace-pre-wrap break-words border-transparent text-gray-800 ${composing ? 'invisible' : ''}`}
        >
          {segments.map((seg, i) =>
            seg.type === 'text' ? (
              <span key={i}>{seg.value}</span>
            ) : (
              <span key={i} className="rounded-[3px]" style={knownNames.has(seg.name) ? KNOWN_CHIP_STYLE : UNKNOWN_CHIP_STYLE}>
                {`[${seg.name}]`}
              </span>
            )
          )}
          {/* 內容以換行結尾時，補一個字元撐住最後一行的高度，否則捲動位置會跟 textarea 差一行 */}
          {'​'}
        </div>

        {/* textarea 上的 block 不能拿掉：預設 inline-block 會在下方多出一段基線間隙，
            讓 absolute inset-0 的著色層比 textarea 高 6px，捲動到底時最後一行會對不齊。 */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          rows={rows}
          placeholder={placeholder}
          spellCheck={false}
          className={`${SHARED_TEXT_CLASS} relative block resize-none bg-transparent caret-gray-900 ${composing ? 'text-gray-800' : 'text-transparent'} placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500/40`}
        />
      </div>

      {unknownNames.length > 0 && (
        <p className="flex items-start gap-1.5 mt-2 text-xs text-amber-700">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            {unknownNames.map((n) => `[${n}]`).join('、')} 不在「訊息變數資料維護」的清單裡，送出時不會被替換，會原樣出現在顧客的訊息中。
          </span>
        </p>
      )}

      {placeholderGroups && placeholderGroups.length > 0 ? (
        <div className="mt-2 space-y-2">
          <select
            value={activeGroup || placeholderGroups[0].label}
            onChange={(e) => setActiveGroup(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg text-sm bg-white"
          >
            {placeholderGroups.map((g) => (
              <option key={g.label} value={g.label}>{g.label}（{g.items.length}）</option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            {(placeholderGroups.find((g) => g.label === (activeGroup || placeholderGroups[0].label))?.items || []).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => insertPlaceholder(p)}
                className="px-3 py-1 text-xs bg-gray-100 hover:bg-green-100 hover:text-green-800 text-gray-700 rounded-full border border-gray-200 transition-colors"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      ) : quickInsertNames.length > 0 ? (
        <div className="flex flex-wrap gap-2 mt-2">
          {quickInsertNames.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => insertPlaceholder(p)}
              className="px-3 py-1 text-xs bg-gray-100 hover:bg-green-100 hover:text-green-800 text-gray-700 rounded-full border border-gray-200 transition-colors"
            >
              {p}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

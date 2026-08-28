import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  PlaceholderGroup,
  groupVariablesBySection,
  laundryItemName,
  LAUNDRY_SHEET_VARIABLES,
  LAUNDRY_SECTION_LABEL,
  LINEN_SECTION_LABEL,
  DEPOSIT_NOTICE_VARIABLES,
  DEPOSIT_SECTION_LABEL,
  BOOKING_NOTICE_VARIABLES,
  BOOKING_NOTICE_SECTION_LABEL,
} from '../lib/messageVariables';

/**
 * 範本編輯器的快捷插入清單，所有使用範本編輯器的地方（LINE 自定訊息流程、客製訊息發送、
 * 客製訊息發送的新增範本、排程管理的洗滌單與押金通知）共用這一份。
 *
 * 以前是各頁自己查 message_variables、自己組分區，只要有人改一邊就會跟其他地方走鐘
 * （實際發生過：新增範本的編輯器漏掉分區、客製訊息發送查完訂單後又用另一份清單蓋掉）。
 * 集中在這裡之後，分區規則只有一個出處。
 *
 * scope 只決定「哪些變數在這個編輯器算得出值」，不決定列出哪些——各處列出的分區刻意完全一樣，
 * 算不出值的那幾區標成 inert，編輯器會畫成警示色並在插入時提醒，而不是把它們藏起來。
 */
export type TemplateVariableScope = 'message' | 'laundry' | 'deposit' | 'booking';

export interface TemplateVariableBinding {
  placeholders: string[];
  placeholderGroups: PlaceholderGroup[];
}

const LAUNDRY_ONLY_NOTE = '只有排程管理的洗滌單算得出數量，插在這裡不會被替換，會原樣送出。';
const DEPOSIT_ONLY_NOTE = '只有排程管理的「入住中→押金處理」通知算得出金額，插在這裡不會被替換，會原樣送出。';
const NOTICE_ONLY_NOTE = '只有排程管理的彙整通知算得出來，插在這裡不會被替換，會原樣送出。';

export function useTemplateVariables(scope: TemplateVariableScope = 'message'): TemplateVariableBinding {
  const [binding, setBinding] = useState<TemplateVariableBinding>({ placeholders: [], placeholderGroups: [] });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const [variableRes, linenRes] = await Promise.all([
        supabase.from('message_variables').select('variable_name, field_key').order('display_order'),
        supabase.from('linen_items').select('category, spec, short_name, display_order').eq('is_active', true).order('display_order'),
      ]);
      if (cancelled) return;

      // 品項可能重名（例如兩筆都沒填洗滌單簡稱、分類又一樣），去重才不會有兩顆一模一樣的按鈕。
      const linenNames = [...new Set((linenRes.data || []).map(laundryItemName))];

      // [日期]／[訂單數] 每一種彙整通知都算得出來，不限洗滌單或押金——單獨一區，
      // 讓「已預定→待收尾款」「入住前提醒」這種沒有專屬數字的通知也有東西可以插。
      const isNotice = scope === 'laundry' || scope === 'deposit' || scope === 'booking';

      const groups: PlaceholderGroup[] = [
        ...groupVariablesBySection(variableRes.data || [], ['今日日期', '明日日期']),
        { label: BOOKING_NOTICE_SECTION_LABEL, items: BOOKING_NOTICE_VARIABLES, inert: !isNotice, note: NOTICE_ONLY_NOTE },
        { label: LAUNDRY_SECTION_LABEL, items: LAUNDRY_SHEET_VARIABLES, inert: scope !== 'laundry', note: LAUNDRY_ONLY_NOTE },
        { label: LINEN_SECTION_LABEL, items: linenNames, inert: scope !== 'laundry', note: LAUNDRY_ONLY_NOTE },
        { label: DEPOSIT_SECTION_LABEL, items: DEPOSIT_NOTICE_VARIABLES, inert: scope !== 'deposit', note: DEPOSIT_ONLY_NOTE },
      ].filter((g) => g.items.length > 0);

      setBinding({
        // placeholders 是「這個編輯器認得、不該跳黃色警告」的完整清單。inert 的變數也算認得
        // ——它們有另一套更精確的提醒（見 MessageTemplateEditor 的 inert 警告），
        // 混進「不在清單裡」的警告只會讓人以為是打錯字。
        placeholders: [...new Set(groups.flatMap((g) => g.items))],
        placeholderGroups: groups,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [scope]);

  return binding;
}

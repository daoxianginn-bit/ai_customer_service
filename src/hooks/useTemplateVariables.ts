import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  PlaceholderGroup,
  groupVariablesBySection,
  laundryItemName,
  LAUNDRY_SHEET_VARIABLES,
  LAUNDRY_SECTION_LABEL,
  LINEN_SECTION_LABEL,
} from '../lib/messageVariables';

/**
 * 範本編輯器的快捷插入清單，四個使用範本編輯器的地方（LINE 自定訊息流程、客製訊息發送、
 * 客製訊息發送的新增範本、排程管理的洗滌單）共用這一份。
 *
 * 以前是三個頁面各自查 message_variables、各自組分區，只要有人改一邊就會跟其他地方走鐘
 * （實際發生過：新增範本的編輯器漏掉分區、客製訊息發送查完訂單後又用另一份清單蓋掉）。
 * 集中在這裡之後，分區規則只有一個出處。
 *
 * scope 只決定「哪些變數在這個編輯器算得出值」，不決定列出哪些——四處列出的分區刻意完全一樣，
 * 算不出值的那幾區標成 inert，編輯器會畫成警示色並在插入時提醒，而不是把它們藏起來。
 */
export type TemplateVariableScope = 'message' | 'laundry';

export interface TemplateVariableBinding {
  placeholders: string[];
  placeholderGroups: PlaceholderGroup[];
}

const LAUNDRY_ONLY_NOTE = '只有排程管理的洗滌單算得出數量，插在這裡不會被替換，會原樣送出。';

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

      const linenNames = (linenRes.data || []).map(laundryItemName);
      // 品項可能重名（例如兩筆都沒填洗滌單簡稱、分類又一樣），去重才不會有兩顆一模一樣的按鈕。
      const uniqueLinenNames = [...new Set(linenNames)];
      const laundryInert = scope !== 'laundry';

      const groups: PlaceholderGroup[] = [
        ...groupVariablesBySection(variableRes.data || [], ['今日日期', '明日日期']),
        { label: LAUNDRY_SECTION_LABEL, items: LAUNDRY_SHEET_VARIABLES, inert: laundryInert, note: LAUNDRY_ONLY_NOTE },
        { label: LINEN_SECTION_LABEL, items: uniqueLinenNames, inert: laundryInert, note: LAUNDRY_ONLY_NOTE },
      ].filter((g) => g.items.length > 0);

      setBinding({
        // placeholders 是「這個編輯器認得、不該跳黃色警告」的完整清單。inert 的變數也算認得
        // ——它們有另一套更精確的提醒（見 MessageTemplateEditor 的 inert 警告），
        // 混進「不在清單裡」的警告只會讓人以為是打錯字。
        placeholders: groups.flatMap((g) => g.items),
        placeholderGroups: groups,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [scope]);

  return binding;
}

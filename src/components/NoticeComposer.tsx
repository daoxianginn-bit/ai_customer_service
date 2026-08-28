import { useEffect, useMemo, useState, ReactNode } from 'react';
import { X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import MessageTemplateEditor from './MessageTemplateEditor';
import { TemplateVariableBinding } from '../hooks/useTemplateVariables';

// ========================================================================
// 「自訂訊息傳送至指定群組與個人」共用元件。
//
// 排程管理裡每一種會發彙整通知的類型（洗滌單、押金通知、待收尾款通知、入住前提醒…）
// 都用這一個元件，不各自複製一份 JSX——這是刻意的：這區塊有帳號篩選、群組/聯絡人清單、
// 已勾選對象顯示、群組成員 tag 四件事糾纏在一起，複製出去就一定會走鐘。
// 要新增一種會發通知的排程，只要在 TASK_TYPE_OPTIONS 標 needsLineGroups 即可。
// ========================================================================

/** 通知收件人：群組或個別聯絡人都可以。channel_id 一定要一起存——LINE 的 push 目標
 *  不分 userId／groupId，但憑證要用該對象所屬官方帳號的，用錯帳號一定推不出去。 */
export interface NoticeRecipient { id: string; channel_id: string }
/** 要 @tag 的群組成員。name 只是顯示用，真正決定 tag 到誰的是 id（LINE user ID）。 */
export interface MentionMember { id: string; name?: string | null }

interface ChannelOption { id: string; name: string }
interface LineGroupOption { group_id: string; name: string | null; channel_id: string; chat_type?: string | null }
interface LineContactOption { line_user_id: string; nickname: string | null; channel_id: string }
interface GroupMemberOption { line_user_id: string; display_name: string | null; group_id: string }

interface Props {
  /** 「洗滌單」「押金通知」這種人看得懂的名字，用在各處文案上。 */
  label: string;
  template: string;
  onTemplateChange: (value: string) => void;
  recipients: NoticeRecipient[];
  onRecipientsChange: (value: NoticeRecipient[]) => void;
  /** { [groupId]: 要 tag 的成員 }。個別聯絡人不需要 tag，所以只會有群組的 key。 */
  mentions: Record<string, MentionMember[]>;
  onMentionsChange: (value: Record<string, MentionMember[]>) => void;
  templateVars: TemplateVariableBinding;
  placeholder?: string;
  hint?: ReactNode;
}

export default function NoticeComposer({
  label, template, onTemplateChange, recipients, onRecipientsChange,
  mentions, onMentionsChange, templateVars, placeholder, hint,
}: Props) {
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [lineGroups, setLineGroups] = useState<LineGroupOption[]>([]);
  // 先選官方帳號再挑對象：群組與聯絡人都是掛在各自帳號底下的（實務上通常只有廠商用帳號
  // 才被邀進群組），全部混在一起列會分不清楚誰屬於哪個帳號。這只是畫面篩選，不寫進設定。
  const [channelFilter, setChannelFilter] = useState('');
  const [contacts, setContacts] = useState<LineContactOption[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  // 已勾選對象的名字：對象可能分屬不同帳號，而聯絡人清單只查目前篩選的那個帳號，
  // 所以另外存一份名字快取，切換帳號時「已勾選」那排才不會變成一串 ID。
  const [nameById, setNameById] = useState<Record<string, string>>({});
  const [groupMembers, setGroupMembers] = useState<Record<string, GroupMemberOption[]>>({});

  useEffect(() => {
    (async () => {
      const [channelRes, groupRes] = await Promise.all([
        supabase.from('line_channels').select('id, name').eq('is_active', true).order('display_order'),
        supabase.from('line_groups').select('group_id, name, channel_id, chat_type').eq('is_active', true)
          .order('last_message_at', { ascending: false, nullsFirst: false }),
      ]);
      setChannels(channelRes.data || []);
      const groups = (groupRes.data || []) as LineGroupOption[];
      setLineGroups(groups);
      setNameById((prev) => ({
        ...Object.fromEntries(groups.map((g) => [g.group_id, g.name || '（未取得群組名稱）'])),
        ...prev,
      }));
    })();
  }, []);

  // 選定帳號後才查它的個別聯絡人：聯絡人可能成千上百，沒必要一打開就全部撈進來。
  useEffect(() => {
    if (!channelFilter) { setContacts([]); return; }
    let cancelled = false;
    setContactsLoading(true);
    supabase
      .from('user_states')
      .select('line_user_id, nickname, channel_id')
      .eq('channel_id', channelFilter)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(200)
      .then(({ data }) => {
        if (cancelled) return;
        const list = (data || []) as LineContactOption[];
        setContacts(list);
        setNameById((prev) => ({
          ...prev,
          ...Object.fromEntries(list.map((c) => [c.line_user_id, c.nickname || '（未取得暱稱）'])),
        }));
        setContactsLoading(false);
      });
    return () => { cancelled = true; };
  }, [channelFilter]);

  const selectedGroups = useMemo(
    () => lineGroups.filter((g) => recipients.some((r) => r.id === g.group_id)),
    [lineGroups, recipients]
  );

  // 只查「已勾選的群組」的成員：沒勾的群組查了也沒地方顯示。
  useEffect(() => {
    const need = selectedGroups.map((g) => g.group_id).filter((id) => !groupMembers[id]);
    if (!need.length) return;
    let cancelled = false;
    supabase
      .from('line_group_members')
      .select('line_user_id, display_name, group_id')
      .in('group_id', need)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .then(({ data }) => {
        if (cancelled) return;
        const byGroup: Record<string, GroupMemberOption[]> = {};
        for (const id of need) byGroup[id] = [];
        for (const m of (data || []) as GroupMemberOption[]) (byGroup[m.group_id] ||= []).push(m);
        setGroupMembers((prev) => ({ ...prev, ...byGroup }));
      });
    return () => { cancelled = true; };
  }, [selectedGroups, groupMembers]);

  const visibleGroups = channelFilter ? lineGroups.filter((g) => g.channel_id === channelFilter) : [];

  const toggleRecipient = (id: string, channelId: string) => {
    const has = recipients.some((r) => r.id === id);
    onRecipientsChange(has ? recipients.filter((r) => r.id !== id) : [...recipients, { id, channel_id: channelId }]);
    // 取消勾選一個群組時，順手把它的 tag 設定清掉，不然設定會留著一份看不到的殘留值。
    if (has && mentions[id]) {
      const next = { ...mentions };
      delete next[id];
      onMentionsChange(next);
    }
  };

  const toggleMention = (groupId: string, member: GroupMemberOption) => {
    const current = mentions[groupId] || [];
    const has = current.some((m) => m.id === member.line_user_id);
    const next = has
      ? current.filter((m) => m.id !== member.line_user_id)
      : [...current, { id: member.line_user_id, name: member.display_name }];
    const merged = { ...mentions };
    if (next.length) merged[groupId] = next; else delete merged[groupId];
    onMentionsChange(merged);
  };

  const recipientLabel = (r: NoticeRecipient) => nameById[r.id] || r.id;
  const isGroup = (id: string) => lineGroups.some((g) => g.group_id === id);

  return (
    <>
      <div>
        <label className="block text-xs text-gray-500 mb-1">{label}內容（選填）</label>
        <MessageTemplateEditor
          value={template}
          onChange={onTemplateChange}
          {...templateVars}
          rows={10}
          placeholder={placeholder}
        />
        <p className="text-xs text-gray-400 mt-1">
          這則訊息會發到下方勾選的 LINE 群組或聯絡人（不是發給客人）。
          {hint}
          訂單變數（[姓名]、[入住日期]…）也可以插入，但這是<strong>當日多筆訂單的彙整</strong>，
          同一個變數在多筆訂單有不同值時會用「、」串起來，只有一筆訂單時就是原本的值。
        </p>
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">{label}發送對象（選填，可複選：群組與個別聯絡人）</label>

        {/* 已勾選的對象獨立列在最上面：清單本身一次只列出一個帳號的對象，
            沒有這排的話，勾了別的帳號的對象之後就完全看不到自己到底選了誰。 */}
        {recipients.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 p-2 bg-gray-50 border rounded-lg">
            {recipients.map((r) => (
              <span
                key={r.id}
                className={`inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-xs border ${
                  isGroup(r.id) ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white text-gray-700 border-gray-300'
                }`}
              >
                {isGroup(r.id) && <span className="text-[10px] opacity-70">群組</span>}
                {recipientLabel(r)}
                <button
                  type="button"
                  onClick={() => toggleRecipient(r.id, r.channel_id)}
                  className="p-0.5 rounded-full hover:bg-black/10"
                  title="移除"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 判斷依據是「有沒有官方帳號」而不是「有沒有群組」——收件人也可以是個別聯絡人，
            某個帳號沒有群組但有聯絡人時，整個選擇區不該被藏起來。 */}
        {channels.length === 0 ? (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            還沒有設定任何 LINE 官方帳號，請先到「系統設定 → LINE 串接設定」新增。
          </p>
        ) : (
          <>
            <select
              value={channelFilter}
              onChange={(e) => setChannelFilter(e.target.value)}
              className="w-full px-3 py-2 border rounded-lg bg-white mb-2 text-sm"
            >
              <option value="">請先選擇官方帳號</option>
              {channels.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>

            {!channelFilter ? (
              <p className="text-xs text-gray-400 px-1">
                收件人分屬各個官方帳號（群組通常掛在廠商用帳號底下），先選帳號才列得出它的群組與聯絡人。
              </p>
            ) : (
              <div className="border rounded-lg divide-y max-h-56 overflow-y-auto">
                <p className="px-3 py-1.5 text-xs text-gray-400 bg-gray-50 sticky top-0">LINE 群組</p>
                {visibleGroups.length === 0 && (
                  <p className="px-3 py-2 text-xs text-gray-400">這個帳號底下沒有群組。</p>
                )}
                {visibleGroups.map((g) => (
                  <label key={g.group_id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                    <input
                      type="checkbox"
                      checked={recipients.some((r) => r.id === g.group_id)}
                      onChange={() => toggleRecipient(g.group_id, g.channel_id)}
                      className="w-4 h-4"
                    />
                    <span className="text-gray-700">
                      {g.name || (g.chat_type === 'room' ? `多人聊天室（${g.group_id.slice(0, 8)}…）` : '（未取得群組名稱）')}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
                      {g.chat_type === 'room' ? '多人聊天室' : '群組'}
                    </span>
                  </label>
                ))}

                <p className="px-3 py-1.5 text-xs text-gray-400 bg-gray-50 sticky top-0">個別聯絡人</p>
                {contactsLoading ? (
                  <p className="px-3 py-2 text-xs text-gray-400">載入中...</p>
                ) : contacts.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-gray-400">這個帳號底下還沒有聯絡人。</p>
                ) : (
                  contacts.map((c) => (
                    <label key={c.line_user_id} className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={recipients.some((r) => r.id === c.line_user_id)}
                        onChange={() => toggleRecipient(c.line_user_id, c.channel_id)}
                        className="w-4 h-4"
                      />
                      <span className="text-gray-700">{c.nickname || '（未取得暱稱）'}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </>
        )}

        <p className="text-xs text-gray-400 mt-1">
          已勾選 {recipients.length} 個對象{recipients.length > 0 && channelFilter ? '（切換帳號不會取消其他帳號已勾選的對象）' : ''}。
          留空＝這支排程不發{label}。要發送的話，上面的「{label}內容」也要一起填。
        </p>
      </div>

      {/* 群組成員 @tag：只對已勾選的群組出現。個別聯絡人不需要 tag，訊息本來就直接發給他。 */}
      {selectedGroups.length > 0 && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">在群組裡 @tag 誰（選填）</label>
          <div className="space-y-2">
            {selectedGroups.map((g) => {
              const members = groupMembers[g.group_id];
              const picked = mentions[g.group_id] || [];
              return (
                <div key={g.group_id} className="border rounded-lg p-2.5">
                  <p className="text-xs font-medium text-gray-600 mb-1.5">
                    {g.name || '（未取得群組名稱）'}
                    {picked.length > 0 && <span className="ml-1 text-gray-400">已 tag {picked.length} 人</span>}
                  </p>
                  {members === undefined ? (
                    <p className="text-xs text-gray-400">載入成員中...</p>
                  ) : members.length === 0 ? (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                      這個群組還沒有記錄到任何成員。系統只認得「在群組裡發言過」的人
                      （LINE 不開放一般官方帳號查詢完整成員名單），請對方在群組裡隨便講一句話，之後就會出現在這裡。
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {members.map((m) => {
                        const on = picked.some((p) => p.id === m.line_user_id);
                        return (
                          <button
                            key={m.line_user_id}
                            type="button"
                            onClick={() => toggleMention(g.group_id, m)}
                            className={`px-2 py-1 rounded-full text-xs border transition-colors ${
                              on ? 'bg-green-600 text-white border-green-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                            }`}
                          >
                            @{m.display_name || m.line_user_id.slice(0, 8)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-400 mt-1">
            被 tag 的成員名字會加在訊息的最前面（例如「@小明 @小華」），LINE 會通知到他們本人。
            一則訊息最多 tag 20 人，超過的部分不會被 tag，訊息本身照常發送。
          </p>
        </div>
      )}
    </>
  );
}

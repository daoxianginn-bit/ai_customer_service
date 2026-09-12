import NotificationGroupsPanel from '../../components/NotificationGroupsPanel';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';

// 串接管理 → 通知對象：從官方帳號的聯絡人勾一組人，作為轉接通知與排程推播的收件名單。
export default function NotificationGroups() {
  return (
    <>
      <PageHeaderV2 />
      <NotificationGroupsPanel />
    </>
  );
}

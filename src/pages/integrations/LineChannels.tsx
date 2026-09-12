import LineChannelsPanel from '../../components/LineChannelsPanel';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';

// 串接管理 → LINE 官方帳號（V2 §56）。面板本身已是 MUI，這裡只加 V2 頁首。
export default function LineChannels() {
  return (
    <>
      <PageHeaderV2 />
      <LineChannelsPanel />
    </>
  );
}

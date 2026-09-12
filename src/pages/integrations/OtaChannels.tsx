import OtaChannelsPanel from '../../components/OtaChannelsPanel';
import PageHeaderV2 from '../../components/ui-mui/PageHeaderV2';

// 串接管理 → OTA 平台（V2 §58）。
export default function OtaChannels() {
  return (
    <>
      <PageHeaderV2 />
      <OtaChannelsPanel />
    </>
  );
}

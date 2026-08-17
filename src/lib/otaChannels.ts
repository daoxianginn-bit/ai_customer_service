// ========================================================================
// 第三方平台（Airbnb／Booking.com／Agoda／Trip）iCal 雙向同步的共用定義。
// 後台頁面與 Netlify functions（calendar-feed.ts／scheduled-tasks-run.ts）都從這裡取用。
// ========================================================================

export type OtaPlatform = 'airbnb' | 'booking' | 'agoda' | 'trip';

export interface OtaChannel {
  id: string;
  platform: OtaPlatform;
  name: string;
  room_type_id: string | null; // null＝整棟
  import_ics_url: string | null;
  export_token: string;
  is_active: boolean;
  display_order: number;
  last_imported_at: string | null;
  last_import_status: 'success' | 'failed' | null;
  last_import_summary: string | null;
}

export const OTA_PLATFORM_OPTIONS: { value: OtaPlatform; label: string }[] = [
  { value: 'airbnb', label: 'Airbnb' },
  { value: 'booking', label: 'Booking.com' },
  { value: 'agoda', label: 'Agoda' },
  { value: 'trip', label: 'Trip.com' },
];

export function otaPlatformLabel(platform: string | null | undefined): string {
  return OTA_PLATFORM_OPTIONS.find((p) => p.value === platform)?.label || platform || '';
}

/** 產生一組隨機 token，用於 export_token（跟 settings.calendar_feed_token 同一套做法）。 */
export function generateRandomToken(byteLength = 24): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function otaChannelExportUrl(origin: string, exportToken: string): string {
  return `${origin}/.netlify/functions/calendar-feed?channel=${encodeURIComponent(exportToken)}`;
}

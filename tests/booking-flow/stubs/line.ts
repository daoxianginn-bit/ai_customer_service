export const __sent: { to: string; text: string; kind: 'reply' | 'push' }[] = [];
/** 測試用：推播給這些收件人時丟出指定的錯誤（模擬 LINE 拒收）。 */
export const __failPushTo = new Map<string, any>();
export class Client {
  constructor(_opts: any) {}
  async replyMessage(token: string, msg: any) { __sent.push({ to: token, text: msg.text, kind: 'reply' }); }
  async pushMessage(to: string, msg: any) {
    if (__failPushTo.has(to)) throw __failPushTo.get(to);
    __sent.push({ to, text: msg.text, kind: 'push' });
  }
  async getProfile(_id: string) { return { displayName: '測試客人', pictureUrl: null }; }
}
export function validateSignature() { return true; }
export type WebhookEvent = any;

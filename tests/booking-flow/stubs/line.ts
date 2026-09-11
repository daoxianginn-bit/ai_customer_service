export const __sent: { to: string; text: string; kind: 'reply' | 'push' }[] = [];
export class Client {
  constructor(_opts: any) {}
  async replyMessage(token: string, msg: any) { __sent.push({ to: token, text: msg.text, kind: 'reply' }); }
  async pushMessage(to: string, msg: any) { __sent.push({ to, text: msg.text, kind: 'push' }); }
  async getProfile(_id: string) { return { displayName: '測試客人', pictureUrl: null }; }
}
export function validateSignature() { return true; }
export type WebhookEvent = any;

// Chat Completions 的替身：測試把下一次要回的內容放進 OpenAI.next
export default class OpenAI {
  static next: any = { choices: [{ message: { content: '' }, finish_reason: 'stop' }] };
  chat = { completions: { create: async (_params: any) => OpenAI.next } };
  constructor(_o: any) {}
}

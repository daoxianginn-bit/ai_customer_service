// 測試可以設定 globalThis.__fetchStub 來模擬外部 API（例如 OpenAI Responses API）；沒設定就直接失敗
export default async function fetch(...args: any[]): Promise<any> {
  const stub = (globalThis as any).__fetchStub;
  if (stub) return stub(...args);
  throw new Error('fetch not available in test');
}

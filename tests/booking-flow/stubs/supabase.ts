// 記憶體版假 Supabase：支援本專案 webhook 用到的查詢鏈。
// 每張表是一個陣列；builder 收集篩選條件，await 時才執行。
export const __db: Record<string, any[]> = {};
export function __reset(seed: Record<string, any[]> = {}) {
  for (const k of Object.keys(__db)) delete __db[k];
  for (const [k, v] of Object.entries(seed)) __db[k] = v.map((r) => ({ ...r }));
}
const rows = (t: string) => (__db[t] ||= []);

type Filter = (r: any) => boolean;

class Builder implements PromiseLike<any> {
  private filters: Filter[] = [];
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: any = null;
  private singleMode: 'none' | 'maybe' | 'single' = 'none';
  private limitN: number | null = null;
  private orderKey: string | null = null;
  private orderAsc = true;
  private wantSelect = false;
  private onConflict: string[] = [];

  constructor(private table: string) {}

  select(_cols?: string) { if (this.op === 'select') this.op = 'select'; this.wantSelect = true; return this; }
  insert(row: any) { this.op = 'insert'; this.payload = row; return this; }
  update(patch: any) { this.op = 'update'; this.payload = patch; return this; }
  upsert(row: any, opts?: { onConflict?: string }) { this.op = 'upsert'; this.payload = row; this.onConflict = (opts?.onConflict || 'id').split(','); return this; }
  delete() { this.op = 'delete'; return this; }
  eq(k: string, v: any) { this.filters.push((r) => r[k] === v); return this; }
  neq(k: string, v: any) { this.filters.push((r) => r[k] !== v); return this; }
  in(k: string, vs: any[]) { this.filters.push((r) => vs.includes(r[k])); return this; }
  is(k: string, v: any) { this.filters.push((r) => (r[k] ?? null) === v); return this; }
  gt(k: string, v: any) { this.filters.push((r) => r[k] > v); return this; }
  gte(k: string, v: any) { this.filters.push((r) => r[k] >= v); return this; }
  lt(k: string, v: any) { this.filters.push((r) => r[k] < v); return this; }
  lte(k: string, v: any) { this.filters.push((r) => r[k] <= v); return this; }
  ilike(k: string, v: string) { const needle = v.replace(/%/g, '').toLowerCase(); this.filters.push((r) => String(r[k] ?? '').toLowerCase().includes(needle)); return this; }
  or(_expr: string) { return this; }
  order(k: string, opts?: { ascending?: boolean }) { this.orderKey = k; this.orderAsc = opts?.ascending !== false; return this; }
  limit(n: number) { this.limitN = n; return this; }
  range(a: number, b: number) { this.limitN = b - a + 1; return this; }
  maybeSingle() { this.singleMode = 'maybe'; return this; }
  single() { this.singleMode = 'single'; return this; }

  private matches() {
    let out = rows(this.table).filter((r) => this.filters.every((f) => f(r)));
    if (this.orderKey) {
      const k = this.orderKey; const asc = this.orderAsc;
      out = [...out].sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1));
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return out;
  }

  private run(): { data: any; error: any } {
    const t = rows(this.table);
    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = list.map((r) => ({ id: r.id ?? `id_${this.table}_${t.length + 1}_${Math.random().toString(36).slice(2, 6)}`, created_at: new Date().toISOString(), ...r }));
      t.push(...inserted);
      const data = this.singleMode !== 'none' ? inserted[0] : inserted;
      return { data: this.wantSelect || this.singleMode !== 'none' ? data : null, error: null };
    }
    if (this.op === 'update') {
      const hit = this.matches();
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.wantSelect ? hit : null, error: null };
    }
    if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const r of list) {
        const existing = t.find((x) => this.onConflict.every((k) => x[k] === r[k]));
        if (existing) Object.assign(existing, r); else t.push({ ...r });
      }
      return { data: null, error: null };
    }
    if (this.op === 'delete') {
      const hit = new Set(this.matches());
      __db[this.table] = t.filter((r) => !hit.has(r));
      return { data: null, error: null };
    }
    const hit = this.matches();
    if (this.singleMode === 'maybe') return { data: hit[0] ?? null, error: null };
    if (this.singleMode === 'single') return hit[0] ? { data: hit[0], error: null } : { data: null, error: { message: 'no rows' } };
    return { data: hit, error: null };
  }

  then<R1 = any, R2 = never>(onFulfilled?: ((v: any) => R1 | PromiseLike<R1>) | null, onRejected?: ((e: any) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

export function createClient(_url: string, _key: string) {
  return {
    from: (table: string) => new Builder(table),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  };
}

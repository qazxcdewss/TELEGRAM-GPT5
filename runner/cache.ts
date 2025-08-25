// runner/cache.ts
import LRU from 'lru-cache';
import { IVMRunner } from './ivm-runtime';

const max = Number(process.env.IVM_CACHE_MAX || 16);
export const runnerCache = new LRU<string, IVMRunner>({
  max,
  ttl: 1000 * 60 * 10,
  dispose: (_k, r) => { try { r.dispose(); } catch {} },
});

export function getRunner(key: string) { return runnerCache.get(key); }
export function setRunner(key: string, r: IVMRunner) { runnerCache.set(key, r); return r; }
export function clearRunner(key: string) { const r = runnerCache.get(key); if (r) r.dispose(); runnerCache.delete(key); }



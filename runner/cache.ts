// runner/cache.ts
import { LRUCache } from 'lru-cache'
import { IVMRunner } from './ivm-runtime'

const max = Number((globalThis as any).process?.env?.IVM_CACHE_MAX ?? 16)

export const runnerCache = new LRUCache<string, IVMRunner>({
  max,
  ttl: 1000 * 60 * 10, // 10 минут
  // dispose вызывается при удалении элемента из кэша
  dispose: (value, key/*, reason*/) => {
    try { value.dispose() } catch {}
  },
})

export function getRunner(key: string) {
  return runnerCache.get(key)
}

export function setRunner(key: string, r: IVMRunner) {
  runnerCache.set(key, r)
  return r
}

export function clearRunner(key: string) {
  const r = runnerCache.get(key)
  if (r) { try { r.dispose() } catch {} }
  runnerCache.delete(key)
}

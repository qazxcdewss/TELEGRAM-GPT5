// lib/canonicalize.ts
export function canonicalize(obj: unknown): string {
  const sortKeys = (x: any): any =>
    Array.isArray(x)
      ? x.map(sortKeys)
      : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys((x as any)[k])]))
      : x;
  return JSON.stringify(sortKeys(obj));
}



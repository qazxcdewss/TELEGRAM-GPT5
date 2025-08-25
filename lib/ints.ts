// lib/ints.ts
export function toInt(v: any, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function byteLenUtf8(s: string): number {
  return Buffer.byteLength(s ?? '', 'utf8');
}



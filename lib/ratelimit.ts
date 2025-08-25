// lib/ratelimit.ts
type RedisPipeline = {
  zremrangebyscore(key: string, min: number, max: number): unknown;
  zadd(key: string, score: number, member: string): unknown;
  zcard(key: string): unknown;
  pexpire(key: string, ms: number): unknown;
  exec(): Promise<any[]>;
}

export type MinimalRedis = {
  multi(): RedisPipeline;
}

const BUCKET = Number(process.env.RL_BUCKET || 5);
const INTERVAL_MS = Number(process.env.RL_INTERVAL_MS || 5000);

// простейший токен-бакет на ZSET: <= BUCKET событий за INTERVAL_MS
export async function allow(redis: MinimalRedis, botId: string, chatId: string|number) {
  const key = `rl:${botId}:${chatId}`;
  const now = Date.now();
  const pipe = redis.multi();
  pipe.zremrangebyscore(key, 0, now - INTERVAL_MS);
  pipe.zadd(key, now, String(now));
  pipe.zcard(key);
  pipe.pexpire(key, INTERVAL_MS);
  const [, , countRes] = await pipe.exec() as any[];
  const count = countRes?.[1] ?? countRes;
  return Number(count) <= BUCKET;
}



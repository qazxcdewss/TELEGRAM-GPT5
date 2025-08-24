// services/gateway/worker.ts
import Redis from 'ioredis'
import { Pool } from 'pg'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const S3_ENDPOINT   = process.env.S3_ENDPOINT   || 'http://127.0.0.1:9000'
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'minio'
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'minio12345'
const S3_BUCKET     = process.env.S3_BUCKET     || 'bots'
const PG_HOST = process.env.PG_HOST || '127.0.0.1'
const PG_PORT = Number(process.env.PG_PORT || 5433)
const PG_DB   = process.env.PG_DB   || 'tgpt5'
const PG_USER = process.env.PG_USER || 'tgpt5'
const PG_PASS = process.env.PG_PASSWORD || 'tgpt5'
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'

const redis = new Redis(REDIS_URL)
const ssePub = new Redis(REDIS_URL) // для pub/sub
const pool = new Pool({ host: PG_HOST, port: PG_PORT, database: PG_DB, user: PG_USER, password: PG_PASS })
const s3 = new S3Client({
  endpoint: S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
})

function qKey(botId: string, chatId: string|number) { return `q:in:${botId}:${chatId}` }
function dlqKey(botId: string) { return `dlq:in:${botId}` }

async function getS3Text(key: string): Promise<string> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  const bufs: Buffer[] = []
  for await (const ch of r.Body as any) bufs.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
  return Buffer.concat(bufs).toString('utf8')
}

type CacheEntry = { revHash: string; fn: (ctx:any)=>Promise<any> }
const handlerCache = new Map<string, CacheEntry>() // botId -> {revHash, fn}

async function loadHandler(botId: string, revHash: string) {
  const cached = handlerCache.get(botId)
  if (cached && cached.revHash === revHash) return cached.fn
  const row = await pool.query('SELECT key_prefix FROM revisions WHERE rev_hash=$1 LIMIT 1', [revHash])
  const keyPrefix = row.rows[0]?.key_prefix
  if (!keyPrefix) throw new Error('REV_KEY_PREFIX_NOT_FOUND')
  const js = await getS3Text(`${keyPrefix}/bot.js`)
  // поддержим ESM-подпись на всякий случай
  const jsCjs = js
    .replace(/export\s+async\s+function\s+handleUpdate\s*\(/g, 'module.exports.handleUpdate = async function handleUpdate(')
    .replace(/export\s+default\s+/g, 'module.exports = ')
  const moduleObj = { exports: {} as any }
  const factory = new Function('exports','module', jsCjs + '\nreturn module.exports;')
  const exports = factory(moduleObj.exports, moduleObj)
  const fn = (exports?.handleUpdate || moduleObj.exports?.handleUpdate) as (ctx:any)=>Promise<any>
  if (typeof fn !== 'function') throw new Error('HANDLE_UPDATE_NOT_EXPORTED')
  handlerCache.set(botId, { revHash, fn })
  return fn
}

async function processOne(payload: string) {
  const job = JSON.parse(payload) as { botId:string; revHash:string; chatId:number; text:string; ts:number }
  try {
    const fn = await loadHandler(job.botId, job.revHash)
    const response = await fn({ message: { chat: { id: job.chatId }, text: job.text } })
    // метрики (простейшие счётчики в Redis)
    await redis.pipeline()
      .incr('m:processed')
      .incr(`m:bot:${job.botId}:processed`)
      .exec()
    // опубликуем событие для SSE
    await ssePub.publish('sse', JSON.stringify({ event: 'MessageProcessed', data: { ...job, response } }))
  } catch (e:any) {
    await redis.pipeline()
      .lpush(dlqKey(job.botId), JSON.stringify({ job, error: String(e?.message || e) }))
      .incr('m:failed')
      .incr(`m:bot:${job.botId}:failed`)
      .exec()
    await ssePub.publish('sse', JSON.stringify({ event: 'MessageProcessed', data: { ...job, error: String(e?.message || e) } }))
  }
}

async function loop() {
  // простой опрос доступных очередей и ожидание сообщений
  while (true) {
    try {
      const keys = await redis.keys('q:in:*')
      if (keys.length === 0) { await new Promise(r => setTimeout(r, 250)); continue }
      const res = await redis.brpop(keys, 2) // ждём до 2с любую очередь
      if (res) {
        const [_key, payload] = res
        await processOne(payload)
      }
    } catch (e) {
      console.error('worker loop error:', e)
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

loop().catch(e => { console.error(e); process.exit(1) })



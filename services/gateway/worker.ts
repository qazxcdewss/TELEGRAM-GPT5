// services/gateway/worker.ts
import Redis from 'ioredis'
import { Pool } from 'pg'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { IVMRunner } from '../../runner/ivm-runtime'
import { sendTelegramText } from './telegram'
import { getRunner, setRunner } from '../../runner/cache'
import { allow as allowRate } from '../../lib/ratelimit'

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
const QUEUE_TTL_MS = Number(process.env.QUEUE_TTL_MS || 60000)
const TICK_DEBUG = process.env.DEBUG_WORKER === '1'
const TICK_MS = Number(process.env.DEBUG_TICK_MS || 15000)
let lastTick = 0

console.log('worker started. REDIS_URL=', REDIS_URL)
console.log('worker started. TELEGRAM_TOKEN_my-bot-1:', !!process.env['TELEGRAM_TOKEN_my-bot-1'])
console.log('worker started. TELEGRAM_TOKEN_my_bot_1:', !!(process.env as any).TELEGRAM_TOKEN_my_bot_1)

const redis = new Redis(REDIS_URL)
const ssePub = new Redis(REDIS_URL) // для pub/sub
const sub = new Redis(REDIS_URL)
let PREWARM_SUBSCRIBED = false
const pool = new Pool({ host: PG_HOST, port: PG_PORT, database: PG_DB, user: PG_USER, password: PG_PASS })
const s3 = new S3Client({
  endpoint: S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
})

// Подписка на prewarm: греем рантайм и подтверждаем (однократно)
;(async () => {
  try {
    if (!PREWARM_SUBSCRIBED) {
      await sub.subscribe('deploy:prewarm')
      sub.on('message', async (ch, payload) => {
        if (ch !== 'deploy:prewarm') return
        try {
          const { botId, revHash } = JSON.parse(payload)
          // подготовим/прогреем рантайм
          try {
            const runner = await getOrCreateRunner(botId, revHash, loadBotJsFromMinio)
            // ping без реальных outbound-действий
            try { await runner.handleUpdate({ botId, chat: { id: '__prewarm__', type: 'private' }, state: {} }, {
              sendMessage: async () => {}, http: async () => ({ status: 200, body: {} }), goto: async () => {}, getState: async () => ({}), setState: async () => {}
            }) } catch {}
          } catch (e) {
            console.error('[prewarm runner failed]', e)
          }
          await ssePub.publish('sse', JSON.stringify({ event: 'DeployPrewarmReady', data: { botId, revHash } }))
        } catch (e) {
          console.error('[prewarm failed]', e)
        }
      })
      PREWARM_SUBSCRIBED = true
    }
  } catch (e) { console.error('sub deploy:prewarm failed', e) }
})()

function qKey(botId: string, chatId: string|number) { return `q:in:${botId}:${chatId}` }
function dlqKey(botId: string) { return `dlq:in:${botId}` }

async function getS3Text(key: string): Promise<string> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  const bufs: Buffer[] = []
  for await (const ch of r.Body as any) bufs.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
  return Buffer.concat(bufs).toString('utf8')
}

async function loadBotJsFromMinio(_botId: string, revHash: string): Promise<string> {
  const row = await pool.query('SELECT key_prefix FROM revisions WHERE rev_hash=$1 LIMIT 1', [revHash])
  const keyPrefix = row.rows[0]?.key_prefix
  if (!keyPrefix) throw new Error('REV_KEY_PREFIX_NOT_FOUND')
  const js = await getS3Text(`${keyPrefix}/bot.js`)
  // поддержим ESM-подпись на всякий случай
  return js
    .replace(/export\s+async\s+function\s+handleUpdate\s*\(/g, 'module.exports.handleUpdate = async function handleUpdate(')
    .replace(/export\s+default\s+/g, 'module.exports = ')
}

async function getOrCreateRunner(botId: string, revHash: string, loader: (botId:string, rev:string)=>Promise<string>) {
  const key = `${botId}:${revHash}`
  const cached = getRunner(key)
  if (cached) return cached
  const botJs = await loader(botId, revHash)
  const r = new IVMRunner()
  await r.init(botJs)
  return setRunner(key, r)
}

async function loadState(botId: string, chatId: string|number): Promise<any> {
  const raw = await redis.get(`state:${botId}:${chatId}`)
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

async function saveState(botId: string, chatId: string|number, s: any): Promise<void> {
  await redis.set(`state:${botId}:${chatId}`, JSON.stringify(s))
}

// sendTelegramText перенесён в ./telegram и импортируется выше

async function enqueueFlow(botId: string, chatId: string|number, to: string, _payload: any): Promise<void> {
  // Простейшая постановка новой задачи в очередь текущего чата
  const job = { botId, chatId, revHash: await getActiveRevHash(botId), text: `/goto ${to}`, ts: Date.now() }
  await redis.lpush(qKey(botId, chatId), JSON.stringify(job))
}

async function getActiveRevHash(botId: string): Promise<string> {
  const row = await pool.query('SELECT active_rev_hash FROM bots WHERE bot_id=$1 LIMIT 1', [botId])
  return row.rows[0]?.active_rev_hash || ''
}

async function processOne(payload: string) {
  const msg = JSON.parse(payload) as { botId:string; revHash:string; chatId:number; text?:string; ts?:number; enqueuedAt?:number; update?:any }
  try {
    // TTL задач
    const enq = Number(msg.enqueuedAt || msg.ts || 0)
    if (enq && Date.now() - enq > QUEUE_TTL_MS) {
      await redis.lpush(dlqKey(msg.botId), JSON.stringify({ reason: 'TTL_EXPIRED', msg }))
      await redis.pipeline().incr('m:failed').incr(`m:bot:${msg.botId}:failed`).exec()
      return
    }

    // rate limit per bot/chat
    const ok = await allowRate(redis as any, msg.botId, msg.chatId)
    if (!ok) {
      await redis.lpush(dlqKey(msg.botId), JSON.stringify({ reason: 'RATE_LIMIT', msg }))
      await redis.pipeline().incr('m:throttled').incr(`m:bot:${msg.botId}:throttled`).exec()
      return
    }

    // получаем (или греем) раннер
    const runner = await getOrCreateRunner(msg.botId, msg.revHash, loadBotJsFromMinio)

    // собираем ctx и инструменты
    const ctx = {
      botId: msg.botId,
      chat: { id: msg.chatId, type: 'private' },
      state: await loadState(msg.botId, msg.chatId),
      message: { chat: { id: msg.chatId, type: 'private' }, text: msg.text ?? '' },
    }

    const tools = {
      sendMessage: async (p: { type: 'text'; text: string }) => {
        console.log('[worker] sendMessage called:', p)
        await ssePub.publish('sse', JSON.stringify({
          event: 'ToolSendMessage',
          data: { botId: msg.botId, chatId: msg.chatId, text: p?.text ?? '' }
        }))

        // 1) реально отправляем
        const res = await sendTelegramText(msg.botId, msg.chatId, p?.text ?? '')

        // 2) шлём в SSE, чтобы было видно в Console
        await ssePub.publish('sse', JSON.stringify({
          event: 'TelegramSent',
          data: { botId: msg.botId, chatId: msg.chatId, text: p?.text ?? '', messageId: (res as any)?.message_id }
        }))
      },
      http: async (r: { url: string; method?: 'GET'|'POST'; body?: any }) => {
        const method = r.method || 'GET'
        const res = await fetch(r.url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: method === 'POST' ? JSON.stringify(r.body ?? {}) : undefined,
        } as any)
        const text = await (res as any).text()
        try { return { status: (res as any).status, body: JSON.parse(text) } }
        catch { return { status: (res as any).status, body: text } }
      },
      goto: async (to: string) => {
        await enqueueFlow(msg.botId, msg.chatId, to, null)
      },
      getState: async () => await loadState(msg.botId, msg.chatId),
      setState: async (s: any) => { await saveState(msg.botId, msg.chatId, s) },
    }

    await ssePub.publish('sse', JSON.stringify({
      event: 'RuntimeEngine',
      data: { botId: msg.botId, revHash: msg.revHash, engine: 'isolated-vm' }
    }))

    const res = await runner.handleUpdate(ctx, tools)
    console.log('[worker] ivm result:', res)

    // fallback: если бот вернул ответ — отправим сами (поддержим несколько форм)
    let fallbackText: string | undefined
    if (res && typeof res === 'object') {
      if ((res as any).type === 'text' && (res as any).text) fallbackText = String((res as any).text)
      else if ((res as any).text) fallbackText = String((res as any).text)
      else if ((res as any).message?.text) fallbackText = String((res as any).message.text)
    } else if (typeof res === 'string' && res.trim()) {
      fallbackText = res
    }
    if (fallbackText) {
      console.log('[worker] fallback send:', fallbackText)
      try {
        const r2 = await sendTelegramText(msg.botId, msg.chatId, fallbackText)
        await ssePub.publish('sse', JSON.stringify({
          event: 'TelegramSent',
          data: { botId: msg.botId, chatId: msg.chatId, text: fallbackText, messageId: (r2 as any)?.message_id }
        }))
      } catch (e) {
        console.error('[worker] fallback send failed:', e)
      }
    }

    await redis.pipeline()
      .incr('m:processed')
      .incr(`m:bot:${msg.botId}:processed`)
      .exec()
    await ssePub.publish('sse', JSON.stringify({ event: 'MessageProcessed', data: { ...msg, response: 'ok' } }))
  } catch (e:any) {
    await redis.pipeline()
      .lpush(dlqKey(msg.botId), JSON.stringify({ reason: 'RUNTIME_ERROR', err: String(e?.message||e), msg }))
      .incr('m:failed')
      .incr(`m:bot:${msg.botId}:failed`)
      .exec()
    await ssePub.publish('sse', JSON.stringify({ event: 'MessageProcessed', data: { ...msg, error: String(e?.message || e) } }))
  }
}

async function loop() {
  // простой опрос доступных очередей и ожидание сообщений
  while (true) {
    try {
      if (TICK_DEBUG && Date.now() - lastTick > TICK_MS) {
        console.log('[worker] idle…')
        lastTick = Date.now()
      }
      const keys = await redis.keys('q:in:*')
      if (keys.length === 0) { await new Promise(r => setTimeout(r, 250)); continue }
      else { console.log('found queues', keys) }
      const res = await redis.brpop(keys, 2) // ждём до 2с любую очередь
      if (res) {
        const [key, payload] = res
        console.log('brpop from', key)
        await processOne(payload)
      }
    } catch (e) {
      console.error('worker loop error:', e)
      await new Promise(r => setTimeout(r, 200))
    }
  }
}

loop().catch(e => { console.error(e); process.exit(1) })



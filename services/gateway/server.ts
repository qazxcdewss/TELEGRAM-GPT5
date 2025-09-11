// server.ts — minimal end-to-end API
// Console → POST /spec → POST /generate → S3 → POST /deploy → activeRevHash → POST /wh/:botId (echo)
// + GET /events (SSE)
import Redis from 'ioredis'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { pgPool } from './db'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import multipart from '@fastify/multipart'
import * as jsonpatch from 'fast-json-patch'
import vm from 'node:vm'
import { canonicalize } from '../../lib/canonicalize'
import { stripMarkdownFences } from '../../lib/botjs-validate'
import { generateBotJs as generateWithEngine } from './generator-engine'
import { toInt, byteLenUtf8 } from '../../lib/ints'
import botsRoutes from './routes/bots'
import devRoutes from './routes/dev'
import { findBySecret, getSecret } from './bots-repo'
import { generateBotJs, type Engine } from './generator-engine'




// ===== ENV =====
const PORT           = Number(process.env.PORT || 3000)
const CONSOLE_ORIGIN = process.env.CONSOLE_ORIGIN || 'http://localhost:5173'
const BOT_SECRET     = process.env.BOT_SECRET || 'dev'

const S3_ENDPOINT   = process.env.S3_ENDPOINT   || 'http://127.0.0.1:9000'
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'minio'
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'minio12345'
const S3_BUCKET     = process.env.S3_BUCKET     || 'bots'

const PG_HOST = process.env.PG_HOST || '127.0.0.1'
const PG_PORT = Number(process.env.PG_PORT || 5433) // по умолчанию 5433 (наш docker)
const PG_DB   = process.env.PG_DB   || process.env.PG_DATABASE || 'tgpt5'
const PG_USER = process.env.PG_USER || 'tgpt5'
const PG_PASS = process.env.PG_PASSWORD || 'tgpt5'

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379'
const redis = new Redis(REDIS_URL)
const redisSub = new Redis(REDIS_URL)
redisSub.subscribe('sse').then(() => { try { (app as any)?.log?.info?.('SSE relay enabled') } catch {} }).catch(()=>{})
redisSub.on('message', (_ch, msg) => {
  try {
    const { event, data } = JSON.parse(msg)
    sendEvent(event, data)
  } catch {}
})

// ===== Helpers =====
const sortKeys = (x: any): any =>
  Array.isArray(x) ? x.map(sortKeys)
  : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])]))
    : x

const canonical = (o: any) => JSON.stringify(sortKeys(o))
const sha256    = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ===== AJV (BotSpec v1) =====
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)

// --- Нормализация «человеческих» конструкций в форму схемы BotSpec v1 ---
function normalizeSpecShapeTop(draft: any): any {
  const out = JSON.parse(JSON.stringify(draft || {}))
  if (Array.isArray(out.commands)) {
    out.flows = Array.isArray(out.flows) ? out.flows : []
    const flowsByName = new Map<string, any>()
    out.commands = out.commands.map((c: any, i: number) => {
      if (c && typeof c === 'object' && !('cmd' in c) && ('name' in c)) {
        const flowName = String(c.name || `flow_${i}`)
        if (Array.isArray(c.steps) && c.steps.length) {
          const steps = c.steps.map((s: any) =>
            (s && typeof s === 'object' && 'sendMessage' in s)
              ? { type:'sendMessage', text: String(s.sendMessage?.text ?? s.sendMessage?.message ?? '') }
              : s
          )
          flowsByName.set(flowName, { name: flowName, steps })
        }
        return { cmd: String(c.name || 'cmd'), flow: flowName }
      }
      return c
    })
    for (const [name, flow] of flowsByName) {
      const idx = out.flows.findIndex((f: any) => f?.name === name)
      if (idx >= 0) out.flows[idx] = flow; else out.flows.push(flow)
    }
  }
  if (Array.isArray(out.flows)) {
    out.flows = out.flows.map((f: any) => {
      if (!Array.isArray(f?.steps)) return f
      const steps = f.steps.map((s: any) =>
        (s && typeof s === 'object' && 'sendMessage' in s)
          ? { type:'sendMessage', text: String(s.sendMessage?.text ?? s.sendMessage?.message ?? '') }
          : s
      )
      return { ...f, steps }
    })
  }
  return out
}

// --- Жёсткая нормализация под AJV: убираем лишние поля и приводим форматы
function sanitizeSpecForAjv(input: any, botId: string) {
  const out: any = { meta: { botId: String(botId || input?.meta?.botId || '') } }

  // limits (optional)
  if (input?.limits && typeof input.limits === 'object') {
    const { botRps, chatRps } = input.limits
    const lim: any = {}
    if (Number.isInteger(botRps) && botRps >= 1) lim.botRps = botRps
    if (Number.isInteger(chatRps) && chatRps >= 1) lim.chatRps = chatRps
    if (Object.keys(lim).length) out.limits = lim
  }

  // commands → only {cmd, flow}
  const cmds = Array.isArray(input?.commands) ? input.commands : []
  out.commands = cmds.map((c: any, i: number) => {
    let cmd = String(c?.cmd ?? c?.name ?? '').trim()
    cmd = cmd.replace(/^\/+/, '').replace(/@.+$/, '')
    const flow = String(c?.flow ?? c?.name ?? `flow_${i}`).trim()
    return { cmd, flow }
  }).filter((c: any) => c.cmd && c.flow)

  // flows → keep only supported steps/fields
  const flows = Array.isArray(input?.flows) ? input.flows : []
  out.flows = flows.map((f: any, i: number) => {
    const name = String(f?.name ?? `flow_${i}`).trim()
    const stepsIn = Array.isArray(f?.steps) ? f.steps : []
    const steps = stepsIn.map((s: any) => {
      if (!s || typeof s !== 'object') return null
      if ('sendMessage' in s) {
        const text = String(s.sendMessage?.text ?? s.sendMessage?.message ?? s.text ?? '')
        return { type: 'sendMessage', text }
      }
      if (s.type === 'sendMessage') {
        return { type: 'sendMessage', text: String(s.text ?? '') }
      }
      if (s.type === 'goto') {
        return { type: 'goto', to: String(s.to ?? '') }
      }
      if (s.type === 'http') {
        const method = (s.method || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST'
        return { type: 'http', url: String(s.url || ''), method, body: s.body ?? null }
      }
      return null
    }).filter(Boolean)
    return { name, steps }
  })

  return out
}

async function callGpt(baseUrl: string, apiKey: string, model: string, messages: any[], maxTokens = 1800) {
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages }),
  } as any)
  const txt = await (r as any).text()
  let raw = ''
  try {
    const j = JSON.parse(txt)
    raw = String(j?.choices?.[0]?.message?.content ?? '').trim()
  } catch {}
  return { ok: (r as any).ok, txt, raw: stripMarkdownFences(raw).trim() }
}

const BotSpecSchema = {
  $id: "BotSpecV1",
  type: "object",
  required: ["meta"],
  additionalProperties: false,
  properties: {
    meta: {
      type: "object",
      required: ["botId"],
      additionalProperties: false,
      properties: {
        botId: { type: "string", minLength: 1 },
        name:  { type: "string", minLength: 1, nullable: true },
        locale:{ type: "string", minLength: 2, maxLength: 10, nullable: true },
        schema_ver: { type: "string", default: "1.0.0" }
      }
    },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        botRps:  { type: "integer", minimum: 1, default: 30 },
        chatRps: { type: "integer", minimum: 1, default: 1 }
      }
    },
    commands: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cmd", "flow"],
        properties: {
          cmd:  { type: "string", minLength: 1 },
          flow: { type: "string", minLength: 1 }
        }
      }
    },
    flows: {
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "steps"],
        properties: {
          name:  { type: "string", minLength: 1 },
          steps: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: {
                type: { enum: ["sendMessage", "goto", "http"] },
                text: { type: "string" },
                to:   { type: "string" },
                url:  { type: "string", format: "uri" },
                method: { enum: ["GET","POST"], default:"POST" },
                body:  { type: ["object","null"], default: null }
              }
            }
          }
        }
      }
    },
    actions: {
      type: "array",
      default: [],
      items: { type: "object" }
    }
  }
} as const

const validateBotSpec = ajv.compile(BotSpecSchema)

// ===== In-memory mirrors (удобно для демо; source of truth — PG/S3) =====
const specStore: Record<string, { version: number; canonical: string; specSha256: string; createdAt: string }[]> = {}
const revByHash = new Map<string, any>()
const revStore: Record<string, any[]> = {}
const activeRev: Record<string, string> = {}
const deployments: Record<string, { status: 'started' | 'flipped'; botId: string; revHash: string }> = {}

// ===== S3 (MinIO) =====
const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY }
})

async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
  }
}

async function putS3(key: string, body: string) {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: new TextEncoder().encode(body),
    ContentType: key.endsWith('.json') ? 'application/json'
             : key.endsWith('.js')   ? 'application/javascript'
             : 'application/octet-stream'
  }))
}

async function getS3Text(key: string): Promise<string> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  const chunks: Buffer[] = []
  for await (const ch of r.Body as any) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch))
  return Buffer.concat(chunks).toString('utf8')
}

// ===== PG =====
const pool = pgPool

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spec_versions (
      id SERIAL PRIMARY KEY,
      bot_id TEXT NOT NULL,
      schema_ver TEXT NOT NULL DEFAULT '1.0.0',
      canonical_spec JSONB NOT NULL,
      spec_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_spec_versions_bot_created ON spec_versions (bot_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS revisions (
      rev_hash TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      spec_version_id INTEGER NOT NULL REFERENCES spec_versions(id) ON DELETE CASCADE,
      key_prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_bot_created ON revisions (bot_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS bots (
      bot_id TEXT PRIMARY KEY,
      active_rev_hash TEXT REFERENCES revisions(rev_hash)
    );
  `)
}

// ===== SSE Hub =====
const clients = new Set<import('http').ServerResponse>()
function sendEvent(event: string, data: any) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`
  for (const c of clients) { try { c.write(payload) } catch { /* ignore */ } }
}

type HandlerCacheEntry = { revHash: string; fn: (ctx:any)=>Promise<any> }
const handlerCache = new Map<string, HandlerCacheEntry>() // botId -> {revHash, fn}

async function loadHandler(botId: string, revHash: string) {
  const cached = handlerCache.get(botId)
  if (cached && cached.revHash === revHash) return cached.fn

  const row = await pool.query('SELECT key_prefix FROM revisions WHERE rev_hash=$1 LIMIT 1', [revHash])
  const keyPrefix = row.rows[0]?.key_prefix
  const js = await getS3Text(`${keyPrefix}/bot.js`)

  const module = { exports: {} as any }
  const factory = new Function('exports','module', js + '\nreturn module.exports;')
  const exports = factory(module.exports, module)
  const fn = (exports?.handleUpdate || module.exports?.handleUpdate) as (ctx:any)=>Promise<any>
  if (typeof fn !== 'function') throw new Error('handleUpdate not exported')

  handlerCache.set(botId, { revHash, fn })
  return fn
}

// Queue helpers (per-chat FIFO)
function qKey(botId: string, chatId: string | number) { return `q:in:${botId}:${chatId}` }

async function processOne(jobStr: string) {
  const job = JSON.parse(jobStr)
  const handler = await loadHandler(job.botId, job.revHash)
  try {
    const response = await handler({ message: { chat: { id: job.chatId }, text: job.text } })
    sendEvent('MessageProcessed', { botId: job.botId, chatId: job.chatId, response })
  } catch (e: any) {
    sendEvent('MessageProcessed', { botId: job.botId, chatId: job.chatId, error: String(e?.message || e) })
  }
}

function startWorker() {
  (async function loop() {
    try {
      const keys = await redis.keys('q:in:*')
      if (keys.length === 0) { await new Promise(r => setTimeout(r, 300)); return setImmediate(loop) }
      const res = await redis.brpop(keys, 2)
      if (res) {
        const [_key, payload] = res
        await processOne(payload)
      }
    } catch (e) {
      app.log.error(e, 'worker loop error')
      await new Promise(r => setTimeout(r, 200))
    } finally {
      setImmediate(loop)
    }
  })()
}

// ===== Fastify =====
const app = Fastify({ logger: true })

// Redis Pub/Sub → SSE relay
redisSub.subscribe('sse')
redisSub.on('message', (_ch, msg) => {
  try {
    const { event, data } = JSON.parse(msg)
    sendEvent(event, data)
  } catch (e) {
    app.log.error(e, 'sse relay parse error')
  }
})
app.log.info('SSE relay enabled')

async function main() {
    await app.register(cors, {
      origin: (origin, cb) => {
        const o = String(origin || '')
        const allow = new Set([
          CONSOLE_ORIGIN,
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:5174',
          'http://127.0.0.1:5174',
        ])
        cb(null, allow.has(o))
      },
      methods: ['GET','POST','OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'If-Match', 'If-None-Match',
        'x-bot-id', 'x-bot-secret',
      ],
      credentials: true,
    })
  
    await app.register(multipart)

    // Форсируем CORS + SSE-заголовки именно для /events
    app.addHook('onSend', async (req, reply, payload) => {
      if (req.url === '/events') {
        const origin = String(req.headers.origin || '')
        if ([CONSOLE_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'].includes(origin)) {
          reply.header('Access-Control-Allow-Origin', origin)
          reply.header('Access-Control-Allow-Credentials', 'true')
          reply.header('Vary', 'Origin')
        }
        reply.header('Content-Type', 'text/event-stream')
        reply.header('Cache-Control', 'no-cache')
        reply.header('Connection', 'keep-alive')
      }
      return payload as any
    })
  
    // ---- Emulator routes (spec/active/rev → bot.js → sandboxed exec) ----
    await registerEmuRoutes(app)

    await ensureTables()
    // preload active revisions из PG (чтобы после рестарта помнить flip)
    try {
      const rows = await pool.query('SELECT bot_id, active_rev_hash FROM bots')
      for (const r of rows.rows) {
        if (r.active_rev_hash) activeRev[r.bot_id] = r.active_rev_hash
      }
      app.log.info({ activeRev }, 'preloaded active revisions from PG')
    } catch (e) {
      app.log.error(e, 'failed to preload active revisions')
    }

  // Health
  app.get('/health', async () => ({ ok: true }))
  app.get('/db/health', async (req, reply) => {
    try { const r = await pool.query('select 1 as ok'); return { ok: r.rows[0]?.ok === 1 } }
    catch (e: any) { return reply.code(500).send({ ok: false, error: e?.message }) }
  })

  // ===== /api/nl/chat =====
  // Вход: { messages: [{role:'user'|'assistant', text:string}], currentSpec?: BotSpecV1, mode?: 'patch'|'full' }
  // Выход: { assistant: string, patch?: RFC6902[], targetSpec?: BotSpecV1, canonical?: string }
  app.post('/api/nl/chat', async (req, reply) => {
    try {
      const body = (req.body || {}) as any
      const history = Array.isArray(body?.messages) ? body.messages.slice(-10) : []
      const currentSpec: any = body.currentSpec || null
      let mode: 'patch'|'full' = (body.mode === 'full' ? 'full' : 'patch')
      if (!currentSpec) mode = 'full'

      const apiKey = process.env.GPT5_API_KEY!
      const baseUrl = (process.env.GPT5_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/,'')
      const model   = process.env.GPT5_MODEL || 'gpt-5'
      if (!apiKey) return reply.code(500).send({ error:{ code:'GPT5_API_KEY_MISSING' } })

      const systemChat =
        'Ты ассистент в сервисе по созданию Telegram-ботов. ' +
        'Общайся с пользователем свободно и дружелюбно, помогай формулировать идеи. ' +
        'Параллельно мы отдельно запросим генерацию BotSpec — здесь просто отвечай по сути.'

      const systemSpec =
        'Ты генерируешь BotSpec v1 ТОЛЬКО в формате JSON. ' +
        'Если mode="patch" — верни массив RFC6902 операций; если mode="full" — верни полный объект спеки. ' +
        'СХЕМА: {"meta":{"botId":string}, "commands":[{"cmd":string,"flow":string}], ' +
        '"flows":[{"name":string,"steps":[{"type":"sendMessage"|"goto"|"http","text"?:string,"to"?:string,"url"?:string,"method?":"GET"|"POST","body"?:object|null}]}] }. ' +
        'В commands запрещены name/triggers/steps — допускаются ТОЛЬКО {"cmd","flow"}.'

      const lastUser = String(history.slice(-1)[0]?.text || '')
      const chatMsgs = history.map((h:any)=>({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.text||'') }))

      // A) свободный ответ ассистента
      const { ok:okA, txt:txtA, raw:rawA } = await callGpt(baseUrl, apiKey, model, [
        { role:'system', content: systemChat },
        ...chatMsgs,
        { role:'user', content: lastUser }
      ], 600)
      if (!okA) return reply.code(502).send({ error:{ code:'GPT5_HTTP', message: txtA.slice(0,200) } })
      const assistant = rawA || 'Готов продолжать — расскажите подробнее.'

      // B) отдельный строго-JSON вызов для спеки
      const canonicalCur = currentSpec ? canonicalize(currentSpec) : null
      const specPrompt =
        (canonicalCur ? `currentSpec:\n${canonicalCur}\n\n` : 'currentSpec: null\n\n') +
        `mode: ${mode}\n` +
        `intent: ${JSON.stringify({ last_user_message: lastUser })}`
      const { ok:okB, txt:txtB, raw:rawB } = await callGpt(baseUrl, apiKey, model, [
        { role:'system', content: systemSpec },
        { role:'user', content: specPrompt }
      ], 1500)
      if (!okB) return reply.code(502).send({ assistant, error:{ code:'GPT5_HTTP', message: txtB.slice(0,200) } })
      if (!rawB) return reply.send({ assistant })

      // Парсинг JSON, применение patch/full, нормализация и AJV
      let patch: any[]|undefined, targetSpec:any|undefined
      let parsed:any
      try { parsed = JSON.parse(rawB) } catch (e:any) {
        return reply.code(400).send({ assistant, error:{ code:'JSON_REQUIRED', message: String(e?.message||e) } })
      }
      if (Array.isArray(parsed)) {
        if (!currentSpec) return reply.code(400).send({ assistant, error:{ code:'PATCH_WITHOUT_BASE' } })
        targetSpec = jsonpatch.applyPatch(JSON.parse(JSON.stringify(currentSpec)), parsed, false).newDocument
        patch = parsed
      } else if (parsed && typeof parsed === 'object') {
        targetSpec = parsed
      } else {
        return reply.code(400).send({ assistant, error:{ code:'JSON_NOT_OBJECT_OR_PATCH' } })
      }

      targetSpec = normalizeSpecShapeTop(targetSpec)
      const okSpec = validateBotSpec(targetSpec)
      if (!okSpec) {
        const details = (validateBotSpec.errors || []).map((e:any) => ({ path: e.instancePath, message: e.message, need: (e as any)?.params?.missingProperty }))
        return reply.code(422).send({ assistant, error:{ code:'SPEC_INVALID', details }, draft: targetSpec })
      }
      return reply.send({ assistant, patch, targetSpec, canonical: canonicalize(targetSpec) })
    } catch (e:any) {
      return reply.code(500).send({ error:{ code:'NL_CHAT_ERROR', message: e?.message || String(e) } })
    }
  })

  // SSE
  app.get('/events', async (req, reply) => {
    // Дублируем выставление заголовков прямо тут и отправим их до первой записи
    const origin = String(req.headers.origin || '')
    const allowed = new Set([CONSOLE_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'])
    const headers: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
    if (allowed.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin
      headers['Access-Control-Allow-Credentials'] = 'true'
      headers['Vary'] = 'Origin'
    }

    reply.code(200)
    reply.hijack()
    try {
      for (const [k, v] of Object.entries(headers)) reply.raw.setHeader(k, v)
      ;(reply.raw as any).flushHeaders?.()
    } catch {}

    // Стартовый байт по протоколу SSE
    reply.raw.write('\n')
    clients.add(reply.raw)
    req.raw.on('close', () => { clients.delete(reply.raw) })
  })
  // --- heartbeat раз в 15 сек
   setInterval(() => {
        sendEvent('ping', { t: Date.now() })
    }, 15_000)

  // На всякий случай — форс-ACAO именно для /events
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url === '/events') {
      const origin = String(req.headers.origin || '')
      const allowed = new Set([CONSOLE_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'])
      if (allowed.has(origin)) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Access-Control-Allow-Credentials', 'true')
        reply.header('Vary', 'Origin')
      }
      reply.header('Content-Type', 'text/event-stream')
    }
    return payload as any
  })

  // Bots API
  await app.register(botsRoutes)
  await app.register(devRoutes)

  // ===== /spec ===== (создать новую версию Spec; immutable в PG)
  // CORS preflight for /spec (explicit to ensure custom headers are allowed)
  app.options('/spec', async (req, reply) => {
    const origin = (req.headers.origin as string) || ''
    const allowedOrigins = new Set([CONSOLE_ORIGIN, 'http://127.0.0.1:5173'])
    if (allowedOrigins.has(origin)) reply.header('Access-Control-Allow-Origin', origin)
    reply
      .header('Vary', 'Origin')
      .header('Access-Control-Allow-Headers', 'content-type, x-bot-id, x-bot-secret')
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Credentials', 'true')
      .code(204)
      .send()
  })

  app.post('/spec', async (req, reply) => {
    let spec = req.body as any
    const headerBotId = (req.headers['x-bot-id'] as string | undefined)?.trim()

    // Support multipart file upload: expect field name 'spec'
    try {
      const isMultipart = (req as any).isMultipart?.()
      if (isMultipart) {
        let specText = ''
        for await (const part of (req as any).parts()) {
          if (part?.type === 'file' && part?.fieldname === 'spec' && part?.file) {
            specText = await readStreamToString(part.file)
          }
        }
        if (!specText) return reply.code(400).send({ error: { code: 'SPEC_FILE_MISSING', message: 'spec file is required' } })
        try {
          spec = JSON.parse(specText)
        } catch {
          return reply.code(400).send({ error: { code: 'SPEC_INVALID_JSON', message: 'spec file is not valid JSON' } })
        }
      }
    } catch (e) {
      req.log.error(e, 'failed to parse multipart spec')
      return reply.code(400).send({ error: { code: 'MULTIPART_PARSE_FAILED' } })
    }

    // If botId header is provided and not present in spec.meta, inject it
    if (headerBotId && (!spec?.meta || !spec?.meta?.botId)) {
      spec = { ...(spec || {}), meta: { ...(spec?.meta || {}), botId: headerBotId } }
    }

    // Грубая форма → жёсткий санитайзер → AJV
    const prelim = normalizeSpecShapeTop(spec)
    let botId = (prelim?.meta?.botId as string) || headerBotId || ''
    const forAjv = sanitizeSpecForAjv(prelim, botId)
    const valid = validateBotSpec(forAjv)
    if (!valid) {
      const details = (validateBotSpec.errors || []).map((e: any) => ({
        path: e.instancePath || e.schemaPath,
        keyword: e.keyword,
        message: e.message
      }))
      return reply.code(400).send({ error: { code: 'SPEC_INVALID_SCHEMA', message: 'Validation failed', details } })
    }
    const finalSpec = forAjv
    botId = finalSpec.meta.botId as string

    const text = canonical(finalSpec)
    const specSha256 = sha256(text)

    // write to PG
    const ins = await pool.query(
      'INSERT INTO spec_versions (bot_id, schema_ver, canonical_spec, spec_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [botId, (finalSpec as any)?.meta?.schema_ver ?? '1.0.0', JSON.parse(text), specSha256]
    )
    const version = Number(ins.rows[0].id)

    // save original spec.json to S3 as bots/<botId>/<specSha>.json
    try {
      await ensureBucket()
      const s3Key = `bots/${botId}/${specSha256}.json`
      await putS3(s3Key, JSON.stringify(finalSpec))
    } catch (e) {
      req.log.error(e, 'failed to persist spec.json to S3')
      // not failing the whole request; PG insert already succeeded
    }

    // mirror in memory (для простоты демо)
    const list = (specStore[botId] ||= [])
    list.push({ version, canonical: text, specSha256, createdAt: new Date().toISOString() })

    reply.header('ETag', `specVersion-${version}`)
    return reply.code(201).send({ version })
  })

  // ===== /spec/latest ===== (из памяти; для real UI лучше читать из PG)
  app.get('/spec/latest', async (req, reply) => {
    const botId = (req.query as any).botId
    if (!botId) return reply.code(400).send({ error:{ code:'BAD_REQUEST', message:'botId query is required' } })
  
    const r = await pool.query(
      'SELECT id, canonical_spec FROM spec_versions WHERE bot_id=$1 ORDER BY id DESC LIMIT 1',
      [botId]
    )
    if (r.rowCount === 0) return reply.code(404).send({ error:{ code:'NOT_FOUND', message:'No spec' } })
    reply.header('ETag', `specVersion-${r.rows[0].id}`)
    return { version: Number(r.rows[0].id), spec: r.rows[0].canonical_spec }
  })

  // ===== /spec/:version ===== (из памяти; можно расширить чтением из PG)
  app.get('/spec/:version', async (req, reply) => {
    const botId = (req.query as any).botId
    const v = Number((req.params as any).version)
    const found = (specStore[botId] || []).find(x => x.version === v)
    if (!found) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such version' } })
    reply.header('ETag', `specVersion-${found.version}`)
    return { version: found.version, spec: JSON.parse(found.canonical) }
  })

  // ===== /generate ===== (собрать артефакты в S3 + вставить ревизию в PG)
  app.post('/generate', async (req, reply) => {
    const { botId, specVersion, specVersionId, model = 'gpt-5', seed = 0, engine = 'local' } = req.body as any
    const specVersionInt = toInt(specVersionId ?? specVersion, 0)

    // ищем в памяти, иначе тянем из PG
    let found = (specStore[botId] || []).find(x => x.version === specVersionInt)
    if (!found) {
      const row = await pool.query(
        'SELECT id, canonical_spec::text AS canonical_text FROM spec_versions WHERE bot_id=$1 AND id=$2 LIMIT 1',
        [botId, specVersionInt]
      )
      if (!row.rowCount) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Spec version not found' } })
      const canonicalText = row.rows[0].canonical_text as string
      found = {
        version: Number(row.rows[0].id),
        canonical: canonicalText,
        specSha256: sha256(canonicalText),
        createdAt: new Date().toISOString()
      }
    }

    const taskId = `gen_${Date.now()}`
    sendEvent('GenerateStarted', { taskId, specVersion: specVersionInt })

    await ensureBucket()

    const buildMeta = { model, seed, sdkVersion: '1.0.0', astRulesVersion: '1.0.0', generatorGitSha: 'dev', builtAt: new Date().toISOString() }
    const specSha256 = found.specSha256
    const revHash = sha256(specSha256 + canonical(buildMeta))

    const baseKey  = `bots/${botId}/${revHash}`
    const specJson = found.canonical
    const specObj  = JSON.parse(specJson)
    const botJs    = await generateWithEngine(specObj, engine)

    // post-validated successfully
    try { sendEvent('GeneratePostValidated', { taskId, botId, revHash, engine }) } catch {}

    // вычисления через безопасные инт-помощники
    const specBytes  = toInt(byteLenUtf8(specJson))
    const botJsBytes = toInt(byteLenUtf8(botJs))
    const flowsCount = toInt(Array.isArray((specObj as any)?.flows) ? (specObj as any).flows.length : 0)
    const stepsCount = toInt(Array.isArray((specObj as any)?.flows)
      ? (specObj as any).flows.reduce((acc: number, f: any) => acc + (Array.isArray(f?.steps) ? f.steps.length : 0), 0)
      : 0)
    const engineId  = toInt(engine === 'gpt5' ? 1 : 0)
    ;[specBytes, botJsBytes, flowsCount, stepsCount, engineId].forEach((v, i) => { if (!Number.isFinite(v)) throw new Error(`BAD_INT_PARAM_$${i+1}`) })

    // rev.json в S3
    const revObj = {
      revHash,
      specVersion: specVersionInt,
      artifacts: { botJs: `s3://${S3_BUCKET}/${baseKey}/bot.js`, specJson: `s3://${S3_BUCKET}/${baseKey}/spec.json`, revJson: `s3://${S3_BUCKET}/${baseKey}/rev.json` },
      build: { ...buildMeta, flows: flowsCount, steps: stepsCount, engine },
      hashes: { specSha256, botJsSha256: sha256(botJs) },
      sizes:  { specBytes, botJsBytes },
      security: { outboundAllowList: [], maxApiResponseKB: 64, timeoutMs: 5000 },
      author: 'system'
    }
    const revStr = JSON.stringify(revObj)

    await putS3(`${baseKey}/spec.json`, specJson)
    await putS3(`${baseKey}/bot.js`,   botJs)
    await putS3(`${baseKey}/rev.json`, revStr)

    // запись в PG (revisions)
    const specRow = await pool.query(
      'SELECT id FROM spec_versions WHERE bot_id=$1 AND id=$2 LIMIT 1',
      [botId, specVersionInt]
    )
    const specVersionIdRow = specRow.rowCount ? specRow.rows[0].id : found.version
    await pool.query(
      'INSERT INTO revisions (rev_hash, bot_id, spec_version_id, key_prefix) VALUES ($1,$2,$3,$4) ON CONFLICT (rev_hash) DO NOTHING',
      [revHash, botId, specVersionIdRow, baseKey]
    )

    // mirror in-memory
    const meta = { botId, revHash, specVersion: specVersionInt, createdAt: new Date().toISOString(), keyPrefix: baseKey }
    ;(revStore[botId] ||= []).push(meta)
    revByHash.set(revHash, meta)

    sendEvent('GenerateSucceeded', { taskId, revHash })
    return reply.code(202).send({ taskId, revHash })
  })

  // ===== /api/nl/spec =====
  // Вход: { text: string, currentSpec?: BotSpecV1 }
  // Выход: { patch?: RFC6902[], targetSpec?: BotSpecV1, warnings?: string[], canonical?: string }
  app.post('/api/nl/spec', async (req, reply) => {
    try {
      const body = (req.body || {}) as any
      const text: string = String(body.text || '').trim()
      const currentSpec: any = body.currentSpec || null
      const headerBotId = (req.headers['x-bot-id'] as string | undefined)?.trim() || ''
      if (!text) return reply.code(400).send({ error: { code: 'TEXT_REQUIRED' } })

      // 1) System prompt
      const system =
        'Ты — конструктор BotSpec v1 для Telegram. Возвращай ТОЛЬКО JSON. ' +
        'Предпочтительно JSON Patch (RFC-6902); иначе — полный объект. Никакого текста вне JSON. ' +
        'СХЕМА (важно): ' +
        '{"meta":{"botId":string}, "commands":[{"cmd":string,"flow":string}], "flows":[{"name":string,"steps":[{"type":"sendMessage"|"goto"|"http","text"?:string,"to"?:string,"url"?:string,"method"?: "GET"|"POST","body"?:object|null}]}] } ' +
        'ЗАПРЕЩЕНО в commands: "name", "triggers", "steps". Используй ТОЛЬКО {"cmd","flow"}. ' +
        'Пример: {"commands":[{"cmd":"start","flow":"start"}], "flows":[{"name":"start","steps":[{"type":"sendMessage","text":"Привет!"}]}] }. ' +
        'Команды распознаются как "/cmd" и "/cmd@ИмяБота".'

      // 2) Prepare messages
      const apiKey = process.env.GPT5_API_KEY!
      const baseUrl = (process.env.GPT5_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
      const model   = process.env.GPT5_MODEL || 'gpt-5'
      if (!apiKey) return reply.code(500).send({ error:{ code:'GPT5_API_KEY_MISSING' } })

      const currentCanonical = currentSpec ? canonicalize(currentSpec) : undefined
      const userMsg =
        (currentCanonical
          ? `Вот canonical JSON текущей спеки (BotSpec v1):\n${currentCanonical}\n\n`
          : 'Текущая спека отсутствует.\n') +
        `Текст запроса пользователя:\n${text}\n\n` +
        'Верни либо список операций JSON Patch, либо полный целевой объект.'

      // 3) Call GPT-5
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          max_completion_tokens: 1500,
          messages: [
            { role: 'system', content: system },
            { role: 'user',   content: userMsg },
          ],
        }),
      } as any)
      if (!(res as any).ok) {
        const tx = await (res as any).text().catch(()=> '')
        return reply.code(502).send({ error:{ code:`GPT5_HTTP_${(res as any).status}`, message: tx.slice(0,200) } })
      }
      const j = await (res as any).json()
      const raw = String(j?.choices?.[0]?.message?.content ?? '').trim()
      if (!raw) return reply.code(502).send({ error:{ code:'GPT5_EMPTY' } })

      // 4) Parse: try Patch first, else full object
      let patch: jsonpatch.Operation[] | null = null
      let targetSpec: any = null
      let warnings: string[] = []
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.every(op => typeof op === 'object')) {
          if (!currentSpec) throw new Error('PATCH_WITHOUT_BASE')
          targetSpec = jsonpatch.applyPatch(JSON.parse(JSON.stringify(currentSpec)), parsed as any, false).newDocument
          patch = parsed as any
        } else if (parsed && typeof parsed === 'object') {
          targetSpec = parsed
        } else {
          throw new Error('JSON_NOT_OBJECT_OR_PATCH')
        }
      } catch (e:any) {
        return reply.code(400).send({ error:{ code:'JSON_REQUIRED', message: e?.message || String(e) } })
      }

      // normalize «человеческий» формат, чтобы пройти схему
      function normalizeSpecShape(draft: any): any {
        const out = JSON.parse(JSON.stringify(draft || {}))

        // 1) commands: {name,triggers,steps} -> {cmd,flow} + перенести steps в flows
        if (Array.isArray(out.commands)) {
          const flowsByName = new Map<string, any>()
          out.flows = Array.isArray(out.flows) ? out.flows : []

          out.commands = out.commands.map((c: any, idx: number) => {
            if (c && typeof c === 'object' && !('cmd' in c) && ('name' in c)) {
              const flowName = String(c.name || `flow_${idx}`)
              if (Array.isArray(c.steps) && c.steps.length) {
                const steps = c.steps.map((s: any) => {
                  if (s && typeof s === 'object' && 'sendMessage' in s) {
                    const t = s.sendMessage?.text ?? s.sendMessage?.message ?? ''
                    return { type: 'sendMessage', text: String(t ?? '') }
                  }
                  return s
                })
                flowsByName.set(flowName, { name: flowName, steps })
              }
              return { cmd: String(c.name || 'cmd'), flow: flowName }
            }
            return c
          })

          for (const [name, flow] of flowsByName) {
            const i = out.flows.findIndex((f: any) => f?.name === name)
            if (i >= 0) out.flows[i] = flow
            else out.flows.push(flow)
          }
        }

        // 3) flows[].steps: поддержим вложенный формат {"sendMessage":{...}}
        if (Array.isArray(out.flows)) {
          out.flows = out.flows.map((f: any) => {
            if (!Array.isArray(f?.steps)) return f
            const steps = f.steps.map((s: any) => {
              if (s && typeof s === 'object' && 'sendMessage' in s) {
                const t = s.sendMessage?.text ?? s.sendMessage?.message ?? ''
                return { type: 'sendMessage', text: String(t ?? '') }
              }
              return s
            })
            return { ...f, steps }
          })
        }

        return out
      }
      targetSpec = normalizeSpecShape(targetSpec)
      // финальная жёсткая нормализация под AJV и форс botId
      const forAjv = sanitizeSpecForAjv(targetSpec, headerBotId)
      // 5) AJV validation of target spec + canonical
      const ok = validateBotSpec(forAjv)
      if (!ok) {
        warnings.push('AJV_FAILED')
        return reply.code(422).send({ error:{ code:'SPEC_INVALID', details: validateBotSpec.errors }, draft: forAjv })
      }
      const canonicalText = canonicalize(forAjv)
      return reply.send({ patch: patch || undefined, targetSpec: forAjv, canonical: canonicalText, warnings })
    } catch (e:any) {
      return reply.code(500).send({ error:{ code:'NL_SPEC_ERROR', message: e?.message || String(e) } })
    }
  })

  // Явный preflight для /api/nl/*
  app.options('/api/nl/*', async (req, reply) => {
    const origin = String(req.headers.origin || '')
    const allow = new Set([CONSOLE_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174'])
    if (allow.has(origin)) reply.header('Access-Control-Allow-Origin', origin)
    reply
      .header('Vary', 'Origin')
      .header('Access-Control-Allow-Headers', 'Content-Type, If-Match, If-None-Match, x-bot-id, x-bot-secret')
      .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      .header('Access-Control-Allow-Credentials', 'true')
      .code(204)
      .send()
  })

  // ===== /revisions ===== — из PG
  app.get('/revisions', async (req, reply) => {
    const botId = (req.query as any).botId
    if (!botId) return reply.code(400).send({ error:{ code:'BAD_REQUEST', message:'botId query is required' } })

    const r = await pool.query(
      `SELECT rev_hash AS "revHash", bot_id AS "botId", spec_version_id AS "specVersion",
              key_prefix AS "keyPrefix", created_at AS "createdAt"
       FROM revisions
       WHERE bot_id=$1
       ORDER BY created_at DESC`,
      [botId]
    )
    return { items: r.rows }
  })

  // ===== Metrics & DLQ =====
  // Метрики из Redis (простейшие счётчики)
  app.get('/metrics', async () => {
    const keys = await redis.keys('m:*')
    const vals = keys.length ? await redis.mget(keys) : []
    const obj: Record<string, number> = {}
    keys.forEach((k, i) => obj[k] = Number(vals[i] || 0))
    return obj
  })

  // Последние ошибки из DLQ
  app.get('/dlq/:botId', async (req) => {
    const { botId } = req.params as any
    const items = await redis.lrange(`dlq:in:${botId}`, 0, 49)
    return { items: items.map(x => JSON.parse(x)) }
  })

  // ===== /revisions/:revHash ===== — из PG
  app.get('/revisions/:revHash', async (req, reply) => {
    const { revHash } = req.params as any
    const r = await pool.query(
      `SELECT rev_hash AS "revHash", bot_id AS "botId", spec_version_id AS "specVersion",
              key_prefix AS "keyPrefix", created_at AS "createdAt"
       FROM revisions WHERE rev_hash=$1 LIMIT 1`,
      [revHash]
    )
    if (r.rowCount === 0) return reply.code(404).send({ error:{ code:'REVISION_NOT_FOUND' } })
    reply.header('ETag', `rev-${revHash}`)
    return r.rows[0]
  })

  // ===== /bots/:botId ===== — active revision info
  app.get('/bots/:botId', async (req, reply) => {
    const { botId } = req.params as any
    try {
      const r = await pool.query(
        'SELECT bot_id, active_rev_hash FROM bots WHERE bot_id=$1 LIMIT 1',
        [botId]
      )
      if (r.rowCount === 0) return { botId, activeRevHash: activeRev[botId] || null }
      return { botId: r.rows[0].bot_id, activeRevHash: r.rows[0].active_rev_hash || null }
    } catch (e) {
      req.log.error(e, 'failed to fetch bot info')
      return reply.code(500).send({ error: { code: 'INTERNAL' } })
    }
  })

  // ===== /deploy ===== (flip активной ревизии + persist в PG)
  app.post('/deploy', async (req, reply) => {
    const { botId, revHash } = req.body as any
    const taskId = `dep_${Date.now()}`
    deployments[taskId] = { status: 'started', botId, revHash }
    sendEvent('DeployStarted', { taskId, revHash })

    // in-memory
    activeRev[botId] = revHash

    // persist flip в PG
    await pool.query(
      'INSERT INTO bots (bot_id, active_rev_hash) VALUES ($1,$2) ON CONFLICT (bot_id) DO UPDATE SET active_rev_hash=EXCLUDED.active_rev_hash',
      [botId, revHash]
    )

    deployments[taskId].status = 'flipped'
    sendEvent('DeployFlipped', { taskId, revHash })

    // 1) попросим воркеры прогреть рантайм
    try { await redis.publish('deploy:prewarm', JSON.stringify({ botId, revHash })) } catch {}
    // 2) опционально сообщим в SSE, что начат prewarm
    try {
      await redis.publish('sse', JSON.stringify({
        event: 'DeployPrewarmStarted',
        data: { botId, revHash }
      }))
    } catch {}
    return reply.code(202).send({ taskId, activeRevHash: revHash })
  })

  app.get('/deployments/:taskId', async (req, reply) => {
    const { taskId } = req.params as any
    const d = deployments[taskId]
    if (!d) return reply.code(404).send({ error: { code: 'NOT_FOUND' } })
    return d
  })

  // ===== /wh/:botId ===== (Telegram webhook ingress)
  app.post('/wh/:botId', async (req, reply) => {
    try {
      const { botId } = req.params as any
      if (!botId) return reply.code(400).send({ ok:false, error:'botId required' })

      // Validate Telegram secret header
      const incomingSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '')
      try {
        const expected = await getSecret(botId)
        if (!incomingSecret || incomingSecret !== expected) {
          req.log.warn({ botId }, 'webhook forbidden (secret mismatch)')
          return reply.code(403).send({ ok:false })
        }
      } catch {
        // if cannot get secret → forbidden
        return reply.code(403).send({ ok:false })
      }

      const body: any = req.body
      const updateId = body?.update_id
      const chatId = body?.message?.chat?.id
      const text = body?.message?.text ?? ''
      const revHash = activeRev[botId]

      // Idempotency (24h)
      if (updateId != null) {
        const key = `idemp:update:${botId}:${updateId}`
        const ok = await redis.set(key, '1', 'EX', 24 * 60 * 60, 'NX')
        if (ok === null) {
          return reply.code(200).send({ ok: true, botId, revHash, chatId, response: { type: 'noop', text: 'duplicate' } })
        }
      }

      if (!revHash) return reply.code(409).send({ error:{ code:'NO_ACTIVE_REV' } })

      // enqueue job for async processing
      const job = { botId, revHash, chatId, text, ts: Date.now() }
      await redis.lpush(qKey(botId, chatId), JSON.stringify(job))

      // quick ACK
      return reply.code(200).send({ ok: true, enqueued: true, botId, chatId, revHash })
    } catch (e:any) {
      req.log.error(e, 'webhook handler error')
      // Always 200 to Telegram to avoid retries
      return reply.code(200).send({ ok: true })
    }
  })

  // ===== /telegram/webhook ===== (multi-bot by x-telegram-bot-api-secret-token)
  app.post('/telegram/webhook', async (req, reply) => {
    try {
      const secret = (req.headers['x-telegram-bot-api-secret-token'] as string | undefined) || ''
      if (!secret) return reply.code(403).send({ ok:false, error: 'missing secret' })

      const bot = await findBySecret(secret)
      if (!bot || bot.is_active === false) return reply.code(403).send({ ok:false, error: 'unknown bot' })

      const botId = bot.bot_id
      const body: any = req.body
      const updateId = body?.update_id
      const chatId = body?.message?.chat?.id
      const text = body?.message?.text ?? ''
      const revHash = activeRev[botId]

      if (updateId != null) {
        const key = `idemp:update:${botId}:${updateId}`
        const ok = await redis.set(key, '1', 'EX', 24 * 60 * 60, 'NX')
        if (ok === null) return reply.code(200).send({ ok: true, botId, revHash, chatId, response: { type: 'noop', text: 'duplicate' } })
      }
      if (!revHash) return reply.code(409).send({ error:{ code:'NO_ACTIVE_REV' } })

      const job = { botId, revHash, chatId, text, ts: Date.now() }
      await redis.lpush(qKey(botId, chatId), JSON.stringify(job))
      return reply.send({ ok: true, enqueued: true, botId, chatId, revHash })
    } catch (e:any) {
      req.log?.error?.({ err: String(e?.message||e) }, 'telegram webhook error')
      return reply.code(500).send({ ok: false })
    }
  })

  // корневой пинг (удобно проверять в браузере)
  app.get('/', async () => ({ ok: true }))
  app.ready((err) => {
    if (!err) {
      try {
        const outPath = path.resolve(__dirname, 'routes.txt')
        const txt = app.printRoutes({ includeMeta: true }) as unknown as string
        fs.writeFileSync(outPath, txt)
      } catch {}
    }
  })

  // старт сервера
  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info(`API listening on :${PORT} | S3 ${S3_BUCKET} @ ${S3_ENDPOINT}`)

}
main().catch((e) => { console.error(e); process.exit(1) })

// ---- Emulator registration ----
export async function registerEmuRoutes(app: import('fastify').FastifyInstance) {
  app.post('/emu/wh', async (req, reply) => {
    try {
      const body = (req.body || {}) as any
      const botId: string = String(body?.botId || req.headers['x-bot-id'] || 'dev-bot')
      const mode: 'spec'|'active'|'rev' = (body?.mode === 'rev' ? 'rev' : body?.mode === 'active' ? 'active' : 'spec')
      const engine: Engine = (body?.engine === 'gpt5' ? 'gpt5' : 'local')
      const update = body?.update
      const spec = body?.spec
      const specVersion = body?.specVersion
      const revHash = body?.revHash

      let botJs: string | null = null
      if (mode === 'spec') {
        if (!spec && !specVersion) return reply.code(400).send({ ok:false, error:'SPEC_REQUIRED' })
        const effectiveSpec = spec ?? await loadSpecByVersion(botId, specVersion!)
        botJs = await generateBotJs(effectiveSpec, engine)
      } else if (mode === 'rev') {
        botJs = await loadBotJsFromStorage(botId, revHash!)
      } else {
        botJs = await loadActiveBotJs(botId)
      }
      if (!botJs) return reply.code(404).send({ ok:false, error:'BOT_JS_NOT_FOUND' })

      const out: Array<{ text: string; options?: any }> = []
      const stateStore = new Map<string, any>()
      const ctx = {
        update,
        async sendMessage(text: any, options?: any) {
          const norm =
            typeof text === 'string' ? text :
            text == null ? '' :
            typeof text === 'object' ? JSON.stringify(text, null, 2) :
            String(text)
          out.push({ text: norm, options })
        },
        async getState() { return stateStore.get(botId) || {} },
        async setState(next: any) { stateStore.set(botId, next) },
      }
      const sandbox: any = { module: { exports: {} }, exports: {}, console, setTimeout, clearTimeout }
      vm.runInNewContext(botJs, sandbox, { timeout: 1000 })
      const handler = sandbox.module?.exports?.handleUpdate
      if (typeof handler !== 'function') return reply.code(400).send({ ok:false, error:'MISSING_EXPORT_handleUpdate' })
      await Promise.resolve(handler(ctx))
      return reply.send({ ok:true, messages: out, state: await ctx.getState() })
    } catch (e:any) {
      return reply.code(500).send({ ok:false, error: e?.message || 'EMU_FAIL' })
    }
  })
}

async function loadActiveBotJs(_botId: string): Promise<string|null> { return null }
async function loadBotJsFromStorage(_botId: string, _rev: string): Promise<string|null> { return null }
async function loadSpecByVersion(_botId: string, _v: number): Promise<any> { return null }

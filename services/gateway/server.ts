// server.ts — minimal end-to-end API
// Console → POST /spec → POST /generate → S3 → POST /deploy → activeRevHash → POST /wh/:botId (echo)
// + GET /events (SSE)
import Redis from 'ioredis'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import crypto from 'node:crypto'
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { Pool } from 'pg'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import multipart from '@fastify/multipart'
import { generateBotJs } from './generator'




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
redisSub.subscribe('sse')
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
const pool = new Pool({
  host: PG_HOST, port: PG_PORT, database: PG_DB, user: PG_USER, password: PG_PASS
})

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

async function main() {
    await app.register(cors, {
      origin: [CONSOLE_ORIGIN, 'http://127.0.0.1:5173'],
      credentials: true,
      allowedHeaders:  ['content-type', 'x-bot-id', 'x-bot-secret']
    })
  
    await app.register(multipart)
  
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

  // SSE
  app.get('/events', async (req, reply) => {
    const origin = (req.headers.origin as string) || ''
    const allowedOrigins = new Set([CONSOLE_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'])
    if (allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin)
      reply.header('Vary', 'Origin')
    }

    reply
      .header('Cache-Control', 'no-cache')
      .header('Content-Type', 'text/event-stream')
      .header('Connection', 'keep-alive')
      .code(200)

    // первая «пустая» строка по протоколу SSE
    reply.raw.write('\n')
    clients.add(reply.raw)
    req.raw.on('close', () => clients.delete(reply.raw))
  })
  // --- heartbeat раз в 15 сек
   setInterval(() => {
        sendEvent('ping', { t: Date.now() })
    }, 15_000)

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

    const valid = validateBotSpec(spec)
    if (!valid) {
      const details = (validateBotSpec.errors || []).map((e: any) => ({
        path: e.instancePath || e.schemaPath,
        keyword: e.keyword,
        message: e.message
      }))
      return reply.code(400).send({ error: { code: 'SPEC_INVALID_SCHEMA', message: 'Validation failed', details } })
    }
    const botId = (spec as any)?.meta?.botId as string

    const text = canonical(spec)
    const specSha256 = sha256(text)

    // write to PG
    const ins = await pool.query(
      'INSERT INTO spec_versions (bot_id, schema_ver, canonical_spec, spec_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [botId, (spec as any)?.meta?.schema_ver ?? '1.0.0', JSON.parse(text), specSha256]
    )
    const version = Number(ins.rows[0].id)

    // save original spec.json to S3 as bots/<botId>/<specSha>.json
    try {
      await ensureBucket()
      const s3Key = `bots/${botId}/${specSha256}.json`
      await putS3(s3Key, JSON.stringify(spec))
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
    const { botId, specVersion, model = 'gpt-5', seed = 0 } = req.body as any

    // ищем в памяти, иначе тянем из PG
    let found = (specStore[botId] || []).find(x => x.version === Number(specVersion))
    if (!found) {
      const row = await pool.query(
        'SELECT id, canonical_spec::text AS canonical_text FROM spec_versions WHERE bot_id=$1 AND id=$2 LIMIT 1',
        [botId, Number(specVersion)]
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
    sendEvent('GenerateStarted', { taskId, specVersion })

    await ensureBucket()

    const buildMeta = { model, seed, sdkVersion: '1.0.0', astRulesVersion: '1.0.0', generatorGitSha: 'dev', builtAt: new Date().toISOString() }
    const specSha256 = found.specSha256
    const revHash = sha256(specSha256 + canonical(buildMeta))

    const baseKey  = `bots/${botId}/${revHash}`
    const specJson = found.canonical
    const specObj  = JSON.parse(specJson)
    const botJs    = generateBotJs(specObj)
    const revJson  = JSON.stringify({
      revHash, specVersion,
      artifacts: { botJs: `s3://${S3_BUCKET}/${baseKey}/bot.js`, specJson: `s3://${S3_BUCKET}/${baseKey}/spec.json`, revJson: `s3://${S3_BUCKET}/${baseKey}/rev.json` },
      build: buildMeta,
      hashes: { specSha256, botJsSha256: sha256(botJs) },
      sizes:  { specJson: Buffer.byteLength(specJson), botJs: Buffer.byteLength(botJs) },
      security: { outboundAllowList: [], maxApiResponseKB: 64, timeoutMs: 5000 },
      author: 'system'
    }, null, 2)

    await putS3(`${baseKey}/spec.json`, specJson)
    await putS3(`${baseKey}/bot.js`,   botJs)
    await putS3(`${baseKey}/rev.json`, revJson)

    // запись в PG (revisions)
    const specRow = await pool.query(
      'SELECT id FROM spec_versions WHERE bot_id=$1 AND id=$2 LIMIT 1',
      [botId, Number(specVersion)]
    )
    const specVersionId = specRow.rowCount ? specRow.rows[0].id : found.version
    await pool.query(
      'INSERT INTO revisions (rev_hash, bot_id, spec_version_id, key_prefix) VALUES ($1,$2,$3,$4) ON CONFLICT (rev_hash) DO NOTHING',
      [revHash, botId, specVersionId, baseKey]
    )

    // mirror in-memory
    const meta = { botId, revHash, specVersion, createdAt: new Date().toISOString(), keyPrefix: baseKey }
    ;(revStore[botId] ||= []).push(meta)
    revByHash.set(revHash, meta)

    sendEvent('GenerateSucceeded', { taskId, revHash })
    return reply.code(202).send({ taskId, revHash })
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
    return reply.code(202).send({ taskId, activeRevHash: revHash })
  })

  app.get('/deployments/:taskId', async (req, reply) => {
    const { taskId } = req.params as any
    const d = deployments[taskId]
    if (!d) return reply.code(404).send({ error: { code: 'NOT_FOUND' } })
    return d
  })

  // ===== /wh/:botId ===== (Runtime echo)
  app.post('/wh/:botId', async (req, reply) => {
    if ((req.headers['x-bot-secret'] as string) !== BOT_SECRET)
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED' } })
  
    const { botId } = req.params as any
    const body: any = req.body
    const updateId = body?.update_id
    const chatId = body?.message?.chat?.id
    const text = body?.message?.text ?? ''
    const revHash = activeRev[botId]
  
    // --- Idempotency: ключ на 24 часа
    if (updateId != null) {
      const key = `idemp:update:${botId}:${updateId}`
      const ok = await redis.set(key, '1', 'EX', 24 * 60 * 60, 'NX') // EX+NX
      if (ok === null) {
        // уже видели этот апдейт — отвечаем тем же 200 OK, но не выполняем логику второй раз
        return { ok: true, botId, revHash, chatId, response: { type: 'noop', text: 'duplicate' } }
      }
    }
    if (!revHash) return reply.code(409).send({ error:{ code:'NO_ACTIVE_REV' } })

    // enqueue job for async processing
    const job = { botId, revHash, chatId, text, ts: Date.now() }
    await redis.lpush(qKey(botId, chatId), JSON.stringify(job))

    // quick ACK
    return { ok: true, enqueued: true, botId, chatId, revHash }
  })

  // корневой пинг (удобно проверять в браузере)
  app.get('/', async () => ({ ok: true }))

  // старт сервера
  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info(`API listening on :${PORT} | S3 ${S3_BUCKET} @ ${S3_ENDPOINT}`)

}
main().catch((e) => { console.error(e); process.exit(1) })

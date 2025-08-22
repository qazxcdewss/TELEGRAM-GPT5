// server.ts — minimal end-to-end API
// Console → POST /spec → POST /generate → S3 → POST /deploy → activeRevHash → POST /wh/:botId (echo)
// + GET /events (SSE)
import Redis from 'ioredis'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import crypto from 'node:crypto'
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { Pool } from 'pg'

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

// ===== Helpers =====
const sortKeys = (x: any): any =>
  Array.isArray(x) ? x.map(sortKeys)
  : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sortKeys(x[k])]))
    : x

const canonical = (o: any) => JSON.stringify(sortKeys(o))
const sha256    = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

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

// ===== PG =====
const pool = new Pool({
  host: PG_HOST, port: PG_PORT, database: PG_DB, user: PG_USER, password: PG_PASS
})

// ===== SSE Hub =====
const clients = new Set<import('http').ServerResponse>()
function sendEvent(event: string, data: any) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`
  for (const c of clients) { try { c.write(payload) } catch { /* ignore */ } }
}

// ===== Fastify =====
const app = Fastify({ logger: true })

async function main() {
    await app.register(cors, {
      origin: [CONSOLE_ORIGIN],
      credentials: true,
      allowedHeaders: ['content-type', 'x-bot-secret']
    })
  
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
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    reply.raw.write('\n')
    clients.add(reply.raw)
    req.raw.on('close', () => clients.delete(reply.raw))
  })
  // --- heartbeat раз в 15 сек
   setInterval(() => {
        sendEvent('ping', { t: Date.now() })
    }, 15_000)

  // ===== /spec ===== (создать новую версию Spec; immutable в PG)
  app.post('/spec', async (req, reply) => {
    const spec = req.body as any
    const botId = spec?.meta?.botId || spec?.botId
    if (!botId) return reply.code(400).send({ error: { code: 'SPEC_INVALID_SCHEMA', message: 'meta.botId is required' } })

    const text = canonical(spec)
    const specSha256 = sha256(text)

    // write to PG
    const ins = await pool.query(
      'INSERT INTO spec_versions (bot_id, schema_ver, canonical_spec, spec_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [botId, spec?.meta?.schema_ver ?? '1.0.0', JSON.parse(text), specSha256]
    )
    const version = Number(ins.rows[0].id)

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
    const botJs    = `export async function handleUpdate(ctx){return { type:'text', text:'echo: '+(ctx?.message?.text||'') }}`
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
    const echoText = body?.message?.text ?? ''
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
  
    // текущий синхронный echo (дальше вынесем в очередь)
    return { ok: true, botId, revHash, chatId, response: { type: 'text', text: `echo: ${echoText}` } }
  })

  // корневой пинг (удобно проверять в браузере)
  app.get('/', async () => ({ ok: true }))

  // старт сервера
  await app.listen({ port: PORT, host: '0.0.0.0' })
  app.log.info(`API listening on :${PORT} | S3 ${S3_BUCKET} @ ${S3_ENDPOINT}`)

}
main().catch((e) => { console.error(e); process.exit(1) })

import { FastifyInstance } from 'fastify'
import { createOrUpdateBot, listBots, setUsername, getDecryptedToken, getSecret } from '../bots-repo'

async function getNgrokHttps(): Promise<string|undefined> {
  try {
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { method:'GET' } as any)
    if (!r?.ok) return
    const j = await (r as any).json()
    const t = (j?.tunnels || []).find((x:any)=> String(x.public_url||'').startsWith('https://'))
    return t?.public_url?.replace(/\/+$/,'')
  } catch {}
}

function guessFromHeaders(req: any): string|undefined {
  try {
    const proto = String((req.headers?.['x-forwarded-proto'] as any) || 'https')
    const host  = String((req.headers?.['x-forwarded-host'] as any) || (req.headers?.['host'] as any) || '')
    if (host) return `${proto}://${host}`.replace(/\/+$/,'')
  } catch {}
}

export default async function botsRoutes(fastify: FastifyInstance) {
  const getOwner = () => process.env.DEV_OWNER_ID || 'dev-user-1'

  // Создать бота (token опционален → draft)
  fastify.post('/api/bots', async (req, reply) => {
    try {
      const { botId, title, token } = (req.body || {}) as any
      if (!botId || !title) {
        return reply.code(400).send({ ok: false, error: 'botId/title required' })
      }
      const row = await createOrUpdateBot({ botId, title, token: token || null, ownerUserId: getOwner() })
      const status = row.tg_username ? 'connected' : (row.token_encrypted ? 'has-token' : 'draft')
      return reply.send({ ok: true, bot: { botId: row.bot_id, title: row.title, username: row.tg_username || null, status } })
    } catch (e: any) {
      req.log.error(e, 'create bot error')
      return reply.code(500).send({ ok: false, error: e?.message || 'internal' })
    }
  })

  fastify.get('/api/bots', async (_req, reply) => {
    const rows = await listBots(getOwner())
    return reply.send({ ok: true, bots: rows.map(r => ({
      botId: r.bot_id, title: r.title, username: r.tg_username, createdAt: r.created_at, updatedAt: r.updated_at
    })) })
  })

  // Добавить/обновить токен позже
  fastify.post('/api/bots/:botId/token', async (req, reply) => {
    try {
      const botId = String((req.params as any).botId || '')
      const { token } = (req.body || {}) as any
      if (!botId || !token) return reply.code(400).send({ ok:false, error:'botId/token required' })
      await createOrUpdateBot({ botId, title: undefined, token, ownerUserId: getOwner() })
      return reply.send({ ok:true })
    } catch (e:any) {
      req.log.error(e, 'set token error')
      return reply.code(500).send({ ok:false, error:e?.message || 'internal' })
    }
  })

  fastify.post('/api/bots/:botId/validate', async (req, reply) => {
    try {
      const botId = (req.params as any).botId
      const token = await getDecryptedToken(botId)
      const r = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(r => r.json())
      if (r?.ok) {
        await setUsername(botId, r.result.username)
        return reply.send({ ok: true, username: r.result.username })
      }
      return reply.code(400).send({ ok: false, error: r?.description || 'getMe failed' })
    } catch (e: any) {
      req.log.error(e, 'validate bot error')
      return reply.code(500).send({ ok: false, error: e?.message || 'internal' })
    }
  })

  fastify.post('/api/bots/:botId/setWebhook', async (req, reply) => {
    try {
      const botId = String((req.params as any).botId || '')
      const body  = (req.body || {}) as any
      let url = String(body?.url || '')
      if (!botId) return reply.code(400).send({ ok:false, error:'botId required' })

      // compute public base if url not provided
      if (!url) {
        const envBase = (process.env.PUBLIC_BASE || '').replace(/\/+$/,'')
        const viaNgrok = await getNgrokHttps()
        const viaHdrs  = guessFromHeaders(req)
        const publicBase = envBase || viaNgrok || viaHdrs
        if (!publicBase) return reply.code(400).send({ ok:false, error:'Cannot determine public base (set PUBLIC_BASE or run ngrok)' })
        url = `${publicBase}/wh/${encodeURIComponent(botId)}`
      }

      const token = await getDecryptedToken(botId)
      const secret = await getSecret(botId)

      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret, drop_pending_updates: true })
      } as any).then(r => r.json())

      if (!r?.ok) return reply.code(400).send({ ok: false, error: r?.description || 'setWebhook failed' })
      return reply.send({ ok: true, url })
    } catch (e: any) {
      req.log.error(e, 'set webhook error')
      return reply.code(500).send({ ok: false, error: e?.message || 'internal' })
    }
  })
}



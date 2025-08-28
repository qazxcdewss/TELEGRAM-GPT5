import { FastifyInstance } from 'fastify'
import { createOrUpdateBot, listBots, setUsername, getDecryptedToken, getSecret } from '../bots-repo'

export default async function botsRoutes(fastify: FastifyInstance) {
  const getOwner = () => process.env.DEV_OWNER_ID || 'dev-user-1'

  fastify.post('/api/bots', async (req, reply) => {
    try {
      const { botId, title, token } = (req.body || {}) as any
      if (!botId || !title || !token) {
        return reply.code(400).send({ ok: false, error: 'botId/title/token required' })
      }
      const row = await createOrUpdateBot({ botId, title, token, ownerUserId: getOwner() })
      return reply.send({ ok: true, bot: { botId: row.bot_id, title: row.title, secret_token: row.secret_token } })
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
      const botId = (req.params as any).botId
      const body = (req.body || {}) as any
      const urlBase = String(body.urlBase || process.env.TG_WEBHOOK_URL_BASE || '').replace(/\/+$/, '')
      if (!urlBase) return reply.code(400).send({ ok: false, error: 'urlBase or TG_WEBHOOK_URL_BASE required' })

      const token = await getDecryptedToken(botId)
      const secret = await getSecret(botId)
      const url = `${urlBase}/telegram/webhook`

      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret })
      }).then(r => r.json())

      if (!r?.ok) return reply.code(400).send({ ok: false, error: r?.description || 'setWebhook failed' })
      return reply.send({ ok: true, url })
    } catch (e: any) {
      req.log.error(e, 'set webhook error')
      return reply.code(500).send({ ok: false, error: e?.message || 'internal' })
    }
  })
}



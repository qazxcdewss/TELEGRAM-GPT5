import { FastifyInstance } from 'fastify'
import { postValidateBotJs } from '../../../lib/botjs-validate'
import { validateBotJs } from '../validate-bot-ast'

export default async function devRoutes(app: FastifyInstance) {
  app.post('/api/dev/validate-bot', async (req, reply) => {
    try {
      const { js, maxKB } = (req.body || {}) as any
      if (typeof js !== 'string' || !js.trim()) {
        return reply.code(400).send({ ok: false, error: 'js (string) is required' })
      }
      postValidateBotJs(js, Number(maxKB ?? (process.env.GPT5_MAX_BOT_KB ?? 64)))
      validateBotJs(js)
      return reply.send({ ok: true })
    } catch (e: any) {
      return reply.code(400).send({ ok: false, error: e.message, details: (e as any)?.details || [] })
    }
  })
}



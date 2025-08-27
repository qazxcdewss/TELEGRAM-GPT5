// scripts/ivm-smoke.ts
import { IVMRunner } from '../runner/ivm-runtime'

const botJs = `
  module.exports.handleUpdate = async function(ctx) {
    // Доказательство, что лог идет из изолята:
    console.log('hello from ivm', ctx.botId);
    await ctx.sendMessage({ type: 'text', text: 'IVM OK: ' + (ctx.chat?.id ?? 'unknown') });
  };
`

async function main() {
  const r = new IVMRunner({ memoryMb: 64, timeoutMs: 250 })
  await r.init(botJs)

  const sent: any[] = []
  await r.handleUpdate(
    { botId: 'test-bot', chat: { id: 123 }, state: {} },
    {
      sendMessage: async (p) => { sent.push(p) },
      http: async () => ({ status: 204, body: null }),
      goto: async () => {},
      getState: async () => ({}),
      setState: async () => {},
    }
  )

  console.log('SMOKE:', sent[0])
  r.dispose()
}
main().catch(e => { console.error(e) })

//npx tsx --env-file=../.env.dev ivm-smoke.ts
//ожидаем строку [ivm] hello from ivm test-bot; строку SMOKE: { type: 'text', text: 'IVM OK: 123' }
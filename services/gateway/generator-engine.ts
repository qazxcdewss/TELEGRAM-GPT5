// generator-engine.ts
import { generateBotJsWithGpt5 } from '../../lib/gpt5'
import { postValidateBotJs } from '../../lib/botjs-validate'
import { validateBotJs } from './validate-bot-ast'

// это твой текущий локальный генератор
import { generateBotJs as generateLocal } from './generator'

export type Engine = 'local' | 'gpt5'

export async function generateBotJs(spec: unknown, engine: Engine = 'local'): Promise<string> {
  let js: string
  if (engine === 'local') {
    js = await Promise.resolve(generateLocal(spec as any))
  } else {
    js = await generateBotJsWithGpt5(spec)
  }
  const maxKB = Number(process.env.GPT5_MAX_BOT_KB || 64)
  try {
    postValidateBotJs(js, maxKB)
  } catch (e:any) {
    console.error('[gen] broken bot.js >>>\n' + js + '\n<<< broken bot.js')
    throw e
  }
  validateBotJs(js)
  return js
}



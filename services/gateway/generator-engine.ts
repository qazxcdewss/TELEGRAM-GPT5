// generator-engine.ts
import { generateBotJsWithGpt5 } from '../../lib/gpt5'
import { postValidateBotJs } from '../../lib/botjs-validate'

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
  postValidateBotJs(js, maxKB)
  return js
}



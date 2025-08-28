// services/gateway/telegram.ts
import crypto from 'node:crypto'
import { getDecryptedToken } from './bots-repo'

// Токен из БД
export async function getTelegramToken(botId: string): Promise<string> {
  return getDecryptedToken(botId)
}

// (опционально) подпись запроса, если когда-то понадобится
function traceId() { return crypto.randomBytes(8).toString('hex') }

type SendMessageOpts = {
  parseMode?: 'MarkdownV2' | 'HTML' | 'Markdown'
  disablePreview?: boolean
  replyToMessageId?: number
}

// универсальный fetch с 429-backoff
async function tgFetch(token: string, method: string, body: any) {
  const url = `https://api.telegram.org/bot${token}/${method}`
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }

  // до 3 попыток, соблюдаем retry_after
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, req as any)
    const text = await res.text()
    let json: any
    try { json = JSON.parse(text) } catch { json = { ok: false, error: text } }

    // ok
    if (res.ok && json?.ok) return json

    // 429 — выдержим паузу
    if (res.status === 429) {
      const ra = Number(json?.parameters?.retry_after ?? 1)
      await new Promise(r => setTimeout(r, (ra + 0.5) * 1000))
      continue
    }

    // 5xx — лёгкий ретрай
    if (res.status >= 500 && res.status < 600) {
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)))
      continue
    }

    throw new Error(`TG_${method}_FAIL_${res.status}_${text.slice(0,180)}`)
  }
  throw new Error(`TG_${method}_RETRY_EXHAUSTED`)
}

export async function sendTelegramText(
  botId: string,
  chatId: string | number,
  text: string,
  opts: SendMessageOpts = {}
) {
  const token = await getTelegramToken(botId)
  const body: any = {
    chat_id: chatId,
    text,
    disable_web_page_preview: Boolean(opts.disablePreview ?? true),
  }
  if (opts.parseMode) body.parse_mode = opts.parseMode
  if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId

  const res = await tgFetch(token, 'sendMessage', body)
  return res?.result
}



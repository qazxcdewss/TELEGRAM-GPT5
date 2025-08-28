import { pool } from './db'
import { decryptToken } from './crypto'

export async function getTelegramTokenFromDB(botId: string): Promise<string> {
  const r = await pool.query('SELECT tg_token_enc FROM bots WHERE bot_id=$1 LIMIT 1', [botId])
  const blob: Buffer | null = r.rows[0]?.tg_token_enc ?? null
  if (!blob) throw new Error('BOT_TOKEN_NOT_SET')
  return decryptToken(blob)
}



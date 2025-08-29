import crypto from 'node:crypto'
import { pgPool } from './db'
import { encryptToken, decryptToken } from './crypto'

export type BotRecord = {
  bot_id: string
  title: string | null
  tg_username: string | null
  tg_token_enc: Buffer | null
  secret_token: string | null
  owner_user_id: string | null
  is_active: boolean | null
  created_at: string | null
  updated_at: string | null
  active_rev_hash: string | null
}

export type BotRow = {
  bot_id: string
  title: string | null
  tg_username: string | null
  tg_token_enc: Buffer | null
  secret_token: string | null
  owner_user_id: string | null
  is_active: boolean | null
  created_at: string | null
  updated_at: string | null
  active_rev_hash: string | null
}

export async function createBot(p: {
  botId: string
  title: string
  token: string
  ownerUserId: string
}): Promise<BotRecord> {
  const enc = encryptToken(p.token)
  const secret = crypto.randomUUID()

  const q = `
    INSERT INTO bots (bot_id, title, tg_token_enc, secret_token, owner_user_id, is_active)
    VALUES ($1,$2,$3,$4,$5,true)
    ON CONFLICT (bot_id) DO UPDATE
      SET title=EXCLUDED.title,
          tg_token_enc=EXCLUDED.tg_token_enc,
          owner_user_id=EXCLUDED.owner_user_id,
          is_active=true,
          updated_at=now()
    RETURNING *`
  const r = await pgPool.query(q, [p.botId, p.title, enc, secret, p.ownerUserId])
  return r.rows[0] as BotRecord
}

export async function createOrUpdateBot(p: {
  botId: string; title: string; token: string; ownerUserId: string;
}): Promise<BotRow> {
  const enc = encryptToken(p.token)
  const secret = crypto.randomUUID()
  const q = `
    INSERT INTO bots (bot_id, title, tg_token_enc, secret_token, owner_user_id, is_active)
    VALUES ($1,$2,$3,$4,$5,true)
    ON CONFLICT (bot_id) DO UPDATE
      SET title=EXCLUDED.title,
          tg_token_enc=EXCLUDED.tg_token_enc,
          owner_user_id=EXCLUDED.owner_user_id,
          is_active=true,
          updated_at=now()
    RETURNING *`
  const r = await pgPool.query(q, [p.botId, p.title, enc, secret, p.ownerUserId])
  return r.rows[0] as BotRow
}

export async function setUsername(botId: string, username: string): Promise<void> {
  await pgPool.query('UPDATE bots SET tg_username=$2, updated_at=now() WHERE bot_id=$1', [botId, username])
}

export async function findBySecret(secret: string): Promise<BotRecord | null> {
  const r = await pgPool.query('SELECT * FROM bots WHERE secret_token=$1 LIMIT 1', [secret])
  return r.rowCount ? (r.rows[0] as BotRecord) : null
}

export async function findById(botId: string): Promise<BotRecord | null> {
  const r = await pgPool.query('SELECT * FROM bots WHERE bot_id=$1 LIMIT 1', [botId])
  return r.rowCount ? (r.rows[0] as BotRecord) : null
}

export async function getDecryptedToken(botId: string): Promise<string> {
  const r = await pgPool.query('SELECT tg_token_enc FROM bots WHERE bot_id=$1 LIMIT 1', [botId])
  const blob: Buffer | null = r.rows[0]?.tg_token_enc ?? null
  if (!blob) throw new Error('BOT_TOKEN_NOT_SET')
  return decryptToken(blob)
}

export async function listBots(ownerUserId: string): Promise<BotRow[]> {
  const r = await pgPool.query(
    'SELECT bot_id, title, tg_username, is_active, secret_token, created_at, updated_at FROM bots WHERE owner_user_id=$1 ORDER BY created_at DESC',
    [ownerUserId]
  )
  return r.rows as BotRow[]
}

export async function getSecret(botId: string): Promise<string> {
  const r = await pgPool.query('SELECT secret_token FROM bots WHERE bot_id=$1 LIMIT 1', [botId])
  if (!r.rowCount || !r.rows[0].secret_token) throw new Error('BOT_SECRET_NOT_SET')
  return r.rows[0].secret_token
}



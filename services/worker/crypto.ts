import { createDecipheriv } from 'node:crypto'

const KEY = Buffer.from(process.env.BOT_TOKEN_ENC_KEY || '', 'base64')
if (KEY.length !== 32) throw new Error(`BOT_TOKEN_ENC_KEY must be 32 bytes base64 (got ${KEY.length})`)

export function decryptToken(blob: Buffer): string {
  if (!Buffer.isBuffer(blob) || blob.length < 1 + 12 + 16) throw new Error('bad blob')
  const iv  = blob.subarray(1, 13)
  const tag = blob.subarray(13, 29)
  const enc = blob.subarray(29)
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  const out = Buffer.concat([decipher.update(enc), decipher.final()])
  return out.toString('utf8')
}



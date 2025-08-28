import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const KEY_B64 = process.env.BOT_TOKEN_ENC_KEY || ''
const KEY = Buffer.from(KEY_B64, 'base64')

if (KEY.length !== 32) {
  throw new Error(
    `BOT_TOKEN_ENC_KEY must be 32 bytes base64 (got ${KEY.length}). ` +
    `Regenerate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  )
}

export function encryptToken(plain: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // simple framing: 0x01 | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from([1]), iv, tag, enc])
}

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



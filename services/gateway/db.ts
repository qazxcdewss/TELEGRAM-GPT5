import type { Pool } from 'pg'
import { Pool as PgPool } from 'pg'

export const pgPool: Pool = new PgPool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT || 5433),
  database: process.env.PG_DB || process.env.PG_DATABASE || 'tgpt5',
  user: process.env.PG_USER || 'tgpt5',
  password: process.env.PG_PASSWORD || 'tgpt5',
})



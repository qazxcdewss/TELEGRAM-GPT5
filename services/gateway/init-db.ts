import { pgPool } from './db';

const PG_HOST = process.env.PG_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.PG_PORT ?? 5433); // <-- 5433 по умолчанию
const PG_DB   = process.env.PG_DB   ?? 'tgpt5';
const PG_USER = process.env.PG_USER ?? 'tgpt5';
const PG_PASS = process.env.PG_PASSWORD ?? 'tgpt5';

console.log(`Connecting to Postgres ${PG_USER}@${PG_HOST}:${PG_PORT}/${PG_DB} ...`);

const pool = pgPool;

const sql = `
CREATE TABLE IF NOT EXISTS bots (
  bot_id text PRIMARY KEY,
  active_rev_hash text
);

CREATE TABLE IF NOT EXISTS spec_versions (
  id bigserial PRIMARY KEY,
  bot_id text NOT NULL,
  schema_ver text,
  canonical_spec jsonb NOT NULL,
  spec_hash text NOT NULL,
  author text DEFAULT 'system',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spec_versions_bot_id_id_desc ON spec_versions(bot_id, id DESC);

CREATE TABLE IF NOT EXISTS revisions (
  rev_hash text PRIMARY KEY,
  bot_id text NOT NULL,
  spec_version_id bigint NOT NULL REFERENCES spec_versions(id),
  key_prefix text NOT NULL,
  created_at timestamptz DEFAULT now()
);
 
 -- === MIGRATION: extend 'bots' for multi-bot support ===
 ALTER TABLE IF EXISTS bots
   ADD COLUMN IF NOT EXISTS title          text,
   ADD COLUMN IF NOT EXISTS tg_username    text,
   ADD COLUMN IF NOT EXISTS tg_token_enc   bytea,
   ADD COLUMN IF NOT EXISTS secret_token   text,
   ADD COLUMN IF NOT EXISTS owner_user_id  text,
   ADD COLUMN IF NOT EXISTS is_active      boolean DEFAULT true,
   ADD COLUMN IF NOT EXISTS created_at     timestamptz DEFAULT now(),
   ADD COLUMN IF NOT EXISTS updated_at     timestamptz DEFAULT now();

 CREATE INDEX IF NOT EXISTS bots_owner_idx ON bots(owner_user_id);
 CREATE UNIQUE INDEX IF NOT EXISTS bots_secret_idx ON bots(secret_token);
`;

pool.query(sql)
  .then(() => {
    console.log('Tables created ✅');
  })
  .catch((err: any) => {
    console.error('Error creating tables', err);
  })
  .finally(() => pool.end());

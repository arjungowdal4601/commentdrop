import pg from 'pg';
import { readFileSync } from 'node:fs';

// Supabase Postgres through its connection pooler (DATABASE_URL). For local
// testing without a database, LOCAL_PGLITE=1 runs Postgres in-process.
let pool;

async function getPool() {
  if (pool) return pool;
  if (process.env.LOCAL_PGLITE) {
    const { PGlite } = await import('@electric-sql/pglite');
    const lite = new PGlite(process.env.LOCAL_PGLITE === 'memory' ? undefined : process.env.LOCAL_PGLITE);
    await lite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    pool = { query: (text, params) => lite.query(text, params) };
    return pool;
  }
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10_000,
  });
  return pool;
}

export async function q(text, params = []) {
  const { rows } = await (await getPool()).query(text, params);
  return rows;
}
export const one = async (text, params) => (await q(text, params))[0] || null;

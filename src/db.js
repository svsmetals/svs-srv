import pg from 'pg';
import { config } from './config.js';

// Supabase (and any sslmode=require URL) needs TLS. The cert chain isn't always
// present locally, so don't fail verification — the connection is still encrypted.
const needsSsl = /supabase\.|sslmode=require/.test(config.databaseUrl);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export function query(text, params) {
  return pool.query(text, params);
}

// Run a set of statements in a single transaction. `fn` receives a client that
// has already issued BEGIN; COMMIT/ROLLBACK are handled here.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

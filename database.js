import pg from 'pg';

const { Pool, types } = pg;

// Keep IDs compatible with the frontend's numeric identifiers where safe.
types.setTypeParser(20, value => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
});

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for PostgreSQL mode.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable'
    ? false
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', error => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

export async function query(text, values = []) {
  return pool.query(text, values);
}

export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('PostgreSQL rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  await pool.end();
}

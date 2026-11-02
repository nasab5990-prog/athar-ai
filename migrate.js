import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, withTransaction, closePool } from './db/postgres.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const version = '001_initial_schema';

try {
  const applied = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [version]
  ).catch((error) => {
    if (error.code === '42P01') return { rows: [] };
    throw error;
  });

  if (applied.rows.length) {
    console.log(`Migration ${version} already applied.`);
  } else {
    const sql = await readFile(path.join(here, 'db', 'schema.sql'), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [version]
      );
    });
    console.log(`Migration ${version} applied successfully.`);
  }
} catch (error) {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await closePool();
}

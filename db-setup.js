import 'dotenv/config';
import fs from 'node:fs/promises';
import { pool } from './database.js';

async function main() {
  const schema = await fs.readFile(new URL('./postgres-schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  console.log('PostgreSQL schema applied successfully.');
}

main()
  .catch(error => { console.error('Schema setup failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());

import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import { pool } from './postgres.js';

const PgStore = connectPgSimple(session);

/**
 * PostgreSQL-backed Express session store.
 * connect-pg-simple creates its session table when first used.
 */
export const sessionStore = new PgStore({
  pool,
  tableName: process.env.PG_SESSION_TABLE || 'athar_sessions',
  createTableIfMissing: true,
  pruneSessionInterval: 15 * 60
});

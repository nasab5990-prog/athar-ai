import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import { pool } from './db/postgres.js';
import { sessionStore } from './db/session-store.js';
import * as auth from './db/auth.js';
import * as access from './db/authorization.js';
import { registerPostgresAuthRoutes } from './db/postgres-auth-routes.js';
import { registerPostgresDataRoutes } from './db/postgres-data-routes.js';
import { registerPostgresAnalysisRoute } from './db/postgres-analysis-route.js';

const app = express();
const production = process.env.NODE_ENV === 'production';
const origins = (process.env.FRONTEND_ORIGIN || 'https://nasab5990-prog.github.io')
  .split(',').map(value => value.trim()).filter(Boolean);

if (production && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 ||
    !process.env.OTP_SECRET || process.env.OTP_SECRET.length < 32)) {
  throw new Error('Production requires SESSION_SECRET and OTP_SECRET of at least 32 characters.');
}

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => !origin || !origins.length || origins.includes(origin)
    ? callback(null, true) : callback(new Error('Origin not allowed')),
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'athar.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true, secure: production,
    sameSite: process.env.COOKIE_SAMESITE || (production ? 'none' : 'lax'),
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const authMiddleware = registerPostgresAuthRoutes(app, {
  auth, access,
  demoEnabled: process.env.DEMO_LOGIN_ENABLED === 'true',
  otpSecret: process.env.OTP_SECRET,
  sessionSecret: process.env.SESSION_SECRET,
  mailConfig: {
    host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM
  }
});

registerPostgresDataRoutes(app, { ...authMiddleware, writeAudit: auth.writeAudit });
registerPostgresAnalysisRoute(app, authMiddleware);

app.get('/api/health', async (req, res, next) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'athar-api', database: 'postgresql' });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ message: 'حدث خطأ داخلي. راجع سجل الخادم.' });
});

export { app };
if (process.env.ATHAR_POSTGRES_AUTOSTART === 'true') {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`ATHAR PostgreSQL API listening on ${port}`));
}

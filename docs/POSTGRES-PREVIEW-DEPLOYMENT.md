# PostgreSQL preview deployment checklist

This branch is intentionally not connected to the existing Render service or production database.

## Separate preview service

Create a **new** web service from branch `migration/postgres-preview`. Do not change the existing ATHAR service.

- Runtime: Node.js
- Build command: `npm install`
- Start command: `npm run start:postgres`
- Health check path: `/api/health`
- Node version: 22 or newer

## Environment variables

Set these in the preview host's secret/environment settings. Never commit values to Git.

Required:
- `NODE_ENV=production`
- `ATHAR_POSTGRES_AUTOSTART=true`
- `DATABASE_URL` — connection string for a **new, isolated preview database**
- `SESSION_SECRET` — random secret, at least 32 characters
- `OTP_SECRET` — independent random secret, at least 32 characters
- `FRONTEND_ORIGIN` — exact preview frontend origin, e.g. `https://<owner>.github.io`
- `DEMO_LOGIN_ENABLED=true` only for the isolated demo preview

Recommended:
- `COOKIE_SAMESITE=none` when frontend and API are on different sites and both use HTTPS.
- `PG_POOL_MAX=5`

Email variables are optional for demo-only preview. Do not configure SMTP unless official mail credentials and permission are available.

## Database initialization

Do not run migrations against any existing or production database. For a new isolated preview database only, obtain explicit approval, then run:

```sh
npm run db:migrate
```

The PostgreSQL session store creates its own `athar_sessions` table when first used.

## Frontend

Keep `config.js` disconnected until a separate preview API is deployed and approved. Then set `window.ATHAR_CONFIG.apiBase` to that preview API origin only, never the legacy Render URL.

## Acceptance checks

1. `GET /api/health` returns `ok: true` and `database: postgresql`.
2. Browser requests include credentials and API CORS allows only the exact frontend origin.
3. Demo login works only when explicitly enabled.
4. Refresh restores session; logout invalidates it.
5. Test all five roles and verify DEMO-SCHOOL isolation.
6. Confirm existing Render, `main`, SQLite files, and production Supabase remain untouched.

No deployment, migration, or DNS change is authorized by this checklist.

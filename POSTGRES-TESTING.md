# PostgreSQL test run for ATHAR AI

This branch is the isolated PostgreSQL migration test. It does not change `main`, the existing SQLite deployment, or its environment variables.

## Local test

Use Node.js 20 or newer and a disposable, empty PostgreSQL database.

1. Install packages:

   ```bash
   npm install
   ```

2. Set the database connection string in your shell (do not commit credentials):

   ```bash
   export DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/athar_test"
   export DEMO_LOGIN_ENABLED=true
   export NODE_ENV=test
   ```

3. Check JavaScript syntax:

   ```bash
   npm run check
   ```

4. Create and verify the PostgreSQL schema:

   ```bash
   npm run db:setup
   npm run db:verify
   ```

5. Run API tests, including demo login, JSONB record creation, learning analysis, record deletion, and session persistence across an API restart:

   ```bash
   npm run test:postgres
   ```

The smoke test creates and deletes its own uniquely named test learner and assessment in the test database. Run it only against a disposable test database.

## Staging deployment checklist

Do not point the existing production service at PostgreSQL yet. Create a separate PostgreSQL database and a separate staging web service from branch `postgres-migration-test`. Configure the staging service only:

- `DATABASE_URL`: the staging database's internal connection string.
- `SESSION_SECRET`: a random secret of at least 32 characters.
- `OTP_SECRET`: a different random secret of at least 32 characters.
- `NODE_ENV=production`.
- `DEMO_LOGIN_ENABLED=true` only while validating the isolated demo environment; set it to `false` after testing.
- `FRONTEND_ORIGIN`: the exact staging frontend origin.

Run `npm run db:setup` once against the staging database, then `npm run db:verify`. Start the API and verify `/api/health`, `/api/auth/mode`, demo role switching, school isolation, and persistent sessions. Do not add real school or student information to the demo database.

The former SQLite data is not copied by this migration. The current SQLite data was identified as test data, so the PostgreSQL test database starts with an empty schema and synthetic demo accounts are created on demand.

## Important

- `main` and the current Render deployment remain unchanged.
- Never commit `.env`, database URLs, SMTP credentials, or production secrets.
- Do not merge this branch until the staging checks pass and the application owner approves the result.

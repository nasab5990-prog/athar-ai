# ATHAR PostgreSQL Migration — Preview Branch

This document tracks the isolated migration branch. Production `main`, the current Render service, and existing SQLite data must remain untouched until preview acceptance is complete.

## Current verified state

- `server.js` on this branch was restored from the complete `main` version after an earlier incomplete edit. It currently has the original SQLite business-data and SQLite session implementation.
- `db/schema.sql`, `db/postgres.js`, `db/session-store.js`, and `migrate.js` exist as migration groundwork; they are not yet wired into the running server.
- `create-user.js` and `seed-user.js` use PostgreSQL. They are not compatible with the current SQLite-backed server until the server and data source are migrated together.
- `package.json` includes both SQLite and PostgreSQL dependencies during the transition.
- Demo login in the existing server is controlled by `DEMO_LOGIN_ENABLED=true`. Preserve the five demo roles and keep demo identities isolated in `DEMO-SCHOOL`; do not invent student records or scores.
- No SQLite backup was available when this migration began. Do not claim historical data has been recovered or migrated.

## Schema review

The PostgreSQL schema currently defines:

- `users`: role constraint, school scope, active flag, optional student ID, unique email.
- `otp_codes`: one active code per email, expiry, and attempt counter.
- `audit_log`: audit event and optional user ID.
- `records`: JSONB payload, school, owner, record kind, and timestamps.
- `account_students` and `teacher_students`: parent/student links and teacher assignments.

The existing application uses the same conceptual entities. Its SQLite record payloads are JSON text and PostgreSQL stores them as JSONB; route conversion must parse/serialize at the API boundary so clients continue receiving object-shaped `payload` values. SQLite's `json_extract(payload,'$.student_id')` predicates must become parameterized PostgreSQL JSONB predicates such as `payload->>'student_id' = $n`.

## Verified route/data access inventory

The existing `server.js` has these database-backed areas, all of which must be migrated consistently before PostgreSQL is used by the server:

1. Authentication: OTP request/verification, user lookup, demo-user creation/login, current-user response, logout.
2. Authorization helpers: active-user lookup, linked student IDs, teacher assignments, student existence and ownership.
3. Records: list, create, bulk create, delete, and related student-link cleanup.
4. User administration: list users, create users, update teacher assignments, update parent/student links.
5. Reports/analysis: assessment aggregation and saved learning-analysis records.
6. Audit logging and session persistence.

A mixed configuration is unsafe: PostgreSQL user IDs cannot be assumed to match SQLite user IDs, and PostgreSQL sessions do not make SQLite business records durable or consistent.

## Review findings / blockers

- [x] Restored the complete `server.js` in this branch from `main` (commit `7afbec8`); this avoids losing the existing API routes.
- [x] Reviewed the initial PostgreSQL schema against the application's main data concepts and route inventory.
- [ ] Convert all server database access as one coordinated migration, including startup initialization and every route listed above.
- [ ] Decide and implement a safe first-user/student onboarding sequence. The current PostgreSQL account scripts validate linked student records before creating linked accounts; therefore a student record must already exist in that school.
- [ ] Add tests for duplicate emails, invalid roles, missing linked students, school isolation, ownership, bulk atomicity, and deletion/link cleanup.
- [ ] Run dependency installation, syntax checks, and API integration tests against a separate disposable preview database.

## Migration rules

1. Use the Supabase Session Pooler URL only in the isolated preview environment; never commit credentials.
2. Use parameterized PostgreSQL queries and explicit transactions for multi-step writes.
3. Keep the existing `/api/*` route names, response keys, and Arabic messages compatible with the frontend.
4. Preserve role checks, school scoping, ownership checks, and parent/student links.
5. Keep demo login independent of SMTP. Do not create demo learner records or scores.
6. Do not drop SQLite code or files until the PostgreSQL preview passes acceptance and a verified backup/export exists.

## Preview acceptance checks

- Server starts against the isolated PostgreSQL database without relying on `DB_PATH`.
- Health and auth-mode endpoints retain their existing response shapes.
- Demo login works for all five roles and does not create learner fixtures.
- Individual and bulk record create/read/delete operations work.
- User administration, assignments, student links, reports, and analysis work for the intended roles.
- School isolation and ownership rules are verified with negative tests.
- Records persist across preview restarts; session behavior is verified.
- `npm run check` and targeted API integration tests pass.
- Only then consider a pull request to `main`.

## Deployment safety

Do not change Render environment variables, deploy this branch to the current production service, run a migration against the user's existing Supabase project, delete SQLite files, or merge into `main` as part of preparation. Historical data is not assumed to exist in the new PostgreSQL database.

## Records repository preview

- [x] Added `db/records.js` with parameterized PostgreSQL operations for role-scoped record listing, student-record lookup, single insert, atomic batch insert, and guarded student-record deletion.
- [ ] The repository is deliberately not imported by `server.js`. The server still authenticates users and reads/writes business data through SQLite; calling this repository from the current routes would mix independent user IDs and school data stores.
- [ ] Before wiring it in, migrate authentication/user identity and the authorization helpers in the same coordinated change. Then convert the records routes to await these repository functions and preserve the current API response shapes and Arabic validation messages.
- [ ] Add integration tests for role visibility, school isolation, teacher ownership, assigned learners, parent/student links, duplicate student IDs, atomic batch rollback, and linked-student deletion.

The repository returns PostgreSQL `BIGINT` IDs as strings in the standard `pg` driver. The API boundary must preserve this safely (do not coerce IDs to JavaScript numbers unless they are within the safe integer range). JSONB payloads are returned as objects by `pg`, so the old SQLite `JSON.parse(row.payload)` mapping must not be copied unchanged.


## Authentication and identity repository preview

- [x] Added `db/auth.js` with PostgreSQL helpers for active-user lookup, OTP persistence/attempt tracking, linked and assigned student IDs, audit writes, and isolated demo-user creation.
- [x] Demo identities are restricted to `DEMO-SCHOOL`; the helper creates no learner records, assessments, scores, or student links, and rejects conflicting existing demo accounts.
- [ ] These helpers are not wired into `server.js`. The live preview server remains SQLite-backed; do not mix these helpers into individual routes until the server's authentication, session identity, authorization helpers, and route handlers are migrated together.
- [ ] OTP expiry and attempt-limit checks, constant-time hash comparison, session regeneration, and generic email responses must remain enforced in the route layer when it is migrated.
- [ ] Add tests for inactive users, OTP expiry and five-attempt lockout, demo-account conflicts, school isolation, and audit writes before integration.
- [ ] Review the schema's `audit_log.user_id` relationship and retention policy before production use; audit rows currently do not declare a foreign key to users.


## Authorization and session readiness

- [x] Reviewed the current middleware: `requireAuth` reloads the active user from SQLite on every request; role checks are centralized in `requireRole`; school scoping and student ownership/assignment checks are separate helpers.
- [x] Added `db/authorization.js` with PostgreSQL equivalents for linked/assigned student lookup, school-scoped student existence, teacher ownership/assignment access, and role capability predicates.
- [x] Confirmed `db/session-store.js` already defines a PostgreSQL session store. It is not enabled in `server.js`.
- [x] Expanded `npm run check` to include the new PostgreSQL auth, authorization, and records modules.
- [ ] Do not enable the PostgreSQL session store independently: session IDs currently resolve to SQLite user IDs. Switch the session store and `requireAuth` user lookup together after PostgreSQL users are established.
- [ ] Preserve the exact current authorization semantics during route conversion, including principal-only user administration, teacher ownership/assignment checks, and school isolation. Capability helpers are preparatory and must not replace route-level checks until each route is mapped and tested.
- [ ] `npm run check` has not been run in this work session; no database migration or integration test was performed.

## Role policy and automated checks

- [x] Extracted pure role capability rules into `db/role-policy.js` so they can be tested without opening a database connection.
- [x] Updated `db/authorization.js` to re-export the shared role policy rather than maintaining a second copy.
- [x] Added `test/role-policy.test.js` covering all five roles, the demo-school user-management restriction, and missing-user inputs.
- [x] Added `npm test` using Node's built-in test runner and included the policy/test files in `npm run check`.
- [ ] Tests and syntax checks have not yet been executed in this session. These are isolated policy tests, not database or route integration tests.

## Disposable PostgreSQL CI test environment

- [x] Added a GitHub Actions workflow that provisions a fresh PostgreSQL 16 service container for pushes and pull requests targeting this preview branch only.
- [x] The workflow installs dependencies, runs syntax checks, applies the schema migration to that disposable service, then runs automated tests.
- [x] Added database integration coverage for user creation, school-scoped record queries, invalid-role constraints, JSONB object constraints, and PostgreSQL session-store initialization.
- [ ] The workflow has been committed but its run result has not yet been inspected. Do not treat tests as passing until the GitHub Actions run completes successfully.
- [ ] This workflow tests database schema/repository foundations only. API route tests and the coordinated PostgreSQL authentication/session/authorization conversion remain pending because `server.js` still runs on SQLite.
- [ ] The workflow is restricted to `migration/postgres-preview`; it does not target `main` and does not connect to Render or the user's Supabase project.

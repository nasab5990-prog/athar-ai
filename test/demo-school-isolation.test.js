import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('PostgreSQL repository refuses account provisioning in DEMO-SCHOOL', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to the disposable test database');
  const { pool } = await import('../db/postgres.js');
  const { createSchoolUser } = await import('../db/records.js');
  const email = `blocked-demo-${randomUUID()}@example.test`;
  try {
    const result = await createSchoolUser({
      email, name: 'Must Not Be Created', role: 'teacher',
      schoolId: 'DEMO-SCHOOL', studentIds: []
    });
    assert.deepEqual(result, { status: 'demo_school_forbidden' });
    const found = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    assert.equal(found.rowCount, 0);
  } finally {
    await pool.end();
  }
});

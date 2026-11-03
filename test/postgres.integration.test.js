import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 2 }) : null;

test('PostgreSQL test database is configured', () => {
  assert.ok(pool, 'DATABASE_URL must point to the disposable test database');
});

test('schema creates users, records and enforces school-scoped data access queries', async () => {
  const suffix = randomUUID();
  const schoolA = `TEST-A-${suffix}`;
  const schoolB = `TEST-B-${suffix}`;
  const email = `teacher-${suffix}@example.test`;
  const client = await pool.connect();
  let userId;
  try {
    const user = await client.query(
      `INSERT INTO users(email,name,role,school_id,active)
       VALUES($1,'Integration Teacher','teacher',$2,TRUE) RETURNING id`,
      [email, schoolA]
    );
    userId = user.rows[0].id;

    await client.query(
      `INSERT INTO records(school_id,owner_id,kind,payload)
       VALUES($1,$2,'student',$3::jsonb),($4,$2,'student',$5::jsonb)`,
      [schoolA, userId, JSON.stringify({ student_id: 'ST-1' }),
       schoolB, JSON.stringify({ student_id: 'ST-2' })]
    );

    const visible = await client.query(
      `SELECT payload->>'student_id' AS student_id FROM records
       WHERE school_id=$1 AND kind='student' ORDER BY id`,
      [schoolA]
    );
    assert.deepEqual(visible.rows.map(row => row.student_id), ['ST-1']);

    await assert.rejects(
      client.query(
        `INSERT INTO users(email,name,role,school_id)
         VALUES($1,'Invalid Role','superuser',$2)`,
        [`bad-${suffix}@example.test`, schoolA]
      ),
      error => error.code === '23514'
    );

    await assert.rejects(
      client.query(
        `INSERT INTO records(school_id,owner_id,kind,payload)
         VALUES($1,$2,'student','[]'::jsonb)`,
        [schoolA, userId]
      ),
      error => error.code === '23514'
    );
  } finally {
    if (userId) {
      await client.query('DELETE FROM records WHERE owner_id=$1', [userId]);
      await client.query('DELETE FROM users WHERE id=$1', [userId]);
    }
    client.release();
  }
});

test('PostgreSQL session store module can initialize against the test database', async () => {
  const { sessionStore } = await import('../db/session-store.js');
  await new Promise((resolve, reject) => {
    sessionStore.on('connect', resolve);
    sessionStore.on('error', reject);
    sessionStore.length((error) => error ? reject(error) : resolve());
  });
  await new Promise((resolve, reject) => sessionStore.close(error => error ? reject(error) : resolve()));
});

test.after(async () => {
  await pool?.end();
});

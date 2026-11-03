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

test('PostgreSQL session store persists, reads and deletes a session', async () => {
  const { sessionStore } = await import('../db/session-store.js');
  const sid = `integration-${randomUUID()}`;
  const sessionData = {
    cookie: { originalMaxAge: null, expires: null, secure: false, httpOnly: true, path: '/' },
    probe: 'postgres-session-store'
  };

  await new Promise((resolve, reject) => {
    sessionStore.set(sid, sessionData, error => error ? reject(error) : resolve());
  });

  try {
    const loaded = await new Promise((resolve, reject) => {
      sessionStore.get(sid, (error, value) => error ? reject(error) : resolve(value));
    });
    assert.equal(loaded?.probe, sessionData.probe);
  } finally {
    await new Promise((resolve, reject) => {
      sessionStore.destroy(sid, error => error ? reject(error) : resolve());
    });
  }
});

test('PostgreSQL repositories preserve demo identities without creating fake student data', async () => {
  const { ensureDemoUsers, findActiveUserByEmail } = await import('../db/auth.js');
  const { listRecordsForUser } = await import('../db/records.js');
  const users = await ensureDemoUsers();
  assert.deepEqual(
    Object.keys(users).sort(),
    ['parent', 'principal', 'senior_teacher', 'student', 'teacher'].sort()
  );

  for (const role of Object.keys(users)) {
    const user = users[role];
    assert.equal(user.role, role);
    assert.equal(user.school_id, 'DEMO-SCHOOL');
    assert.equal(user.active, true);
    const found = await findActiveUserByEmail(user.email);
    assert.equal(String(found.id), String(user.id));
    assert.deepEqual(await listRecordsForUser(user), []);
  }

  const repeated = await ensureDemoUsers();
  for (const role of Object.keys(users)) {
    assert.equal(String(repeated[role].id), String(users[role].id));
  }
});

test('PostgreSQL record batch writes are atomic and return JSONB as objects', async () => {
  const { insertRecordsBatch, listRecordsForUser } = await import('../db/records.js');
  const { ensureDemoUsers } = await import('../db/auth.js');
  const { teacher } = await ensureDemoUsers();
  const marker = randomUUID();

  const created = await insertRecordsBatch({
    schoolId: teacher.school_id,
    ownerId: teacher.id,
    records: [
      { kind: 'assessment', payload: { student_id: marker, score: 7 } },
      { kind: 'student', payload: { student_id: marker, name: 'Integration-only learner' } }
    ]
  });

  try {
    assert.equal(created.length, 2);
    const rows = await listRecordsForUser(teacher);
    const inserted = rows.filter(row => row.payload?.student_id === marker);
    assert.equal(inserted.length, 2);
    assert.ok(inserted.every(row => typeof row.payload === 'object' && !Array.isArray(row.payload)));
  } finally {
    await pool.query(
      "DELETE FROM records WHERE school_id = $1 AND payload->>'student_id' = $2",
      [teacher.school_id, marker]
    );
  }
});

test.after(async () => {
  await pool?.end();
});


test('PostgreSQL school-user and assignment repositories keep links school-scoped', async () => {
  const { createSchoolUser, listSchoolUsers, replaceTeacherAssignments, replaceAccountStudentLinks } =
    await import('../db/records.js');
  const suffix = randomUUID();
  const schoolId = `REPO-TEST-${suffix}`;
  const teacherEmail = `teacher-${suffix}@example.test`;
  const parentEmail = `parent-${suffix}@example.test`;
  let teacherId;
  let parentId;
  try {
    const teacher = await createSchoolUser({
      email: teacherEmail, name: 'Repository Teacher', role: 'teacher',
      schoolId, studentIds: []
    });
    assert.equal(teacher.status, 'created');
    teacherId = teacher.user.id;

    const student = await pool.query(
      `INSERT INTO records(school_id, owner_id, kind, payload)
       VALUES($1, $2, 'student', $3::jsonb) RETURNING id`,
      [schoolId, teacherId, JSON.stringify({ student_id: suffix, name: 'Test Learner' })]
    );
    assert.ok(student.rows[0].id);

    const parent = await createSchoolUser({
      email: parentEmail, name: 'Repository Parent', role: 'parent',
      schoolId, studentIds: [suffix]
    });
    assert.equal(parent.status, 'created');
    parentId = parent.user.id;
    assert.deepEqual(parent.user.linkedStudentIds, [suffix]);

    const listed = await listSchoolUsers(schoolId);
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.find(user => String(user.id) === String(parentId)).linkedStudentIds, [suffix]);

    const assigned = await replaceTeacherAssignments({
      userId: teacherId, schoolId, studentIds: [suffix]
    });
    assert.equal(assigned.status, 'updated');

    const links = await replaceAccountStudentLinks({
      userId: parentId, schoolId, role: 'parent', studentIds: [suffix]
    });
    assert.equal(links.status, 'updated');

    const { listAssessmentsForAnalysis } = await import('../db/records.js');
    assert.deepEqual(await listAssessmentsForAnalysis({ id: teacherId, role: 'teacher', school_id: schoolId }), []);
  } finally {
    await pool.query('DELETE FROM records WHERE school_id = $1', [schoolId]);
    await pool.query('DELETE FROM users WHERE school_id = $1', [schoolId]);
  }
});


test('PostgreSQL OTP repository creates, increments and deletes a one-time code', async () => {
  const {
    saveOtp, findOtp, incrementOtpAttempts, deleteOtp
  } = await import('../db/auth.js');
  const email = `otp-${randomUUID()}@example.test`;
  const now = Date.now();
  try {
    await saveOtp({
      email,
      codeHash: 'a'.repeat(64),
      expiresAt: now + 10 * 60 * 1000,
      createdAt: now
    });
    let otp = await findOtp(email);
    assert.equal(otp.email, email);
    assert.equal(otp.code_hash, 'a'.repeat(64));
    assert.equal(Number(otp.attempts), 0);
    assert.equal(Number(otp.expires_at), now + 10 * 60 * 1000);

    assert.equal(await incrementOtpAttempts(email), true);
    otp = await findOtp(email);
    assert.equal(Number(otp.attempts), 1);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(await incrementOtpAttempts(email), true);
    }
    assert.equal(await incrementOtpAttempts(email), false);
    otp = await findOtp(email);
    assert.equal(Number(otp.attempts), 5);

    await saveOtp({
      email,
      codeHash: 'b'.repeat(64),
      expiresAt: now + 20 * 60 * 1000,
      createdAt: now + 1
    });
    otp = await findOtp(email);
    assert.equal(otp.code_hash, 'b'.repeat(64));
    assert.equal(Number(otp.attempts), 0);
  } finally {
    await deleteOtp(email);
  }
  assert.equal(await findOtp(email), null);
});

test('PostgreSQL OTP verification claims attempts atomically and rejects expired codes', async () => {
  const { saveOtp, claimOtpAttempt, deleteOtp } = await import('../db/auth.js');
  const email = `claim-otp-${randomUUID()}@example.test`;
  const now = Date.now();
  try {
    await saveOtp({ email, codeHash: 'c'.repeat(64), expiresAt: now + 60_000, createdAt: now });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await claimOtpAttempt(email, now);
      assert.equal(Number(claimed?.attempts), attempt);
    }
    assert.equal(await claimOtpAttempt(email, now), null);
    await saveOtp({ email, codeHash: 'd'.repeat(64), expiresAt: now - 1, createdAt: now });
    assert.equal(await claimOtpAttempt(email, now), null);
  } finally {
    await deleteOtp(email);
  }
});


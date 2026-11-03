import { pool, withTransaction } from './postgres.js';

const USER_FIELDS = 'id, email, name, role, school_id, student_id, active';

export async function findActiveUserById(id) {
  const { rows } = await pool.query(
    `SELECT ${USER_FIELDS} FROM users WHERE id = $1 AND active = TRUE`,
    [id]
  );
  return rows[0] || null;
}

export async function findActiveUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT ${USER_FIELDS} FROM users WHERE email = $1 AND active = TRUE`,
    [email]
  );
  return rows[0] || null;
}

export async function findUserByEmail(email) {
  const { rows } = await pool.query(
    `SELECT ${USER_FIELDS} FROM users WHERE email = $1`,
    [email]
  );
  return rows[0] || null;
}

export async function saveOtp({ email, codeHash, expiresAt, createdAt }) {
  await pool.query(
    `INSERT INTO otp_codes(email, code_hash, expires_at, attempts, created_at)
     VALUES($1, $2, $3, 0, $4)
     ON CONFLICT(email) DO UPDATE SET
       code_hash = EXCLUDED.code_hash,
       expires_at = EXCLUDED.expires_at,
       attempts = 0,
       created_at = EXCLUDED.created_at`,
    [email, codeHash, expiresAt, createdAt]
  );
}

export async function findOtp(email) {
  const { rows } = await pool.query(
    'SELECT email, code_hash, expires_at, attempts, created_at FROM otp_codes WHERE email = $1',
    [email]
  );
  return rows[0] || null;
}

/** Atomically claims one verification attempt only while the code is valid. */
export async function claimOtpAttempt(email, now = Date.now()) {
  const { rows } = await pool.query(
    `UPDATE otp_codes
     SET attempts = attempts + 1
     WHERE email = $1
       AND attempts < 5
       AND expires_at > $2
     RETURNING email, code_hash, expires_at, attempts, created_at`,
    [email, now]
  );
  return rows[0] || null;
}

export async function incrementOtpAttempts(email) {
  const result = await pool.query(
    `UPDATE otp_codes
     SET attempts = attempts + 1
     WHERE email = $1
       AND attempts < 5
       AND expires_at > $2`,
    [email, Date.now()]
  );
  return result.rowCount === 1;
}

export async function deleteOtp(email) {
  await pool.query('DELETE FROM otp_codes WHERE email = $1', [email]);
}

export async function listLinkedStudentIds(userId, schoolId) {
  const { rows } = await pool.query(
    'SELECT student_id FROM account_students WHERE user_id = $1 AND school_id = $2 ORDER BY student_id',
    [userId, schoolId]
  );
  return rows.map(row => row.student_id);
}

export async function listAssignedStudentIds(userId, schoolId) {
  const { rows } = await pool.query(
    'SELECT student_id FROM teacher_students WHERE user_id = $1 AND school_id = $2 ORDER BY student_id',
    [userId, schoolId]
  );
  return rows.map(row => row.student_id);
}

export async function writeAudit(userId, event, details = '') {
  await pool.query(
    'INSERT INTO audit_log(user_id, event, details) VALUES($1, $2, $3)',
    [userId || null, event, String(details ?? '').trim().slice(0, 500)]
  );
}

/**
 * Creates the isolated demo identities without creating learner records,
 * assessments, scores, or student links. Existing conflicting demo accounts
 * cause a hard failure rather than being silently repurposed.
 */
export async function ensureDemoUsers() {
  const demoUsers = [
    ['demo.teacher@athar.test', 'معلّم تجريبي', 'teacher'],
    ['demo.senior@athar.test', 'معلم أول تجريبي', 'senior_teacher'],
    ['demo.principal@athar.test', 'مدير تجريبي', 'principal'],
    ['demo.parent@athar.test', 'ولي أمر تجريبي', 'parent'],
    ['demo.student@athar.test', 'طالب تجريبي', 'student']
  ];

  return withTransaction(async client => {
    const users = {};
    for (const [email, name, role] of demoUsers) {
      const inserted = await client.query(
        `INSERT INTO users(email, name, role, school_id, student_id, active)
         VALUES($1, $2, $3, 'DEMO-SCHOOL', NULL, TRUE)
         ON CONFLICT(email) DO NOTHING
         RETURNING ${USER_FIELDS}`,
        [email, name, role]
      );
      let user = inserted.rows[0];
      if (!user) {
        const existing = await client.query(
          `SELECT ${USER_FIELDS} FROM users WHERE email = $1 FOR UPDATE`,
          [email]
        );
        user = existing.rows[0];
      }
      if (!user || !user.active || user.school_id !== 'DEMO-SCHOOL' || user.role !== role) {
        throw new Error('Demo account configuration conflict.');
      }
      users[role] = user;
    }
    return users;
  });
}

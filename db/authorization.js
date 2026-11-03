import { pool } from './postgres.js';
export { canManageSchoolUsers, canCreateEducationalRecords, canRunLearningAnalysis } from './role-policy.js';

export async function listLinkedStudentIds(user) {
  const { rows } = await pool.query(
    'SELECT student_id FROM account_students WHERE user_id = $1 AND school_id = $2 ORDER BY student_id',
    [user.id, user.school_id]
  );
  return rows.map(row => row.student_id);
}

export async function listAssignedStudentIds(user) {
  const { rows } = await pool.query(
    'SELECT student_id FROM teacher_students WHERE user_id = $1 AND school_id = $2 ORDER BY student_id',
    [user.id, user.school_id]
  );
  return rows.map(row => row.student_id);
}

export async function studentExistsInSchool(studentId, schoolId, client = pool) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM records
     WHERE school_id = $1 AND kind = 'student'
       AND payload->>'student_id' = $2
     LIMIT 1`,
    [schoolId, studentId]
  );
  return rowCount > 0;
}

/**
 * Returns the student record only when the requesting role is allowed to
 * access it. School scope is always applied before ownership/assignment checks.
 */
export async function findStudentAccessibleTo(user, studentId) {
  const { rows } = await pool.query(
    `SELECT id, owner_id FROM records
     WHERE school_id = $1 AND kind = 'student'
       AND payload->>'student_id' = $2
     ORDER BY id LIMIT 1`,
    [user.school_id, studentId]
  );
  const record = rows[0];
  if (!record) return null;

  if (user.role === 'principal' || user.role === 'senior_teacher') return record;
  if (user.role === 'teacher') {
    if (String(record.owner_id) === String(user.id)) return record;
    const assigned = await pool.query(
      'SELECT 1 FROM teacher_students WHERE user_id = $1 AND school_id = $2 AND student_id = $3 LIMIT 1',
      [user.id, user.school_id, studentId]
    );
    return assigned.rowCount ? record : null;
  }
  return null;
}


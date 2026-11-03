import { pool, withTransaction } from './postgres.js';

const RECORD_COLUMNS = 'id, kind, payload, created_at';

/**
 * PostgreSQL record repository for the preview migration.
 * Authorization decisions stay in server.js; callers must validate the user,
 * school, ownership, and student links before invoking write operations.
 * This module is intentionally not wired into the SQLite-backed server yet.
 */
export async function listRecordsForUser(user) {
  if (user.role === 'principal' || user.role === 'senior_teacher') {
    const { rows } = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM records
       WHERE school_id = $1 ORDER BY id DESC LIMIT 1000`,
      [user.school_id]
    );
    return rows;
  }

  if (user.role === 'teacher') {
    const { rows: assignments } = await pool.query(
      'SELECT student_id FROM teacher_students WHERE user_id = $1 AND school_id = $2',
      [user.id, user.school_id]
    );
    const assignedIds = assignments.map(row => row.student_id);
    const { rows } = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM records
       WHERE school_id = $1
         AND (
           owner_id = $2
           OR kind IN ('shared_assessment', 'shared_intervention')
           OR (payload->>'student_id') = ANY($3::text[])
         )
       ORDER BY id DESC LIMIT 800`,
      [user.school_id, user.id, assignedIds]
    );
    return rows;
  }

  if (user.role === 'parent' || user.role === 'student') {
    const { rows: links } = await pool.query(
      'SELECT student_id FROM account_students WHERE user_id = $1 AND school_id = $2',
      [user.id, user.school_id]
    );
    const linkedIds = links.map(row => row.student_id);
    if (!linkedIds.length) return [];
    const { rows } = await pool.query(
      `SELECT ${RECORD_COLUMNS} FROM records
       WHERE school_id = $1
         AND kind IN ('student', 'assessment', 'intervention', 'impact')
         AND (payload->>'student_id') = ANY($2::text[])
       ORDER BY id DESC LIMIT 500`,
      [user.school_id, linkedIds]
    );
    return rows;
  }

  return [];
}

export async function findStudentRecord(schoolId, studentId) {
  const { rows } = await pool.query(
    `SELECT id, owner_id FROM records
     WHERE school_id = $1 AND kind = 'student'
       AND payload->>'student_id' = $2
     ORDER BY id LIMIT 1`,
    [schoolId, studentId]
  );
  return rows[0] || null;
}

export async function insertRecord({ schoolId, ownerId, kind, payload }) {
  const { rows } = await pool.query(
    `INSERT INTO records (school_id, owner_id, kind, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, kind, payload, created_at`,
    [schoolId, ownerId, kind, JSON.stringify(payload)]
  );
  return rows[0];
}

/** Inserts a validated batch atomically. Student records are inserted first. */
export async function insertRecordsBatch({ schoolId, ownerId, records }) {
  return withTransaction(async client => {
    const ordered = [
      ...records.filter(item => item.kind === 'student'),
      ...records.filter(item => item.kind !== 'student')
    ];
    const created = [];
    for (const item of ordered) {
      const { rows } = await client.query(
        `INSERT INTO records (school_id, owner_id, kind, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, kind`,
        [schoolId, ownerId, item.kind, JSON.stringify(item.payload)]
      );
      created.push(rows[0]);
    }
    return created;
  });
}

/**
 * Deletes a record within its school. Student deletion also removes related
 * student records and teacher assignments, but refuses while account links exist.
 * The caller must enforce role/ownership before calling this function.
 */
export async function deleteRecord({ id, schoolId, requesterId, requesterRole }) {
  return withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, owner_id, kind, payload FROM records
       WHERE id = $1 AND school_id = $2 FOR UPDATE`,
      [id, schoolId]
    );
    const record = rows[0];
    if (!record) return { status: 'not_found' };

    const isSchoolManager = requesterRole === 'principal' || requesterRole === 'senior_teacher';
    if (!isSchoolManager && String(record.owner_id) !== String(requesterId)) {
      return { status: 'forbidden' };
    }

    if (record.kind === 'student') {
      const studentId = record.payload?.student_id;
      const { rows: links } = await client.query(
        'SELECT COUNT(*)::int AS count FROM account_students WHERE school_id = $1 AND student_id = $2',
        [schoolId, studentId]
      );
      if (links[0].count > 0) return { status: 'linked' };

      await client.query(
        "DELETE FROM records WHERE school_id = $1 AND payload->>'student_id' = $2",
        [schoolId, studentId]
      );
      await client.query(
        'DELETE FROM teacher_students WHERE school_id = $1 AND student_id = $2',
        [schoolId, studentId]
      );
      return { status: 'deleted', kind: record.kind, ownerId: record.owner_id };
    }

    await client.query('DELETE FROM records WHERE id = $1 AND school_id = $2', [id, schoolId]);
    return { status: 'deleted', kind: record.kind, ownerId: record.owner_id };
  });
}


/** Lists school users and their linked/assigned student IDs for the principal UI. */
export async function listSchoolUsers(schoolId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.school_id, u.active, u.created_at,
       COALESCE((SELECT jsonb_agg(a.student_id ORDER BY a.student_id)
         FROM account_students a WHERE a.user_id = u.id AND a.school_id = u.school_id), '[]'::jsonb) AS "linkedStudentIds",
       COALESCE((SELECT jsonb_agg(t.student_id ORDER BY t.student_id)
         FROM teacher_students t WHERE t.user_id = u.id AND t.school_id = u.school_id), '[]'::jsonb) AS "assignedStudentIds"
     FROM users u WHERE u.school_id = $1 ORDER BY u.name`,
    [schoolId]
  );
  return rows;
}

/** Creates a school account and its student/teacher links atomically. */
export async function createSchoolUser({ email, name, role, schoolId, studentIds = [] }) {
  if (schoolId === 'DEMO-SCHOOL') return { status: 'demo_school_forbidden' };
  const allowedRoles = ['teacher', 'senior_teacher', 'principal', 'parent', 'student'];
  if (!allowedRoles.includes(role) || !email || !name || !schoolId) return { status: 'invalid_user' };
  if ((role === 'student' && studentIds.length !== 1) ||
      (role === 'parent' && studentIds.length < 1) ||
      (['principal', 'senior_teacher'].includes(role) && studentIds.length > 0) ||
      (role !== 'teacher' && !['parent', 'student'].includes(role) && studentIds.length > 0)) {
    return { status: 'invalid_links' };
  }
  return withTransaction(async client => {
    for (const studentId of studentIds) {
      const { rowCount } = await client.query(
        `SELECT 1 FROM records WHERE school_id = $1 AND kind = 'student'
         AND payload->>'student_id' = $2 LIMIT 1`,
        [schoolId, studentId]
      );
      if (!rowCount) return { status: 'student_not_found' };
    }
    const inserted = await client.query(
      `INSERT INTO users(email, name, role, school_id, student_id)
       VALUES($1, $2, $3, $4, $5) RETURNING id, email, name, role, school_id, active`,
      [email, name, role, schoolId, role === 'student' ? (studentIds[0] || null) : null]
    );
    const user = inserted.rows[0];
    for (const studentId of studentIds) {
      if (role === 'parent' || role === 'student') {
        await client.query(
          'INSERT INTO account_students(user_id, student_id, school_id) VALUES($1, $2, $3)',
          [user.id, studentId, schoolId]
        );
      } else if (role === 'teacher') {
        await client.query(
          'INSERT INTO teacher_students(user_id, student_id, school_id) VALUES($1, $2, $3)',
          [user.id, studentId, schoolId]
        );
      }
    }
    return {
      status: 'created',
      user: {
        ...user,
        linkedStudentIds: ['parent', 'student'].includes(role) ? studentIds : [],
        assignedStudentIds: role === 'teacher' ? studentIds : []
      }
    };
  });
}

/** Replaces a teacher's student assignments atomically after validating school membership. */
export async function replaceTeacherAssignments({ userId, schoolId, studentIds }) {
  return withTransaction(async client => {
    const target = await client.query(
      `SELECT id FROM users WHERE id = $1 AND school_id = $2 AND role = 'teacher' FOR UPDATE`,
      [userId, schoolId]
    );
    if (!target.rowCount) return { status: 'not_found' };
    for (const studentId of studentIds) {
      const student = await client.query(
        `SELECT 1 FROM records WHERE school_id = $1 AND kind = 'student'
         AND payload->>'student_id' = $2 LIMIT 1`,
        [schoolId, studentId]
      );
      if (!student.rowCount) return { status: 'student_not_found' };
    }
    await client.query('DELETE FROM teacher_students WHERE user_id = $1 AND school_id = $2', [userId, schoolId]);
    for (const studentId of studentIds) {
      await client.query(
        'INSERT INTO teacher_students(user_id, student_id, school_id) VALUES($1, $2, $3)',
        [userId, studentId, schoolId]
      );
    }
    return { status: 'updated' };
  });
}

/** Replaces parent/student links atomically; student accounts require exactly one link. */
export async function replaceAccountStudentLinks({ userId, schoolId, role, studentIds }) {
  return withTransaction(async client => {
    const target = await client.query(
      `SELECT id, role FROM users WHERE id = $1 AND school_id = $2 AND role = ANY($3::text[]) FOR UPDATE`,
      [userId, schoolId, ['parent', 'student']]
    );
    if (!target.rowCount || target.rows[0].role !== role) return { status: 'not_found' };
    if ((role === 'student' && studentIds.length !== 1) || (role === 'parent' && studentIds.length < 1)) {
      return { status: 'invalid_links' };
    }
    for (const studentId of studentIds) {
      const student = await client.query(
        `SELECT 1 FROM records WHERE school_id = $1 AND kind = 'student'
         AND payload->>'student_id' = $2 LIMIT 1`,
        [schoolId, studentId]
      );
      if (!student.rowCount) return { status: 'student_not_found' };
    }
    await client.query('DELETE FROM account_students WHERE user_id = $1 AND school_id = $2', [userId, schoolId]);
    for (const studentId of studentIds) {
      await client.query(
        'INSERT INTO account_students(user_id, student_id, school_id) VALUES($1, $2, $3)',
        [userId, studentId, schoolId]
      );
    }
    await client.query(
      'UPDATE users SET student_id = $1 WHERE id = $2 AND school_id = $3',
      [role === 'student' ? studentIds[0] : null, userId, schoolId]
    );
    return { status: 'updated' };
  });
}

/** Loads assessment history visible to an instructional user for the analysis service. */
export async function listAssessmentsForAnalysis(user) {
  if (user.role === 'principal' || user.role === 'senior_teacher') {
    const { rows } = await pool.query(
      `SELECT payload FROM records WHERE school_id = $1 AND kind = 'assessment'
       ORDER BY id DESC LIMIT 1000`,
      [user.school_id]
    );
    return rows.map(row => row.payload);
  }
  if (user.role !== 'teacher') return [];
  const { rows: assignments } = await pool.query(
    'SELECT student_id FROM teacher_students WHERE user_id = $1 AND school_id = $2',
    [user.id, user.school_id]
  );
  const assignedIds = assignments.map(row => row.student_id);
  const { rows } = await pool.query(
    `SELECT payload FROM records WHERE school_id = $1 AND kind = 'assessment'
     AND (owner_id = $2 OR payload->>'student_id' = ANY($3::text[]))
     ORDER BY id DESC LIMIT 800`,
    [user.school_id, user.id, assignedIds]
  );
  return rows.map(row => row.payload);
}

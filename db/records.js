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
export async function deleteRecord({ id, schoolId }) {
  return withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, owner_id, kind, payload FROM records
       WHERE id = $1 AND school_id = $2 FOR UPDATE`,
      [id, schoolId]
    );
    const record = rows[0];
    if (!record) return { status: 'not_found' };

    if (record.kind === 'student') {
      const studentId = record.payload?.student_id;
      const { rows: links } = await client.query(
        'SELECT COUNT(*)::int AS count FROM account_students WHERE school_id = $1 AND student_id = $2',
        [schoolId, studentId]
      );
      if (links[0].count > 0) return { status: 'linked' };

      await client.query(
        'DELETE FROM records WHERE school_id = $1 AND payload->>\'student_id\' = $2',
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

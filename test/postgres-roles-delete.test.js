import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('PostgreSQL role visibility and student deletion safeguards stay school-scoped', async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must point to the disposable test database');
  const { pool } = await import('../db/postgres.js');
  const { listRecordsForUser, deleteRecord } = await import('../db/records.js');
  const suffix = randomUUID();
  const schoolId = `ROLE-DELETE-${suffix}`;
  const otherSchool = `ROLE-DELETE-OTHER-${suffix}`;
  const studentId = `LEARNER-${suffix}`;
  const linkedStudentId = `LINKED-${suffix}`;
  const users = {};
  const recordIds = {};
  try {
    for (const role of ['teacher','senior_teacher','principal','parent','student']) {
      const result = await pool.query(
        `INSERT INTO users(email,name,role,school_id) VALUES($1,$2,$3,$4) RETURNING id`,
        [`${role}-${suffix}@example.test`, role, role, schoolId]
      );
      users[role] = result.rows[0].id;
    }
    const inserted = await pool.query(
      `INSERT INTO records(school_id,owner_id,kind,payload)
       VALUES($1,$2,'student',$3::jsonb),($1,$4,'assessment',$5::jsonb),
             ($1,$6,'student',$7::jsonb),($2,$6,'student',$8::jsonb)
       RETURNING id,kind,payload,school_id`,
      [schoolId,users.teacher,JSON.stringify({student_id:studentId,name:'Test Learner'}),
       users.teacher,JSON.stringify({student_id:studentId,pct:64}),
       users.teacher,JSON.stringify({student_id:linkedStudentId,name:'Linked Learner'}),
       JSON.stringify({student_id:`FOREIGN-${suffix}`})]
    );
    for (const row of inserted.rows) {
      if (row.payload.student_id === studentId && row.kind === 'student') recordIds.mainStudent = row.id;
      if (row.payload.student_id === studentId && row.kind === 'assessment') recordIds.assessment = row.id;
      if (row.payload.student_id === linkedStudentId) recordIds.linkedStudent = row.id;
    }
    await pool.query(
      'INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3),($4,$2,$3)',
      [users.parent,studentId,schoolId,users.student]
    );
    await pool.query(
      'INSERT INTO teacher_students(user_id,student_id,school_id) VALUES($1,$2,$3)',
      [users.teacher,studentId,schoolId]
    );

    const parentRows = await listRecordsForUser({id:users.parent,role:'parent',school_id:schoolId});
    const studentRows = await listRecordsForUser({id:users.student,role:'student',school_id:schoolId});
    assert.deepEqual(parentRows.map(row=>row.payload.student_id).sort(),[studentId,studentId].sort());
    assert.deepEqual(studentRows.map(row=>row.payload.student_id).sort(),[studentId,studentId].sort());

    const teacherRows = await listRecordsForUser({id:users.teacher,role:'teacher',school_id:schoolId});
    assert.ok(teacherRows.some(row=>row.payload.student_id===studentId));
    const seniorRows = await listRecordsForUser({id:users.senior_teacher,role:'senior_teacher',school_id:schoolId});
    const principalRows = await listRecordsForUser({id:users.principal,role:'principal',school_id:schoolId});
    assert.equal(seniorRows.length,3);
    assert.equal(principalRows.length,3);
    assert.ok([...seniorRows,...principalRows].every(row=>row.school_id===undefined));

    const forbidden = await deleteRecord({
      id:recordIds.mainStudent,schoolId,requesterId:users.teacher,requesterRole:'teacher'
    });
    assert.deepEqual(forbidden,{status:'forbidden'});

    const linked = await deleteRecord({
      id:recordIds.mainStudent,schoolId,requesterId:users.principal,requesterRole:'principal'
    });
    assert.deepEqual(linked,{status:'linked'});

    await pool.query('DELETE FROM account_students WHERE school_id=$1 AND student_id=$2',[schoolId,studentId]);
    const deleted = await deleteRecord({
      id:recordIds.mainStudent,schoolId,requesterId:users.senior_teacher,requesterRole:'senior_teacher'
    });
    assert.equal(deleted.status,'deleted');
    const remaining = await pool.query(
      `SELECT id FROM records WHERE school_id=$1 AND payload->>'student_id'=$2`,
      [schoolId,studentId]
    );
    assert.equal(remaining.rowCount,0);
    const assignments = await pool.query(
      'SELECT 1 FROM teacher_students WHERE school_id=$1 AND student_id=$2',
      [schoolId,studentId]
    );
    assert.equal(assignments.rowCount,0);
    const unrelated = await pool.query(
      'SELECT 1 FROM records WHERE school_id=$1 AND id=$2',
      [schoolId,recordIds.linkedStudent]
    );
    assert.equal(unrelated.rowCount,1);
  } finally {
    await pool.query('DELETE FROM account_students WHERE school_id = ANY($1::text[])',[[schoolId,otherSchool]]);
    await pool.query('DELETE FROM teacher_students WHERE school_id = ANY($1::text[])',[[schoolId,otherSchool]]);
    await pool.query('DELETE FROM records WHERE school_id = ANY($1::text[])',[[schoolId,otherSchool]]);
    await pool.query('DELETE FROM users WHERE school_id = ANY($1::text[])',[[schoolId,otherSchool]]);
  }
});

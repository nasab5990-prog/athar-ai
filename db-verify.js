import 'dotenv/config';
import { pool } from './database.js';

const expected = {
  users: ['id','email','name','role','school_id','student_id','active','created_at'],
  otp_codes: ['email','code_hash','expires_at','attempts','created_at'],
  audit_log: ['id','user_id','event','details','created_at'],
  records: ['id','school_id','owner_id','kind','payload','created_at'],
  account_students: ['user_id','student_id','school_id'],
  teacher_students: ['user_id','student_id','school_id']
};

async function main() {
  const problems = [];
  for (const [table, columns] of Object.entries(expected)) {
    const result = await pool.query(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',
      [table]
    );
    const actual = new Map(result.rows.map(row => [row.column_name, row.data_type]));
    const missing = columns.filter(column => !actual.has(column));
    if (missing.length) problems.push(`${table}: missing columns ${missing.join(', ')}`);
    if (table === 'records' && actual.get('payload') !== 'jsonb') {
      problems.push('records.payload must be JSONB');
    }
    if (table === 'users' && actual.get('active') !== 'boolean') {
      problems.push('users.active must be BOOLEAN');
    }
  }

  const indexes = await pool.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema()"
  );
  const indexNames = new Set(indexes.rows.map(row => row.indexname));
  for (const name of ['idx_records_school_kind','idx_records_owner','idx_records_student_id','idx_account_students_student','idx_teacher_students_student']) {
    if (!indexNames.has(name)) problems.push(`missing index ${name}`);
  }

  if (problems.length) {
    console.error('PostgreSQL schema verification FAILED:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('PostgreSQL schema verification PASSED: all ATHAR tables, required columns, JSONB type, BOOLEAN type and indexes are present.');
  }
}

main()
  .catch(error => { console.error('Database verification failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());

import 'dotenv/config';
import { pool, withTransaction } from './database.js';

const [emailArg, nameArg, roleArg, schoolArg, ...studentArgs] = process.argv.slice(2);
const email = (emailArg || '').trim().toLowerCase();
const name = (nameArg || '').trim();
const role = roleArg || '';
const school = (schoolArg || '').trim();
const studentIds = studentArgs.join(',').split(',').map(s => s.trim()).filter(Boolean);
const roles = ['teacher', 'senior_teacher', 'principal', 'parent', 'student'];

async function main() {
  if (!email || !name || !school || !roles.includes(role) || school.toUpperCase() === 'DEMO-SCHOOL') {
    throw new Error('Usage: npm run create-user -- user@moe.om "Name" teacher SCHOOL_ID (must not be DEMO-SCHOOL)');
  }
  if (!['moe.om', 'edu.moe.om'].includes(email.split('@')[1])) {
    throw new Error('Only @moe.om and @edu.moe.om email domains are allowed.');
  }
  if ((role === 'parent' && !studentIds.length) || (role === 'student' && studentIds.length !== 1) || (['principal','senior_teacher'].includes(role) && studentIds.length)) {
    throw new Error('Parent requires linked students; student requires exactly one; principal and senior_teacher do not take student assignments.');
  }

  for (const studentId of studentIds) {
    const found = await pool.query(
      "SELECT 1 FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",
      [school, studentId]
    );
    if (!found.rowCount) throw new Error(`Student ${studentId} was not found in school ${school}.`);
  }

  await withTransaction(async client => {
    const inserted = await client.query(
      'INSERT INTO users(email,name,role,school_id,student_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [email, name, role, school, role === 'student' ? studentIds[0] : null]
    );
    const userId = inserted.rows[0].id;
    for (const studentId of studentIds) {
      if (role === 'parent' || role === 'student') {
        await client.query(
          'INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3)',
          [userId, studentId, school]
        );
      }
      if (role === 'teacher') {
        await client.query(
          'INSERT INTO teacher_students(user_id,student_id,school_id) VALUES($1,$2,$3)',
          [userId, studentId, school]
        );
      }
    }
    console.log(`Created ${role} account for ${email} in school ${school}.`);
  });
}

main()
  .catch(error => { console.error('Could not create account:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());

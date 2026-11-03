import 'dotenv/config';
import { pool, withTransaction } from './db/postgres.js';

const [emailArg, nameArg, roleArg, schoolArg, ...studentArgs] = process.argv.slice(2);
const email = (emailArg || '').trim().toLowerCase();
const name = (nameArg || '').trim();
const role = roleArg || '';
const school = (schoolArg || '').trim();
const studentIds = studentArgs.join(',').split(',').map(s => s.trim()).filter(Boolean);
const roles = ['teacher', 'senior_teacher', 'principal', 'parent', 'student'];

try {
  if (!email || !name || !school || !roles.includes(role) || school.toUpperCase() === 'DEMO-SCHOOL') {
    throw new Error('Usage: npm run create-user -- user@moe.om "Name" teacher SCHOOL_ID (must not be DEMO-SCHOOL)');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['moe.om', 'edu.moe.om'].includes(email.split('@')[1])) {
    throw new Error('Only @moe.om and @edu.moe.om email domains are allowed.');
  }
  if ((role === 'parent' && !studentIds.length) || (role === 'student' && studentIds.length !== 1) || (['principal','senior_teacher'].includes(role) && studentIds.length)) {
    throw new Error('Parent requires linked students; student requires exactly one; principal and senior_teacher do not take student assignments.');
  }

  const userId = await withTransaction(async client => {
    for (const studentId of studentIds) {
      const exists = await client.query(
        "SELECT 1 FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",
        [school, studentId]
      );
      if (!exists.rowCount) throw new Error(`Student ${studentId} was not found in school ${school}.`);
    }
    const inserted = await client.query(
      'INSERT INTO users(email,name,role,school_id,student_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [email, name, role, school, role === 'student' ? studentIds[0] : null]
    );
    const id = inserted.rows[0].id;
    for (const studentId of studentIds) {
      if (role === 'parent' || role === 'student') {
        await client.query('INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3)', [id, studentId, school]);
      }
      if (role === 'teacher') {
        await client.query('INSERT INTO teacher_students(user_id,student_id,school_id) VALUES($1,$2,$3)', [id, studentId, school]);
      }
    }
    return id;
  });
  console.log(`Created ${role} account ${email} (id ${userId}) in school ${school}.`);
} catch (error) {
  console.error('Could not create account:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
const dbPath = process.env.DB_PATH || path.join(process.cwd(), 'data', 'athar.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
const [emailArg, nameArg, roleArg, schoolArg, ...studentArgs] = process.argv.slice(2);
const email = (emailArg || '').trim().toLowerCase();
const name = (nameArg || '').trim();
const role = roleArg || '';
const school = (schoolArg || '').trim();
const studentIds = studentArgs.join(',').split(',').map(s => s.trim()).filter(Boolean);
const roles = ['teacher', 'senior_teacher', 'principal', 'parent', 'student'];
if (!email || !name || !school || !roles.includes(role) || school.toUpperCase() === 'DEMO-SCHOOL') {
  console.error('Usage: npm run create-user -- user@moe.om "Name" teacher SCHOOL_ID (must not be DEMO-SCHOOL)');
  console.error('For parent: append one or more STUDENT_ID values separated by commas. For student: append exactly one STUDENT_ID.');
  process.exit(1);
}
if (!['moe.om', 'edu.moe.om'].includes(email.split('@')[1])) {
  console.error('Only @moe.om and @edu.moe.om email domains are allowed.'); process.exit(1);
}
if ((role === 'parent' && !studentIds.length) || (role === 'student' && studentIds.length !== 1) || (['principal','senior_teacher'].includes(role) && studentIds.length)) {
  console.error('Parent requires linked students; student requires exactly one; principal and senior_teacher do not take student assignments.'); process.exit(1);
}
for (const studentId of studentIds) {
  const exists = db.prepare("SELECT 1 FROM records WHERE school_id=? AND kind='student' AND json_extract(payload,'$.student_id')=?").get(school, studentId);
  if (!exists) { console.error(`Student ${studentId} was not found in school ${school}.`); process.exit(1); }
}
try {
  const info = db.prepare('INSERT INTO users(email,name,role,school_id,student_id) VALUES(?,?,?,?,?)').run(email, name, role, school, role === 'student' ? studentIds[0] : null);
  const insertLink = db.prepare('INSERT INTO account_students(user_id,student_id,school_id) VALUES(?,?,?)');
  const assignLink = db.prepare('INSERT INTO teacher_students(user_id,student_id,school_id) VALUES(?,?,?)');
  db.transaction(() => {
    if (role === 'parent' || role === 'student') for (const id of studentIds) insertLink.run(info.lastInsertRowid, id, school);
    if (role === 'teacher') for (const id of studentIds) assignLink.run(info.lastInsertRowid, id, school);
  })();
  console.log(`Created ${role} account for ${email} in school ${school}.`);
} catch (error) {
  console.error('Could not create account:', error.message); process.exit(1);
}

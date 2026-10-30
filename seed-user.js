import 'dotenv/config';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath =
  process.env.DB_PATH ||
  path.join(__dirname, 'data', 'athar.sqlite');

const db = new Database(dbPath);

const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
const name = process.env.SEED_USER_NAME?.trim() || 'مستخدم تجريبي';
const role = process.env.SEED_USER_ROLE || 'teacher';
const schoolId = process.env.SEED_SCHOOL_ID || 'school-001';
const studentId = process.env.SEED_STUDENT_ID || null;

const allowedRoles = [
  'teacher',
  'senior_teacher',
  'principal',
  'parent'
];

if (!email) {
  throw new Error('SEED_USER_EMAIL غير موجود.');
}

if (!email.endsWith('@moe.om') && !email.endsWith('@edu.moe.om')) {
  throw new Error(
    'يجب استخدام بريد حقيقي ينتهي بـ @moe.om أو @edu.moe.om'
  );
}

if (!allowedRoles.includes(role)) {
  throw new Error(
    `الدور غير صحيح. الأدوار المتاحة: ${allowedRoles.join(', ')}`
  );
}

if (role === 'parent' && !studentId) {
  throw new Error(
    'يجب تحديد SEED_STUDENT_ID عند إضافة ولي أمر.'
  );
}

const existingUser = db
  .prepare('SELECT id FROM users WHERE email = ?')
  .get(email);

if (existingUser) {
  db.prepare(`
    UPDATE users
    SET
      name = ?,
      role = ?,
      school_id = ?,
      student_id = ?,
      active = 1
    WHERE email = ?
  `).run(name, role, schoolId, studentId, email);

  console.log(`تم تحديث المستخدم: ${email}`);
} else {
  const result = db.prepare(`
    INSERT INTO users (
      email,
      name,
      role,
      school_id,
      student_id,
      active
    )
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(email, name, role, schoolId, studentId);

  console.log(`تمت إضافة المستخدم برقم: ${result.lastInsertRowid}`);
}

db.close();

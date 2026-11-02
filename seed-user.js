import 'dotenv/config';
import { pool, withTransaction } from './db/postgres.js';

const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
const name = process.env.SEED_USER_NAME?.trim() || 'مستخدم تجريبي';
const role = process.env.SEED_USER_ROLE || 'teacher';
const schoolId = process.env.SEED_SCHOOL_ID || 'school-001';
const studentId = process.env.SEED_STUDENT_ID || null;
const allowedRoles = ['teacher', 'senior_teacher', 'principal', 'parent'];

try {
  if (!email) throw new Error('SEED_USER_EMAIL غير موجود.');
  if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email) || !['moe.om', 'edu.moe.om'].includes(email.split('@')[1])) {
    throw new Error('يجب استخدام بريد ينتهي بـ @moe.om أو @edu.moe.om');
  }
  if (!allowedRoles.includes(role)) throw new Error(`الدور غير صحيح. الأدوار المتاحة: ${allowedRoles.join(', ')}`);
  if (role === 'parent' && !studentId) throw new Error('يجب تحديد SEED_STUDENT_ID عند إضافة ولي أمر.');
  if (role === 'parent') {
    const exists = await pool.query(
      "SELECT 1 FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",
      [schoolId, studentId]
    );
    if (!exists.rowCount) throw new Error('الطالب المحدد غير موجود في المدرسة.');
  }

  const id = await withTransaction(async client => {
    const result = await client.query(`
      INSERT INTO users(email,name,role,school_id,student_id,active)
      VALUES($1,$2,$3,$4,$5,TRUE)
      ON CONFLICT(email) DO UPDATE SET
        name=EXCLUDED.name, role=EXCLUDED.role, school_id=EXCLUDED.school_id,
        student_id=EXCLUDED.student_id, active=TRUE
      RETURNING id
    `, [email, name, role, schoolId, studentId]);
    const userId = result.rows[0].id;
    if (role === 'parent') {
      await client.query('INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [userId, studentId, schoolId]);
    }
    return userId;
  });
  console.log(`تم حفظ المستخدم: ${email} (id ${id})`);
} catch (error) {
  console.error('تعذر حفظ المستخدم:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

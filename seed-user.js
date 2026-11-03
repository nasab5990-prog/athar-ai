import 'dotenv/config';
import { pool } from './database.js';

const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase();
const name = process.env.SEED_USER_NAME?.trim() || 'مستخدم تجريبي';
const role = process.env.SEED_USER_ROLE || 'teacher';
const schoolId = process.env.SEED_SCHOOL_ID || 'school-001';
const studentId = process.env.SEED_STUDENT_ID || null;
const allowedRoles = ['teacher', 'senior_teacher', 'principal', 'parent'];

async function main() {
  if (!email) throw new Error('SEED_USER_EMAIL غير موجود.');
  if (!email.endsWith('@moe.om') && !email.endsWith('@edu.moe.om')) {
    throw new Error('يجب استخدام بريد حقيقي ينتهي بـ @moe.om أو @edu.moe.om');
  }
  if (!allowedRoles.includes(role)) {
    throw new Error(`الدور غير صحيح. الأدوار المتاحة: ${allowedRoles.join(', ')}`);
  }
  if (role === 'parent' && !studentId) {
    throw new Error('يجب تحديد SEED_STUDENT_ID عند إضافة ولي أمر.');
  }

  const result = await pool.query(`
    INSERT INTO users(email,name,role,school_id,student_id,active)
    VALUES($1,$2,$3,$4,$5,TRUE)
    ON CONFLICT(email) DO UPDATE SET
      name=EXCLUDED.name,
      role=EXCLUDED.role,
      school_id=EXCLUDED.school_id,
      student_id=EXCLUDED.student_id,
      active=TRUE
    RETURNING id
  `, [email, name, role, schoolId, studentId]);
  console.log(`تم حفظ المستخدم ${email} برقم ${result.rows[0].id}`);
}

main()
  .catch(error => { console.error('تعذر حفظ المستخدم:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());

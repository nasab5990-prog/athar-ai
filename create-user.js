import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true
});

const [
  emailArgument,
  nameArgument,
  roleArgument,
  schoolArgument,
  studentArgument
] = process.argv.slice(2);

const email = String(emailArgument || '').trim().toLowerCase();
const name = String(nameArgument || '').trim();
const role = String(roleArgument || '').trim();
const schoolId = String(schoolArgument || '').trim();
const studentId = String(studentArgument || '').trim() || null;

const allowedRoles = [
  'teacher',
  'senior_teacher',
  'principal',
  'parent'
];

const domain = email.split('@')[1]?.toLowerCase();

if (
  !email ||
  !name ||
  !schoolId ||
  !allowedRoles.includes(role)
) {
  console.error(
    'Usage: npm run create-user -- ' +
    'user@moe.om "Name" teacher SCHOOL_ID ' +
    '[STUDENT_ID-for-parent]'
  );

  process.exitCode = 1;
} else if (!['moe.om', 'edu.moe.om'].includes(domain)) {
  console.error(
    'Only @moe.om and @edu.moe.om are allowed.'
  );

  process.exitCode = 1;
} else if (role === 'parent' && !studentId) {
  console.error(
    'Parent account requires a linked STUDENT_ID.'
  );

  process.exitCode = 1;
} else {
  try {
    const result = await pool.query(
      `
        INSERT INTO users (
          email,
          name,
          role,
          school_id,
          student_id,
          active
        )
        VALUES ($1, $2, $3, $4, $5, TRUE)
        ON CONFLICT (email)
        DO UPDATE SET
          name = EXCLUDED.name,
          role = EXCLUDED.role,
          school_id = EXCLUDED.school_id,
          student_id = EXCLUDED.student_id,
          active = TRUE
        RETURNING id, email, name, role, school_id
      `,
      [email, name, role, schoolId, studentId]
    );

    console.log('User account is ready:', result.rows[0]);
  } catch (error) {
    console.error(
      'Could not create account:',
      error.message
    );

    process.exitCode = 1;
  }
}

await pool.end();

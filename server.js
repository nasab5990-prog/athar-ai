import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import { sessionStore } from './db/session-store.js';
import { pool, withTransaction } from './db/postgres.js';
import Database from 'better-sqlite3';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';

if (production && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || !process.env.OTP_SECRET || process.env.OTP_SECRET.length < 32)) {
  throw new Error('Production requires SESSION_SECRET and OTP_SECRET of at least 32 characters.');
}

const allowedDomains = new Set(['moe.om', 'edu.moe.om']);
const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'https://nasab5990-prog.github.io').split(',').map(v => v.trim()).filter(Boolean);
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'athar.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const userTableSql = `CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('teacher','senior_teacher','principal','parent','student')),
  school_id TEXT NOT NULL,
  student_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

// Safe migration for existing installations: add the distinct student role without discarding users.
const currentUsersTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
if (!currentUsersTable) {
  db.exec(userTableSql);
} else if (!String(currentUsersTable.sql || '').includes("'student'")) {
  db.transaction(() => {
    db.exec('ALTER TABLE users RENAME TO users_legacy_phase3');
    db.exec(userTableSql);
    db.exec(`INSERT INTO users(id,email,name,role,school_id,student_id,active,created_at)
      SELECT id,email,name,role,school_id,student_id,active,created_at FROM users_legacy_phase3`);
    db.exec('DROP TABLE users_legacy_phase3');
  })();
}

db.exec(`
CREATE TABLE IF NOT EXISTS otp_codes (
  email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, event TEXT NOT NULL,
  details TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, school_id TEXT NOT NULL, owner_id INTEGER NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_records_school_kind ON records(school_id,kind,id);
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(owner_id,id);
CREATE TABLE IF NOT EXISTS account_students (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  PRIMARY KEY(user_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_account_students_student ON account_students(school_id,student_id);
CREATE TABLE IF NOT EXISTS teacher_students (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  school_id TEXT NOT NULL,
  PRIMARY KEY(user_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_teacher_students_student ON teacher_students(school_id,student_id);
`);

// Preserve legacy one-to-one student links while moving to a link table that also supports multiple children.
for (const row of db.prepare("SELECT id,role,school_id,student_id FROM users WHERE role IN ('parent','student') AND student_id IS NOT NULL AND student_id<>''").all()) {
  db.prepare('INSERT OR IGNORE INTO account_students(user_id,student_id,school_id) VALUES(?,?,?)').run(row.id, row.student_id, row.school_id);
}

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || !frontendOrigins.length || frontendOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'athar.sid',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    secure: production,
    sameSite: process.env.COOKIE_SAMESITE || (production ? 'none' : 'lax'),
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { message: 'محاولات كثيرة. حاول لاحقًا.' } });
const recordLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const demoEnabled = process.env.DEMO_LOGIN_ENABLED === 'true';
const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
}) : null;

const roleNames = {
  teacher: 'المعلم', senior_teacher: 'المعلم الأول', principal: 'المدير',
  parent: 'ولي الأمر', student: 'الطالب'
};
const hashOtp = (email, code) => crypto.createHmac('sha256', process.env.OTP_SECRET || process.env.SESSION_SECRET || 'replace-me').update(`${email}:${code}`).digest('hex');
function safeHexEqual(a, b) {
  const aa = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}
function safeText(value, max = 300) { return String(value ?? '').trim().slice(0, max); }
function emailAllowed(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  return allowedDomains.has((email.split('@')[1] || '').toLowerCase());
}
async function auditPg(userId, event, details = '') {
  await pool.query('INSERT INTO audit_log(user_id,event,details) VALUES($1,$2,$3)',[userId || null,event,safeText(details,500)]);
}
async function requireAuth(req,res,next) {
  try {
    if (!req.session.user?.id) return res.status(401).json({message:'يلزم تسجيل الدخول.'});
    const result=await pool.query('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE id=$1',[req.session.user.id]);
    const fresh=result.rows[0];
    if (!fresh || !fresh.active) { req.session.destroy(()=>{}); return res.status(401).json({message:'الحساب غير نشط.'}); }
    req.user=fresh; next();
  } catch(error) { next(error); }
}
async function linkedStudentIdsPg(user) {
 const r=await pool.query('SELECT student_id FROM account_students WHERE user_id=$1 AND school_id=$2 ORDER BY student_id',[user.id,user.school_id]); return r.rows.map(x=>x.student_id);
}
async function assignedStudentIdsPg(user) {
 const r=await pool.query('SELECT student_id FROM teacher_students WHERE user_id=$1 AND school_id=$2 ORDER BY student_id',[user.id,user.school_id]); return r.rows.map(x=>x.student_id);
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.' });
    next();
  };
}
function linkedStudentIds(user) {
  return db.prepare('SELECT student_id FROM account_students WHERE user_id=? AND school_id=? ORDER BY student_id').all(user.id, user.school_id).map(x => x.student_id);
}
function assignedStudentIds(user) {
  return db.prepare('SELECT student_id FROM teacher_students WHERE user_id=? AND school_id=? ORDER BY student_id').all(user.id, user.school_id).map(x => x.student_id);
}
function studentExistsInSchool(studentId, schoolId) {
  return !!db.prepare("SELECT id FROM records WHERE school_id=? AND kind='student' AND json_extract(payload,'$.student_id')=? LIMIT 1").get(schoolId, studentId);
}
function getRecordsForUser(user) {
  if (user.role === 'principal' || user.role === 'senior_teacher') {
    return db.prepare('SELECT id,kind,payload,created_at FROM records WHERE school_id=? ORDER BY id DESC LIMIT 1000').all(user.school_id);
  }
  if (user.role === 'teacher') {
    const assigned = assignedStudentIds(user);
    const assignmentClause = assigned.length ? ` OR json_extract(payload,'$.student_id') IN (${assigned.map(() => '?').join(',')})` : '';
    return db.prepare(`SELECT id,kind,payload,created_at FROM records WHERE school_id=? AND (owner_id=? OR kind IN ('shared_assessment','shared_intervention')${assignmentClause}) ORDER BY id DESC LIMIT 800`).all(user.school_id, user.id, ...assigned);
  }
  if (user.role === 'parent' || user.role === 'student') {
    const ids = linkedStudentIds(user);
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id,kind,payload,created_at FROM records
      WHERE school_id=? AND kind IN ('student','assessment','intervention','impact')
      AND json_extract(payload,'$.student_id') IN (${marks}) ORDER BY id DESC LIMIT 500`).all(user.school_id, ...ids);
  }
  return [];
}
function findStudentOwnedBy(user, studentId) {
  const record = db.prepare("SELECT id,owner_id FROM records WHERE school_id=? AND kind='student' AND json_extract(payload,'$.student_id')=? LIMIT 1").get(user.school_id, studentId);
  if (!record) return null;
  if (user.role === 'teacher' && (record.owner_id === user.id || assignedStudentIds(user).includes(studentId))) return record;
  if (user.role === 'senior_teacher' || user.role === 'principal') return record;
  return null;
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'athar-api', version: '3.0.0' }));
app.get('/api/auth/mode', (req, res) => res.json({ mode: demoEnabled ? 'demo' : 'otp', otpAvailable: Boolean(transporter) }));

app.post('/api/auth/request-code',loginLimiter,async(req,res)=>{
 const email=safeText(req.body?.email,254).toLowerCase();
 if(!emailAllowed(email)) return res.status(400).json({message:'استخدم البريد الرسمي ضمن @moe.om أو @edu.moe.om.'});
 if(!transporter) return res.status(503).json({message:'الدخول بالبريد غير مفعّل بعد؛ لم يتم إعداد خدمة البريد في الخادم.'});
 const found=await pool.query('SELECT id,active FROM users WHERE email=$1',[email]); const user=found.rows[0];
 if(user?.active){
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  await pool.query('INSERT INTO otp_codes(email,code_hash,expires_at,attempts,created_at) VALUES($1,$2,$3,0,$4) ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,created_at=EXCLUDED.created_at',[email,hashOtp(email,code),Date.now()+600000,Date.now()]);
  try { await transporter.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:email,subject:'رمز التحقق — أثَر',text:'رمز التحقق للدخول إلى منصة أثَر هو: '+code+'\nصالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.'}); }
  catch(error){ await pool.query('DELETE FROM otp_codes WHERE email=$1',[email]); console.error('OTP email delivery failed:',error); return res.status(502).json({message:'تعذر إرسال رمز التحقق. تحقق من إعدادات البريد في الخادم.'}); }
 }
 res.json({message:'إذا كان البريد مسجلًا ومفعّلًا، فسيصلك رمز تحقق خلال لحظات.'});
});
app.post('/api/auth/verify-code',loginLimiter,async(req,res)=>{
 const email=safeText(req.body?.email,254).toLowerCase(), code=safeText(req.body?.code,6);
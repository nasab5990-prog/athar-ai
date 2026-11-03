import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import SQLiteStoreFactory from 'connect-sqlite3';
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

const SQLiteStore = SQLiteStoreFactory(session);
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
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(dbPath) }),
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
function audit(userId, event, details = '') {
  db.prepare('INSERT INTO audit_log(user_id,event,details) VALUES(?,?,?)').run(userId || null, event, safeText(details, 500));
}
function requireAuth(req, res, next) {
  const sessionUser = req.session.user;
  if (!sessionUser?.id) return res.status(401).json({ message: 'يلزم تسجيل الدخول.' });
  const fresh = db.prepare('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE id=?').get(sessionUser.id);
  if (!fresh || !fresh.active) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: 'الحساب غير نشط.' });
  }
  req.user = fresh;
  next();
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

app.post('/api/auth/request-code', loginLimiter, async (req, res) => {
  const email = safeText(req.body?.email, 254).toLowerCase();
  if (!emailAllowed(email)) return res.status(400).json({ message: 'استخدم البريد الرسمي ضمن @moe.om أو @edu.moe.om.' });
  if (!transporter) return res.status(503).json({ message: 'الدخول بالبريد غير مفعّل بعد؛ لم يتم إعداد خدمة البريد في الخادم.' });
  const user = db.prepare('SELECT id,active FROM users WHERE email=?').get(email);
  // Do not reveal whether an email is registered.
  if (user?.active) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare(`INSERT INTO otp_codes(email,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at`)
      .run(email, hashOtp(email, code), Date.now() + 10 * 60 * 1000, 0, Date.now());
    try {
      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'رمز التحقق — أثَر',
        text: `رمز التحقق للدخول إلى منصة أثَر هو: ${code}\nصالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.`
      });
    } catch (error) {
      db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);
      console.error('OTP email delivery failed:', error);
      return res.status(502).json({ message: 'تعذر إرسال رمز التحقق. تحقق من إعدادات البريد في الخادم.' });
    }
  }
  res.json({ message: 'إذا كان البريد مسجلًا ومفعّلًا، فسيصلك رمز تحقق خلال لحظات.' });
});

app.post('/api/auth/verify-code', loginLimiter, (req, res) => {
  const email = safeText(req.body?.email, 254).toLowerCase();
  const code = safeText(req.body?.code, 6);
  if (!emailAllowed(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ message: 'البريد أو رمز التحقق غير صالح.' });
  const row = db.prepare('SELECT * FROM otp_codes WHERE email=?').get(email);
  if (!row || row.expires_at < Date.now() || row.attempts >= 5) {
    db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);
    return res.status(401).json({ message: 'انتهت صلاحية الرمز أو لم يعد صالحًا. اطلب رمزًا جديدًا.' });
  }
  const match = safeHexEqual(row.code_hash, hashOtp(email, code));
  if (!match) {
    db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE email=?').run(email);
    return res.status(401).json({ message: 'رمز التحقق غير صحيح.' });
  }
  db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);
  const user = db.prepare('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE email=? AND active=1').get(email);
  if (!user) return res.status(401).json({ message: 'الحساب غير مفعّل. راجع مسؤول النظام.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ message: 'تعذر إنشاء جلسة آمنة.' });
    req.session.user = { id: user.id };
    audit(user.id, 'login', user.role);
    res.json({ user: { ...user, roleName: roleNames[user.role], linkedStudentIds: linkedStudentIds(user), assignedStudentIds: assignedStudentIds(user) } });
  });
});

function ensureDemoFixtures() {
  const schoolId = 'DEMO-SCHOOL';
  const demoUsers = [
    ['demo.teacher@athar.test', 'معلّم تجريبي', 'teacher'],
    ['demo.senior@athar.test', 'معلم أول تجريبي', 'senior_teacher'],
    ['demo.principal@athar.test', 'مدير تجريبي', 'principal'],
    ['demo.parent@athar.test', 'ولي أمر تجريبي', 'parent'],
    ['demo.student@athar.test', 'طالب تجريبي', 'student']
  ];
  const findUser = db.prepare('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE email=?');
  const insertUser = db.prepare('INSERT INTO users(email,name,role,school_id,student_id,active) VALUES(?,?,?,?,?,1)');
  const users = {};
  for (const [email, name, role] of demoUsers) {
    let user = findUser.get(email);
    if (!user) {
      const info = insertUser.run(email, name, role, schoolId, null);
      user = findUser.get(email);
    }
    if (!user.active || user.school_id !== schoolId || user.role !== role) throw new Error('Demo account configuration conflict.');
    users[role] = user;
  }
  // Demo identities are kept for role switching, but never seed learner records or scores.
  // Remove only the legacy sample learner shipped by the previous demo build.
  const legacyStudentId = 'DEMO-STUDENT-001';
  db.prepare("UPDATE users SET student_id=NULL WHERE email='demo.student@athar.test'").run();
  db.prepare("DELETE FROM records WHERE school_id=? AND json_extract(payload,'$.student_id')=?").run(schoolId, legacyStudentId);
  db.prepare('DELETE FROM account_students WHERE school_id=? AND student_id=?').run(schoolId, legacyStudentId);
  db.prepare('DELETE FROM teacher_students WHERE school_id=? AND student_id=?').run(schoolId, legacyStudentId);
  return users;
}

app.post('/api/auth/demo', loginLimiter, (req, res) => {
  if (!demoEnabled) return res.status(404).json({ message: 'وضع الاختبار غير مفعّل.' });
  const role = safeText(req.body?.persona || 'teacher', 32);
  const allowedDemoRoles = new Set(['teacher', 'senior_teacher', 'principal', 'parent', 'student']);
  if (!allowedDemoRoles.has(role)) return res.status(400).json({ message: 'شخصية الاختبار غير معروفة.' });
  let users;
  try { users = ensureDemoFixtures(); }
  catch (error) { console.error('Demo fixture error:', error); return res.status(500).json({ message: 'تعذر تجهيز حسابات الاختبار.' }); }
  const user = users[role];
  if (!user?.active) return res.status(403).json({ message: 'حساب الاختبار غير نشط.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ message: 'تعذر إنشاء جلسة آمنة.' });
    req.session.user = { id: user.id };
    audit(user.id, 'demo.login', role);
    res.json({ user: { ...user, roleName: roleNames[user.role], linkedStudentIds: linkedStudentIds(user), assignedStudentIds: assignedStudentIds(user), isDemo:true }, warning: 'وضع اختبار فقط مع بيانات اصطناعية في مدرسة معزولة. لا تستخدم بيانات حقيقية.' });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: { ...req.user, roleName: roleNames[req.user.role], linkedStudentIds: linkedStudentIds(req.user), assignedStudentIds: assignedStudentIds(req.user), isDemo:req.user.school_id === 'DEMO-SCHOOL' } }));
app.post('/api/auth/logout', requireAuth, (req, res) => {
  audit(req.user.id, 'logout');
  req.session.destroy(() => { res.clearCookie('athar.sid'); res.json({ ok: true }); });
});

app.get('/api/records', requireAuth, (req, res) => {
  const rows = getRecordsForUser(req.user);
  res.json({ records: rows.map(row => ({ ...row, payload: JSON.parse(row.payload) })) });
});

app.post('/api/records', recordLimiter, requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), (req, res) => {
  const kind = safeText(req.body?.kind, 40);
  const payload = req.body?.payload;
  const permitted = ['student', 'assessment', 'intervention', 'impact'];
  if (!permitted.includes(kind) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ message: 'نوع السجل أو بياناته غير صالحة.' });
  }
  const cleanPayload = { ...payload };
  delete cleanPayload.school_id;
  delete cleanPayload.owner_id;
  if (kind === 'student') {
    cleanPayload.student_id = safeText(cleanPayload.student_id, 80);
    cleanPayload.name = safeText(cleanPayload.name, 140);
    if (!cleanPayload.student_id || !cleanPayload.name) return res.status(400).json({ message: 'اسم الطالب ومعرّفه مطلوبان.' });
    const exists = db.prepare("SELECT id FROM records WHERE school_id=? AND kind='student' AND json_extract(payload,'$.student_id')=?").get(req.user.school_id, cleanPayload.student_id);
    if (exists) return res.status(409).json({ message: 'معرّف الطالب مستخدم بالفعل في المدرسة.' });
  } else if (cleanPayload.student_id) {
    cleanPayload.student_id = safeText(cleanPayload.student_id, 80);
    if (!findStudentOwnedBy(req.user, cleanPayload.student_id)) return res.status(403).json({ message: 'الطالب غير تابع لسجلاتك أو غير موجود في المدرسة.' });
  }
  const serialized = JSON.stringify(cleanPayload);
  if (serialized.length > 30000) return res.status(413).json({ message: 'حجم السجل أكبر من الحد المسموح.' });
  const info = db.prepare('INSERT INTO records(school_id,owner_id,kind,payload) VALUES(?,?,?,?)').run(req.user.school_id, req.user.id, kind, serialized);
  audit(req.user.id, 'record.create', kind);
  res.status(201).json({ id: info.lastInsertRowid, kind, payload: cleanPayload });
});

app.post('/api/records/bulk', recordLimiter, requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), (req, res) => {
  const incoming = req.body?.records;
  const permitted = new Set(['student', 'assessment', 'intervention', 'impact']);
  if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > 100) {
    return res.status(400).json({ message: 'أرسل من 1 إلى 100 سجل في كل دفعة.' });
  }
  const prepared = [];
  const batchStudentIds = new Set();
  for (const item of incoming) {
    const kind = safeText(item?.kind, 40);
    const payload = item?.payload;
    if (!permitted.has(kind) || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return res.status(400).json({ message: 'تحتوي الدفعة على نوع سجل أو بيانات غير صالحة.' });
    }
    const clean = { ...payload };
    delete clean.school_id; delete clean.owner_id; delete clean.recordId; delete clean.id;
    if (kind === 'student') {
      clean.student_id = safeText(clean.student_id, 80);
      clean.name = safeText(clean.name, 140);
      if (!clean.student_id || !clean.name || batchStudentIds.has(clean.student_id) || studentExistsInSchool(clean.student_id, req.user.school_id)) {
        return res.status(409).json({ message: 'يوجد طالب مكرر أو سجل طالب ينقصه الاسم أو المعرّف.' });
      }
      batchStudentIds.add(clean.student_id);
    } else if (clean.student_id) {
      clean.student_id = safeText(clean.student_id, 80);
    }
    if (JSON.stringify(clean).length > 30000) return res.status(413).json({ message: 'أحد السجلات أكبر من الحد المسموح.' });
    prepared.push({ kind, payload:clean });
  }
  for (const item of prepared) {
    if (item.kind !== 'student' && item.payload.student_id && !batchStudentIds.has(item.payload.student_id) && !findStudentOwnedBy(req.user, item.payload.student_id)) {
      return res.status(403).json({ message: 'أحد السجلات مرتبط بطالب لا تملك صلاحية الوصول إليه.' });
    }
  }
  const insert = db.prepare('INSERT INTO records(school_id,owner_id,kind,payload) VALUES(?,?,?,?)');
  let created;
  try {
    created = db.transaction(() => {
      const results = [];
      const ordered = [...prepared.filter(x => x.kind === 'student'), ...prepared.filter(x => x.kind !== 'student')];
      for (const item of ordered) {
        const info = insert.run(req.user.school_id, req.user.id, item.kind, JSON.stringify(item.payload));
        results.push({ id:info.lastInsertRowid, kind:item.kind });
      }
      return results;
    })();
  } catch (error) {
    console.error('Bulk import failed:', error);
    return res.status(500).json({ message: 'تعذر حفظ الدفعة؛ لم تُحفظ سجلاتها.' });
  }
  audit(req.user.id, 'records.bulk_import', `count=${created.length}`);
  res.status(201).json({ ok:true, count:created.length, records:created });
});

app.delete('/api/records/:id', requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'معرّف السجل غير صالح.' });
  const row = db.prepare('SELECT id,owner_id,school_id,kind,payload FROM records WHERE id=? AND school_id=?').get(id, req.user.school_id);
  if (!row) return res.status(404).json({ message: 'السجل غير موجود.' });
  if (req.user.role === 'teacher' && row.owner_id !== req.user.id) return res.status(403).json({ message: 'لا يمكنك حذف سجل لا تملكه.' });
  if (row.kind === 'student') {
    const studentId = JSON.parse(row.payload).student_id;
    const linked = db.prepare('SELECT COUNT(*) AS n FROM account_students WHERE school_id=? AND student_id=?').get(req.user.school_id, studentId).n;
    if (linked) return res.status(409).json({ message: 'لا يمكن حذف الطالب قبل إزالة ربط حسابات ولي الأمر والطالب.' });
    const removeLinked = db.prepare("DELETE FROM records WHERE school_id=? AND json_extract(payload,'$.student_id')=?");
    const removeTeacherLinks = db.prepare('DELETE FROM teacher_students WHERE school_id=? AND student_id=?');
    db.transaction(() => { removeLinked.run(req.user.school_id, studentId); removeTeacherLinks.run(req.user.school_id, studentId); })();
  } else {
    db.prepare('DELETE FROM records WHERE id=?').run(id);
  }
  audit(req.user.id, 'record.delete', row.kind);
  res.json({ ok: true });
});

app.get('/api/users', requireAuth, requireRole('principal'), (req, res) => {
  const users = db.prepare('SELECT id,email,name,role,school_id,active,created_at FROM users WHERE school_id=? ORDER BY name').all(req.user.school_id);
  const linked = db.prepare('SELECT user_id,student_id FROM account_students WHERE school_id=?').all(req.user.school_id);
  const assigned = db.prepare('SELECT user_id,student_id FROM teacher_students WHERE school_id=?').all(req.user.school_id);
  const map = new Map(), assignmentMap = new Map();
  for (const link of linked) map.set(link.user_id, [...(map.get(link.user_id) || []), link.student_id]);
  for (const link of assigned) assignmentMap.set(link.user_id, [...(assignmentMap.get(link.user_id) || []), link.student_id]);
  res.json({ users: users.map(user => ({ ...user, linkedStudentIds: map.get(user.id) || [], assignedStudentIds: assignmentMap.get(user.id) || [] })) });
});

app.post('/api/users', requireAuth, requireRole('principal'), (req, res) => {
  if (req.user.school_id === 'DEMO-SCHOOL') return res.status(403).json({ message: 'لا يمكن إنشاء حسابات مدرسية رسمية من بيئة الاختبار المعزولة.' });
  const email = safeText(req.body?.email, 254).toLowerCase();
  const name = safeText(req.body?.name, 140);
  const role = safeText(req.body?.role, 32);
  const studentIds = Array.isArray(req.body?.studentIds) ? [...new Set(req.body.studentIds.map(v => safeText(v, 80)).filter(Boolean))] : [];
  const allowedRoles = ['teacher', 'senior_teacher', 'principal', 'parent', 'student'];
  if (!emailAllowed(email)) return res.status(400).json({ message: 'يجب استخدام بريد رسمي من نطاقي الوزارة.' });
  if (!name || !allowedRoles.includes(role)) return res.status(400).json({ message: 'الاسم أو الدور غير صالح.' });
  if ((role === 'parent' && studentIds.length < 1) || (role === 'student' && studentIds.length !== 1) || (['principal','senior_teacher'].includes(role) && studentIds.length)) {
    return res.status(400).json({ message: role === 'student' ? 'يجب ربط حساب الطالب بطالب واحد فقط.' : role === 'parent' ? 'يجب ربط حساب ولي الأمر بطالب واحد على الأقل.' : 'لا يلزم إسناد طلبة إلى هذا الدور.' });
  }
  for (const studentId of studentIds) {
    if (!studentExistsInSchool(studentId, req.user.school_id)) return res.status(400).json({ message: 'أحد الطلبة المحددين غير موجود في سجلات المدرسة.' });
  }
  try {
    const info = db.prepare('INSERT INTO users(email,name,role,school_id,student_id) VALUES(?,?,?,?,?)').run(email, name, role, req.user.school_id, role === 'student' ? studentIds[0] : null);
    const linkStmt = db.prepare('INSERT INTO account_students(user_id,student_id,school_id) VALUES(?,?,?)');
    const assignStmt = db.prepare('INSERT INTO teacher_students(user_id,student_id,school_id) VALUES(?,?,?)');
    db.transaction(() => {
      if (role === 'parent' || role === 'student') for (const sid of studentIds) linkStmt.run(info.lastInsertRowid, sid, req.user.school_id);
      if (role === 'teacher') for (const sid of studentIds) assignStmt.run(info.lastInsertRowid, sid, req.user.school_id);
    })();
    audit(req.user.id, 'user.create', role);
    res.status(201).json({ ok: true, id: info.lastInsertRowid, email, name, role, linkedStudentIds: role === 'parent' || role === 'student' ? studentIds : [], assignedStudentIds: role === 'teacher' ? studentIds : [] });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ message: 'هذا البريد مسجل مسبقًا.' });
    throw error;
  }
});

app.put('/api/users/:id/assignments', requireAuth, requireRole('principal'), (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare("SELECT id,role,school_id FROM users WHERE id=? AND school_id=?").get(targetId, req.user.school_id);
  if (!target || target.role !== 'teacher') return res.status(404).json({ message: 'حساب المعلم غير موجود في المدرسة.' });
  const studentIds = Array.isArray(req.body?.studentIds) ? [...new Set(req.body.studentIds.map(v => safeText(v, 80)).filter(Boolean))] : [];
  for (const studentId of studentIds) if (!studentExistsInSchool(studentId, req.user.school_id)) return res.status(400).json({ message: 'أحد الطلبة المحددين غير موجود في المدرسة.' });
  const remove = db.prepare('DELETE FROM teacher_students WHERE user_id=? AND school_id=?');
  const add = db.prepare('INSERT INTO teacher_students(user_id,student_id,school_id) VALUES(?,?,?)');
  db.transaction(() => { remove.run(targetId, req.user.school_id); for (const sid of studentIds) add.run(targetId, sid, req.user.school_id); })();
  audit(req.user.id, 'user.assignments.update', String(targetId));
  res.json({ ok:true, userId:targetId, assignedStudentIds:studentIds });
});

app.put('/api/users/:id/student-links', requireAuth, requireRole('principal'), (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT id,role,school_id FROM users WHERE id=? AND school_id=?').get(targetId, req.user.school_id);
  if (!target || !['parent','student'].includes(target.role)) return res.status(404).json({ message: 'حساب الطالب أو ولي الأمر غير موجود في المدرسة.' });
  const studentIds = Array.isArray(req.body?.studentIds) ? [...new Set(req.body.studentIds.map(v => safeText(v, 80)).filter(Boolean))] : [];
  if ((target.role === 'student' && studentIds.length !== 1) || (target.role === 'parent' && studentIds.length < 1)) {
    return res.status(400).json({ message: target.role === 'student' ? 'يجب ربط حساب الطالب بسجل واحد فقط.' : 'يجب ربط حساب ولي الأمر بطالب واحد على الأقل.' });
  }
  for (const studentId of studentIds) if (!studentExistsInSchool(studentId, req.user.school_id)) return res.status(400).json({ message: 'أحد الطلبة المحددين غير موجود في سجلات المدرسة.' });
  const remove = db.prepare('DELETE FROM account_students WHERE user_id=? AND school_id=?');
  const add = db.prepare('INSERT INTO account_students(user_id,student_id,school_id) VALUES(?,?,?)');
  const updateLegacy = db.prepare('UPDATE users SET student_id=? WHERE id=? AND school_id=?');
  db.transaction(() => {
    remove.run(targetId, req.user.school_id);
    for (const studentId of studentIds) add.run(targetId, studentId, req.user.school_id);
    updateLegacy.run(target.role === 'student' ? studentIds[0] : null, targetId, req.user.school_id);
  })();
  audit(req.user.id, 'user.student_links.update', `${target.role}:${targetId}`);
  res.json({ ok:true, userId:targetId, linkedStudentIds:studentIds });
});

// Data-driven educational analysis: uses stored assessment history and a skill prerequisite map.
const skillMap = [
  { keys: ['تمثيل الكسور', 'الكسور', 'كسر', 'البسط', 'المقام'], title: 'تمثيل الكسور', prerequisites: ['الجزء والكل', 'معرفة البسط والمقام'], next: ['مقارنة الكسور', 'العمليات على الكسور'], strategies: ['استخدم شرائط الكسور والأشكال المقسمة لربط الجزء بالكل.', 'اطلب من الطالب تسمية البسط والمقام قبل تمثيل الكسر.', 'قدّم سؤال تحقق قصيرًا بعد كل مثال.'] },
  { keys: ['العمليات على الكسور', 'جمع الكسور', 'طرح الكسور'], title: 'العمليات على الكسور', prerequisites: ['تمثيل الكسور', 'الكسور المتكافئة'], next: ['حل المسائل اللفظية على الكسور'], strategies: ['راجع تمثيل الكسر بصريًا قبل الانتقال إلى الخوارزمية.', 'استخدم نماذج متكافئة للمقامات.', 'درّب الطالب على تفسير سبب اختيار العملية.'] },
  { keys: ['الفهم القرائي', 'القراءة', 'فهم المقروء'], title: 'الفهم القرائي', prerequisites: ['الطلاقة القرائية', 'المفردات والسياق'], next: ['الفكرة الرئيسة', 'الاستدلال من النص'], strategies: ['استخدم نصوصًا قصيرة متعددة المستويات.', 'درّب الطلبة على تحديد الدليل النصي.', 'اطلب إعادة صياغة الفكرة بكلمات الطالب.'] },
  { keys: ['الفكرة الرئيسة', 'الفكرة الرئيسية'], title: 'الفكرة الرئيسة', prerequisites: ['المفردات والسياق', 'الفهم القرائي'], next: ['التلخيص', 'الاستدلال من النص'], strategies: ['استخدم عناوين وصورًا متوقعة قبل القراءة.', 'ميّز بين الفكرة الرئيسة والتفاصيل الداعمة.', 'اطلب اختيار عنوان مناسب مع ذكر الدليل.'] },
  { keys: ['الاستدلال', 'الاستنتاج'], title: 'الاستدلال من النص', prerequisites: ['الفهم القرائي', 'المفردات والسياق'], next: ['التفسير النقدي'], strategies: ['استخدم أسئلة لماذا وكيف مع مطالبة الطالب بالدليل.', 'اعرض قرائن متفرقة واطلب ربطها.', 'ناقش أكثر من احتمال قبل اختيار الاستنتاج.'] }
];
function normalizeArabic(value) {
  return safeText(value, 160).toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '').trim();
}
function findSkill(skill) {
  const key = normalizeArabic(skill);
  const matches = skillMap.flatMap(item => item.keys
    .filter(k => key.includes(normalizeArabic(k)) || normalizeArabic(k).includes(key))
    .map(k => ({ item, length: normalizeArabic(k).length })));
  matches.sort((a, b) => b.length - a.length);
  return matches[0]?.item || null;
}
function analyzeLearning(user, body) {
  const skill = safeText(body.skill || body.question, 160) || 'مهارة غير محددة';
  const studentId = safeText(body.student_id, 80);
  const studentRecord = studentId ? findStudentOwnedBy(user, studentId) : null;
  if (studentId && !studentRecord) throw Object.assign(new Error('الطالب غير تابع لسجلاتك أو غير موجود في المدرسة.'), { status: 403 });
  let rows;
  if (user.role === 'principal' || user.role === 'senior_teacher') {
    rows = db.prepare("SELECT payload FROM records WHERE school_id=? AND kind='assessment' ORDER BY id DESC LIMIT 1000").all(user.school_id);
  } else {
    const assigned = user.role === 'teacher' ? assignedStudentIds(user) : [];
    const assignmentClause = assigned.length ? ` OR json_extract(payload,'$.student_id') IN (${assigned.map(() => '?').join(',')})` : '';
    rows = db.prepare(`SELECT payload FROM records WHERE school_id=? AND kind='assessment' AND (owner_id=?${assignmentClause}) ORDER BY id DESC LIMIT 800`).all(user.school_id, user.id, ...assigned);
  }
  let assessments = rows.map(r => JSON.parse(r.payload));
  if (studentId) assessments = assessments.filter(a => a.student_id === studentId);
  const mapped = findSkill(skill);
  const analysisSkill = mapped?.title || skill;
  const normalizedSkill = normalizeArabic(analysisSkill);
  const matchesSkill = (record, target) => {
    const recordSkill = normalizeArabic(record.skill || record.name || '');
    return Boolean(recordSkill && target && (recordSkill.includes(target) || target.includes(recordSkill)));
  };
  const matching = assessments.filter(a => matchesSkill(a, normalizedSkill));
  const latestPerLearner = records => {
    const groups = new Map();
    for (const record of records) {
      const key = record.student_id || `class:${record.grade || ''}:${record.section || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
    return [...groups.values()].map(items => items.slice(0, 2));
  };
  const learnerHistory = latestPerLearner(matching);
  const latestScores = learnerHistory.map(items => Number(items[0]?.pct)).filter(Number.isFinite);
  const targetScore = latestScores.length ? Number((latestScores.reduce((sum, value) => sum + value, 0) / latestScores.length).toFixed(1)) : null;
  const previousChanges = learnerHistory.filter(items => items.length > 1 && Number.isFinite(Number(items[0].pct)) && Number.isFinite(Number(items[1].pct)))
    .map(items => Number(items[0].pct) - Number(items[1].pct));
  const trend = previousChanges.length ? Number((previousChanges.reduce((sum, value) => sum + value, 0) / previousChanges.length).toFixed(1)) : null;
  const sampleSize = latestScores.length;
  const prerequisites = mapped?.prerequisites || [];
  const prereqEvidence = prerequisites.map(name => {
    const target = normalizeArabic(name);
    const histories = latestPerLearner(assessments.filter(a => matchesSkill(a, target)));
    const scores = histories.map(items => Number(items[0]?.pct)).filter(Number.isFinite);
    const score = scores.length ? Number((scores.reduce((sum, value) => sum + value, 0) / scores.length).toFixed(1)) : null;
    return { skill: name, score, sampleSize:scores.length };
  });
  const weakRoots = prereqEvidence.filter(item => item.score !== null && item.score < 70);
  const level = targetScore === null ? 'لا تتوفر نتائج كافية' : targetScore < 50 ? 'تعثر مرتفع' : targetScore < 70 ? 'يحتاج إلى دعم' : targetScore < 85 ? 'قريب من الإتقان' : 'متقن';
  const roots = weakRoots.length ? weakRoots : prereqEvidence;
  const strategy = mapped?.strategies || ['ابدأ بتقويم تشخيصي قصير يحدد نوع الخطأ.', 'قسّم المهارة إلى خطوات أصغر، ثم قدّم نموذجًا محلولًا.', 'استخدم سؤال تحقق مستقلًا بعد النشاط.'];
  const suggestions = targetScore === null
    ? ['أدخل نتيجة تقويم لهذه المهارة أولًا.', 'نفّذ تقويمًا قصيرًا للمهارات السابقة لتحديد جذر الفجوة.']
    : targetScore < 70
      ? strategy
      : ['قدّم نشاطًا تطبيقيًا للتحقق من ثبات الإتقان.', 'انتقل تدريجيًا إلى المهارات اللاحقة دون إلغاء المراجعة.'];
  const evidence = [];
  if (targetScore !== null) evidence.push(`آخر نتيجة مسجلة للمهارة ${targetScore}%.`);
  if (trend !== null) evidence.push(`التغير عن التقويم السابق ${trend > 0 ? '+' : ''}${trend} نقطة مئوية.`);
  if (weakRoots.length) evidence.push(`ظهرت فجوة في مهارات سابقة: ${weakRoots.map(x => `${x.skill} (${x.score}%)`).join('، ')}.`);
  if (!weakRoots.length && prereqEvidence.length) evidence.push('لا توجد نتائج منخفضة مسجلة للمهارات السابقة ضمن البيانات المتاحة؛ يُنصح بالتأكد منها بتقويم تشخيصي عند الحاجة.');
  if (!studentId && sampleSize) evidence.push(`احتُسب متوسط المهارة من أحدث نتيجة لكل طالب/مجموعة؛ عدد السجلات الممثلة: ${sampleSize}.`);
  if (safeText(body.observedErrors, 1000)) evidence.push(`ملاحظة المعلم: ${safeText(body.observedErrors, 1000)}`);
  return {
    skill: mapped?.title || skill,
    level,
    targetScore,
    trend,
    sampleSize,
    likelyRoots: weakRoots,
    prerequisiteEvidence: prereqEvidence,
    nextSkills: mapped?.next || [],
    evidence,
    recommendations: suggestions,
    disclaimer: 'تحليل مساند مبني على السجلات المتاحة وخريطة مهارات أولية؛ لا يمثل تشخيصًا نهائيًا، ويعتمد القرار على مراجعة المعلم.'
  };
}
app.post('/api/analysis', requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), (req, res) => {
  try {
    const result = analyzeLearning(req.user, req.body || {});
    const studentId = safeText(req.body?.student_id, 80) || null;
    const saved = db.prepare('INSERT INTO records(school_id,owner_id,kind,payload) VALUES(?,?,?,?)').run(req.user.school_id, req.user.id, 'analysis', JSON.stringify({ student_id:studentId, skill:result.skill, result, date:new Date().toISOString() }));
    audit(req.user.id, 'learning.analysis', result.skill);
    res.json({ analysis: result, id:saved.lastInsertRowid });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.status ? error.message : 'تعذر تحليل البيانات.' });
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ message: 'حدث خطأ داخلي. راجع سجل الخادم.' });
});

app.listen(port, () => console.log(`ATHAR API v3 listening on ${port}`));

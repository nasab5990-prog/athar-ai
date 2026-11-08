import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { pool, query, withTransaction } from './database.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (production && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32 || !process.env.OTP_SECRET || process.env.OTP_SECRET.length < 32)) {
  throw new Error('Production requires SESSION_SECRET and OTP_SECRET of at least 32 characters.');
}
const allowedDomains = new Set(['moe.om', 'edu.moe.om']);
const frontendOrigins = (process.env.FRONTEND_ORIGIN || 'https://nasab5990-prog.github.io').split(',').map(v => v.trim()).filter(Boolean);
const roleNames = { teacher:'المعلم', senior_teacher:'المعلم الأول', principal:'المدير', parent:'ولي الأمر', student:'الطالب' };
const demoEnabled = process.env.DEMO_LOGIN_ENABLED === 'true';
const transporter = process.env.SMTP_HOST ? nodemailer.createTransport({
  host:process.env.SMTP_HOST, port:Number(process.env.SMTP_PORT || 587),
  secure:process.env.SMTP_SECURE === 'true',
  auth:process.env.SMTP_USER ? { user:process.env.SMTP_USER, pass:process.env.SMTP_PASS } : undefined
}) : null;
const PgSession = connectPgSimple(session);
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy:{ policy:'cross-origin' } }));
app.use(cors({ origin:(origin,cb) => !origin || !frontendOrigins.length || frontendOrigins.includes(origin) ? cb(null,true) : cb(new Error('Origin not allowed')), credentials:true }));
app.use(express.json({ limit:'1mb' }));
app.use(session({
  name:'athar.sid', secret:process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploying',
  resave:false, saveUninitialized:false,
  store:new PgSession({ pool, tableName:'session', createTableIfMissing:true }),
  cookie:{ httpOnly:true, secure:production, sameSite:process.env.COOKIE_SAMESITE || (production ? 'none':'lax'), maxAge:8*60*60*1000 }
}));
const loginLimiter = rateLimit({ windowMs:15*60*1000, limit:10, standardHeaders:true, legacyHeaders:false, message:{ message:'محاولات كثيرة. حاول لاحقًا.' } });
const recordLimiter = rateLimit({ windowMs:60*1000, limit:60, standardHeaders:true, legacyHeaders:false });
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const safeText = (value,max=300) => String(value ?? '').trim().slice(0,max);
const emailAllowed = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && allowedDomains.has((email.split('@')[1] || '').toLowerCase());
const hashOtp = (email,code) => crypto.createHmac('sha256',process.env.OTP_SECRET || process.env.SESSION_SECRET || 'replace-me').update(`${email}:${code}`).digest('hex');
function safeHexEqual(a,b) { const aa=Buffer.from(String(a),'hex'), bb=Buffer.from(String(b),'hex'); return aa.length===bb.length && aa.length>0 && crypto.timingSafeEqual(aa,bb); }
async function audit(userId,event,details='') {
  await query('INSERT INTO audit_log(user_id,event,details) VALUES($1,$2,$3)',[userId || null,event,safeText(details,500)]);
}
async function freshUser(id) {
  const r=await query('SELECT id,email,name,role,school_id,student_id,active,teaching_subject,teaching_grades FROM users WHERE id=$1',[id]);
  return r.rows[0] || null;
}
const requireAuth = asyncRoute(async (req,res,next) => {
  const id=req.session?.user?.id;
  if (!id) return res.status(401).json({ message:'يلزم تسجيل الدخول.' });
  const user=await freshUser(id);
  if (!user || !user.active) {
    req.session.destroy(()=>{});
    return res.status(401).json({ message:'الحساب غير نشط.' });
  }
  req.user=user; next();
});
const requireRole = (...roles) => (req,res,next) => !req.user || !roles.includes(req.user.role)
  ? res.status(403).json({ message:'ليس لديك صلاحية لتنفيذ هذا الإجراء.' }) : next();
async function linkedStudentIds(user) {
  const r=await query('SELECT student_id FROM account_students WHERE user_id=$1 AND school_id=$2 ORDER BY student_id',[user.id,user.school_id]);
  return r.rows.map(x=>x.student_id);
}
async function assignedStudentIds(user) {
  const r=await query('SELECT student_id FROM teacher_students WHERE user_id=$1 AND school_id=$2 ORDER BY student_id',[user.id,user.school_id]);
  return r.rows.map(x=>x.student_id);
}
async function teacherTeachingAssignment(user) {
  const r=await query('SELECT teaching_subject,teaching_grades FROM users WHERE id=$1 AND school_id=$2',[user.id,user.school_id]);
  const row=r.rows[0] || {};
  return { subject:row.teaching_subject || '', grades:Array.isArray(row.teaching_grades)?row.teaching_grades:[] };
}
async function studentExistsInSchool(studentId,schoolId) {
  const r=await query("SELECT id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[schoolId,studentId]);
  return Boolean(r.rowCount);
}
async function findStudentOwnedBy(user,studentId) {
  const r=await query("SELECT id,owner_id,payload FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[user.school_id,studentId]);
  const record=r.rows[0]; if (!record) return null;
  if (user.role==='teacher') {
    if (String(record.owner_id)===String(user.id) || (await assignedStudentIds(user)).includes(studentId)) return record;
    const teaching=await teacherTeachingAssignment(user);
    if (teaching.grades.includes(String(record.payload?.grade || ''))) return record;
  }
  if (['senior_teacher','principal'].includes(user.role)) return record;
  return null;
}
async function getRecordsForUser(user) {
  if (['principal','senior_teacher'].includes(user.role)) {
    return (await query('SELECT id,kind,payload,created_at FROM records WHERE school_id=$1 ORDER BY id DESC LIMIT 1000',[user.school_id])).rows;
  }
  if (user.role==='teacher') {
    const [assigned,teaching]=await Promise.all([assignedStudentIds(user),teacherTeachingAssignment(user)]);
    if (teaching.grades.length) {
      const visibleStudents=(await query("SELECT payload->>'student_id' AS student_id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'grade'=ANY($2::text[])",[user.school_id,teaching.grades])).rows.map(x=>x.student_id);
      const visible=[...new Set([...assigned,...visibleStudents])];
      const r=await query(`SELECT id,kind,payload,created_at FROM records WHERE school_id=$1 AND
        ((owner_id=$2 AND (payload->>'student_id' IS NULL OR payload->>'student_id'=ANY($3::text[]))) OR
         kind IN ('shared_assessment','shared_intervention') OR payload->>'student_id'=ANY($3::text[]))
        ORDER BY id DESC LIMIT 800`,[user.school_id,user.id,visible]);
      return r.rows;
    }
    const r=await query(`SELECT id,kind,payload,created_at FROM records WHERE school_id=$1 AND
      (owner_id=$2 OR kind IN ('shared_assessment','shared_intervention') OR payload->>'student_id'=ANY($3::text[]))
      ORDER BY id DESC LIMIT 800`,[user.school_id,user.id,assigned]);
    return r.rows;
  }
  if (['parent','student'].includes(user.role)) {
    const ids=await linkedStudentIds(user); if (!ids.length) return [];
    return (await query(`SELECT id,kind,payload,created_at FROM records WHERE school_id=$1
      AND kind IN ('student','assessment','intervention','impact') AND payload->>'student_id'=ANY($2::text[])
      ORDER BY id DESC LIMIT 500`,[user.school_id,ids])).rows;
  }
  return [];
}
async function sessionLogin(req,res,user,extra={}) {
  req.session.regenerate(async err => {
    if (err) return res.status(500).json({ message:'تعذر إنشاء جلسة آمنة.' });
    req.session.user={ id:user.id };
    try {
      await audit(user.id,extra.demo ? 'demo.login':'login',user.role);
      const [linked,assigned,teaching]=await Promise.all([linkedStudentIds(user),assignedStudentIds(user),user.role==='teacher'?teacherTeachingAssignment(user):Promise.resolve({subject:'',grades:[]})]);
      res.json({ user:{ ...user,roleName:roleNames[user.role],linkedStudentIds:linked,assignedStudentIds:assigned,teachingSubject:teaching.subject,teachingGrades:teaching.grades,...(extra.demo ? {isDemo:true}:{}) }, ...(extra.warning ? {warning:extra.warning}:{}) });
    } catch(e) { res.status(500).json({ message:'تعذر إكمال تسجيل الدخول.' }); }
  });
}

app.get('/api/health',asyncRoute(async(req,res)=>{
  await query('SELECT 1');
  res.json({ ok:true,service:'athar-api',version:'3.0.0',database:'postgresql' });
}));
app.get('/api/auth/mode',(req,res)=>res.json({ mode:demoEnabled?'demo':'otp',otpAvailable:Boolean(transporter) }));
app.post('/api/auth/request-code',loginLimiter,asyncRoute(async(req,res)=>{
  const email=safeText(req.body?.email,254).toLowerCase();
  if (!emailAllowed(email)) return res.status(400).json({ message:'استخدم البريد الرسمي ضمن @moe.om أو @edu.moe.om.' });
  if (!transporter) return res.status(503).json({ message:'الدخول بالبريد غير مفعّل بعد؛ لم يتم إعداد خدمة البريد في الخادم.' });
  const found=await query('SELECT id,active FROM users WHERE email=$1',[email]);
  const user=found.rows[0];
  if (user?.active) {
    const code=String(crypto.randomInt(0,1000000)).padStart(6,'0'), now=Date.now();
    await query(`INSERT INTO otp_codes(email,code_hash,expires_at,attempts,created_at) VALUES($1,$2,$3,0,$4)
      ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,created_at=EXCLUDED.created_at`,
      [email,hashOtp(email,code),now+600000,now]);
    try {
      await transporter.sendMail({ from:process.env.MAIL_FROM || process.env.SMTP_USER,to:email,subject:'رمز التحقق — أثَر',text:`رمز التحقق للدخول إلى منصة أثَر هو: ${code}\nصالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.` });
    } catch(error) {
      await query('DELETE FROM otp_codes WHERE email=$1',[email]); console.error('OTP email delivery failed:',error);
      return res.status(502).json({ message:'تعذر إرسال رمز التحقق. تحقق من إعدادات البريد في الخادم.' });
    }
  }
  res.json({ message:'إذا كان البريد مسجلًا ومفعّلًا، فسيصلك رمز تحقق خلال لحظات.' });
}));
app.post('/api/auth/verify-code',loginLimiter,asyncRoute(async(req,res)=>{
  const email=safeText(req.body?.email,254).toLowerCase(), code=safeText(req.body?.code,6);
  if (!emailAllowed(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ message:'البريد أو رمز التحقق غير صالح.' });
  const row=(await query('SELECT * FROM otp_codes WHERE email=$1',[email])).rows[0];
  if (!row || Number(row.expires_at)<Date.now() || row.attempts>=5) {
    await query('DELETE FROM otp_codes WHERE email=$1',[email]);
    return res.status(401).json({ message:'انتهت صلاحية الرمز أو لم يعد صالحًا. اطلب رمزًا جديدًا.' });
  }
  if (!safeHexEqual(row.code_hash,hashOtp(email,code))) {
    await query('UPDATE otp_codes SET attempts=attempts+1 WHERE email=$1',[email]);
    return res.status(401).json({ message:'رمز التحقق غير صحيح.' });
  }
  await query('DELETE FROM otp_codes WHERE email=$1',[email]);
  const user=(await query('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE email=$1 AND active=TRUE',[email])).rows[0];
  if (!user) return res.status(401).json({ message:'الحساب غير مفعّل. راجع مسؤول النظام.' });
  await sessionLogin(req,res,user);
}));
async function ensureDemoFixtures() {
  const schoolId='DEMO-SCHOOL';
  const demoUsers=[['demo.teacher@athar.test','معلّم تجريبي','teacher'],['demo.senior@athar.test','معلم أول تجريبي','senior_teacher'],['demo.principal@athar.test','مدير تجريبي','principal'],['demo.parent@athar.test','ولي أمر تجريبي','parent'],['demo.student@athar.test','طالب تجريبي','student']];
  const users={};
  for (const [email,name,role] of demoUsers) {
    let user=(await query('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE email=$1',[email])).rows[0];
    if (!user) user=(await query('INSERT INTO users(email,name,role,school_id,student_id,active) VALUES($1,$2,$3,$4,NULL,TRUE) RETURNING id,email,name,role,school_id,student_id,active',[email,name,role,schoolId])).rows[0];
    if (!user.active || user.school_id!==schoolId || user.role!==role) throw new Error('Demo account configuration conflict.');
    users[role]=user;
  }
  // Stable synthetic learner shared only inside the isolated demo school.
  const studentId='ATHAR-DEMO-STUDENT-001';
  const teacher=users.teacher;
  const learnerExists=await query(
    "SELECT id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",
    [schoolId,studentId]
  );
  if (!learnerExists.rowCount) {
    await query(
      "INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,'student',$3::jsonb)",
      [schoolId,teacher.id,JSON.stringify({student_id:studentId,name:'طالب تجريبي',grade:'5',section:'أ'})]
    );
  }
  // Seed a small learning journey so parent/student dashboards have meaningful data.
  const demoLearningRecords=[
    ['assessment',{student_id:studentId,skill:'الفهم المقروء',pct:45,date:'2026-10-01',source:'demo'}],
    ['intervention',{student_id:studentId,title:'قراءة موجهة قصيرة',description:'تدريب يومي على تحديد الفكرة الرئيسة',status:'مستمرة',source:'demo'}],
    ['impact',{student_id:studentId,skill:'الفهم المقروء',before:45,after:70,change:25,date:'2026-10-15',source:'demo'}]
  ];
  for (const [kind,payload] of demoLearningRecords) {
    const exists=await query(
      "SELECT id FROM records WHERE school_id=$1 AND kind=$2 AND payload->>'student_id'=$3 AND payload->>'source'='demo' LIMIT 1",
      [schoolId,kind,studentId]
    );
    if (!exists.rowCount) {
      await query(
        'INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb)',
        [schoolId,teacher.id,kind,JSON.stringify(payload)]
      );
    }
  }
  await query(
    "UPDATE users SET student_id=$1 WHERE email='demo.student@athar.test' AND school_id=$2",
    [studentId,schoolId]
  );
  for (const role of ['parent','student']) {
    await query(
      'INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3) ON CONFLICT(user_id,student_id) DO NOTHING',
      [users[role].id,studentId,schoolId]
    );
  }
  await query(
    'INSERT INTO teacher_students(user_id,student_id,school_id) VALUES($1,$2,$3) ON CONFLICT(user_id,student_id) DO NOTHING',
    [teacher.id,studentId,schoolId]
  );
  return users;
}
app.post('/api/auth/demo',loginLimiter,asyncRoute(async(req,res)=>{
  if (!demoEnabled) return res.status(404).json({ message:'وضع الاختبار غير مفعّل.' });
  const role=safeText(req.body?.persona || 'teacher',32);
  if (!['teacher','senior_teacher','principal','parent','student'].includes(role)) return res.status(400).json({ message:'شخصية الاختبار غير معروفة.' });
  const users=await ensureDemoFixtures(), user=users[role];
  if (!user?.active) return res.status(403).json({ message:'حساب الاختبار غير نشط.' });
  await sessionLogin(req,res,user,{demo:true,warning:'وضع اختبار فقط مع بيانات اصطناعية في مدرسة معزولة. لا تستخدم بيانات حقيقية.'});
}));
app.get('/api/auth/me',requireAuth,asyncRoute(async(req,res)=>{
  const [linked,assigned,teaching]=await Promise.all([linkedStudentIds(req.user),assignedStudentIds(req.user),req.user.role==='teacher'?teacherTeachingAssignment(req.user):Promise.resolve({subject:'',grades:[]})]);
  res.json({ user:{...req.user,roleName:roleNames[req.user.role],linkedStudentIds:linked,assignedStudentIds:assigned,teachingSubject:teaching.subject,teachingGrades:teaching.grades,isDemo:req.user.school_id==='DEMO-SCHOOL'} });
}));
app.post('/api/auth/logout',requireAuth,asyncRoute(async(req,res)=>{
  await audit(req.user.id,'logout');
  req.session.destroy(()=>{ res.clearCookie('athar.sid'); res.json({ok:true}); });
}));
app.get('/api/records',requireAuth,asyncRoute(async(req,res)=>{
  const rows=await getRecordsForUser(req.user);
  res.json({ records:rows.map(row=>({...row,payload:row.payload})) });
}));
app.post('/api/records',recordLimiter,requireAuth,requireRole('teacher','senior_teacher','principal'),asyncRoute(async(req,res)=>{
  const kind=safeText(req.body?.kind,40), payload=req.body?.payload;
  if (!['student','assessment','intervention','impact'].includes(kind) || !payload || typeof payload!=='object' || Array.isArray(payload)) return res.status(400).json({message:'نوع السجل أو بياناته غير صالحة.'});
  const clean={...payload}; delete clean.school_id; delete clean.owner_id;
  if (kind==='student') {
    clean.student_id=safeText(clean.student_id,80); clean.name=safeText(clean.name,140);
    if (!clean.student_id || !clean.name) return res.status(400).json({message:'اسم الطالب ومعرّفه مطلوبان.'});
    if (await studentExistsInSchool(clean.student_id,req.user.school_id)) return res.status(409).json({message:'معرّف الطالب مستخدم بالفعل في المدرسة.'});
  } else if (clean.student_id) {
    clean.student_id=safeText(clean.student_id,80);
    if (!await findStudentOwnedBy(req.user,clean.student_id)) return res.status(403).json({message:'الطالب غير تابع لسجلاتك أو غير موجود في المدرسة.'});
  }
  if (JSON.stringify(clean).length>30000) return res.status(413).json({message:'حجم السجل أكبر من الحد المسموح.'});
  const saved=await query('INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[req.user.school_id,req.user.id,kind,JSON.stringify(clean)]);
  await audit(req.user.id,'record.create',kind);
  res.status(201).json({id:saved.rows[0].id,kind,payload:clean});
}));
app.post('/api/records/bulk',recordLimiter,requireAuth,requireRole('teacher','senior_teacher','principal'),asyncRoute(async(req,res)=>{
  const incoming=req.body?.records, permitted=new Set(['student','assessment','intervention','impact']);
  if (!Array.isArray(incoming) || incoming.length<1 || incoming.length>100) return res.status(400).json({message:'أرسل من 1 إلى 100 سجل في كل دفعة.'});
  const prepared=[], batchStudentIds=new Set();
  for (const item of incoming) {
    const kind=safeText(item?.kind,40), payload=item?.payload;
    if (!permitted.has(kind) || !payload || typeof payload!=='object' || Array.isArray(payload)) return res.status(400).json({message:'تحتوي الدفعة على نوع سجل أو بيانات غير صالحة.'});
    const clean={...payload}; delete clean.school_id; delete clean.owner_id; delete clean.recordId; delete clean.id;
    if (kind==='student') {
      clean.student_id=safeText(clean.student_id,80); clean.name=safeText(clean.name,140);
      if (!clean.student_id || !clean.name || batchStudentIds.has(clean.student_id) || await studentExistsInSchool(clean.student_id,req.user.school_id)) return res.status(409).json({message:'يوجد طالب مكرر أو سجل طالب ينقصه الاسم أو المعرّف.'});
      batchStudentIds.add(clean.student_id);
    } else if (clean.student_id) clean.student_id=safeText(clean.student_id,80);
    if (JSON.stringify(clean).length>30000) return res.status(413).json({message:'أحد السجلات أكبر من الحد المسموح.'});
    prepared.push({kind,payload:clean});
  }
  for (const item of prepared) if (item.kind!=='student' && item.payload.student_id && !batchStudentIds.has(item.payload.student_id) && !await findStudentOwnedBy(req.user,item.payload.student_id)) return res.status(403).json({message:'أحد السجلات مرتبط بطالب لا تملك صلاحية الوصول إليه.'});
  const created=await withTransaction(async client=>{
    const results=[], ordered=[...prepared.filter(x=>x.kind==='student'),...prepared.filter(x=>x.kind!=='student')];
    for (const item of ordered) {
      const r=await client.query('INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[req.user.school_id,req.user.id,item.kind,JSON.stringify(item.payload)]);
      results.push({id:r.rows[0].id,kind:item.kind});
    }
    return results;
  });
  await audit(req.user.id,'records.bulk_import',`count=${created.length}`);
  res.status(201).json({ok:true,count:created.length,records:created});
}));
app.put('/api/records/:id',recordLimiter,requireAuth,requireRole('teacher','senior_teacher','principal'),asyncRoute(async(req,res)=>{
  const id=Number(req.params.id);
  if (!Number.isSafeInteger(id) || id<=0) return res.status(400).json({message:'معرّف السجل غير صالح.'});
  const row=(await query('SELECT id,owner_id,school_id,kind,payload FROM records WHERE id=$1 AND school_id=$2',[id,req.user.school_id])).rows[0];
  if (!row || row.kind!=='intervention') return res.status(404).json({message:'التدخل غير موجود.'});
  if (req.user.role==='teacher' && String(row.owner_id)!==String(req.user.id)) {
    return res.status(403).json({message:'يمكنك تعديل التدخلات التي أنشأتها فقط.'});
  }
  const incoming=req.body?.payload;
  if (!incoming || typeof incoming!=='object' || Array.isArray(incoming)) return res.status(400).json({message:'بيانات التدخل غير صالحة.'});
  const current=row.payload || {};
  const skill=safeText(incoming.skill,180);
  const goal=safeText(incoming.goal,2000);
  const steps=safeText(incoming.steps,5000);
  if (!skill || !goal || !steps) return res.status(400).json({message:'المهارة والهدف وخطوات التدخل مطلوبة.'});
  const activityMode=['offline','shared','online'].includes(incoming.activity_mode) ? incoming.activity_mode : current.activity_mode || 'offline';
  const duration=Number(incoming.activity_duration ?? current.activity_duration ?? 15);
  if (![10,15,20].includes(duration)) return res.status(400).json({message:'مدة النشاط غير صالحة.'});
  const status=['active','completed','paused'].includes(incoming.status) ? incoming.status : current.status || 'active';
  const rawCurriculum=incoming.curriculum && typeof incoming.curriculum==='object' && !Array.isArray(incoming.curriculum)
    ? incoming.curriculum : current.curriculum || {};
  const curriculum={
    grade:safeText(rawCurriculum.grade,2) || null,
    subject:safeText(rawCurriculum.subject,120) || null,
    semester:safeText(rawCurriculum.semester,40) || null,
    unit:safeText(rawCurriculum.unit,160) || null,
    lesson:safeText(rawCurriculum.lesson,160) || null,
    learning_outcome:safeText(rawCurriculum.learning_outcome,1000) || null
  };
  const updated={
    ...current,
    skill,goal,steps,
    enrichment:safeText(incoming.enrichment,3000),
    observed_errors:safeText(incoming.observed_errors,2000),
    curriculum,
    activity_mode:activityMode,
    activity_duration:duration,
    status
  };
  const serialized=JSON.stringify(updated);
  if (serialized.length>30000) return res.status(413).json({message:'حجم السجل أكبر من الحد المسموح.'});
  const saved=await query("UPDATE records SET payload=$1::jsonb WHERE id=$2 AND school_id=$3 AND kind='intervention' RETURNING id",[serialized,id,req.user.school_id]);
  if (!saved.rowCount) return res.status(404).json({message:'التدخل غير موجود.'});
  await audit(req.user.id,'record.update','intervention');
  res.json({id:saved.rows[0].id,kind:'intervention',payload:updated});
}));
app.delete('/api/records/:id',requireAuth,requireRole('teacher','senior_teacher','principal'),asyncRoute(async(req,res)=>{
  const id=Number(req.params.id);
  if (!Number.isSafeInteger(id) || id<=0) return res.status(400).json({message:'معرّف السجل غير صالح.'});
  const row=(await query('SELECT id,owner_id,school_id,kind,payload FROM records WHERE id=$1 AND school_id=$2',[id,req.user.school_id])).rows[0];
  if (!row) return res.status(404).json({message:'السجل غير موجود.'});
  if (req.user.role==='teacher' && String(row.owner_id)!==String(req.user.id)) return res.status(403).json({message:'لا يمكنك حذف سجل لا تملكه.'});
  await withTransaction(async client=>{
    if (row.kind==='student') {
      const studentId=row.payload.student_id;
      const linked=await client.query('SELECT COUNT(*)::int AS n FROM account_students WHERE school_id=$1 AND student_id=$2',[req.user.school_id,studentId]);
      if (linked.rows[0].n) { const e=new Error('لا يمكن حذف الطالب قبل إزالة ربط حسابات ولي الأمر والطالب.'); e.status=409; throw e; }
      await client.query("DELETE FROM records WHERE school_id=$1 AND payload->>'student_id'=$2",[req.user.school_id,studentId]);
      await client.query('DELETE FROM teacher_students WHERE school_id=$1 AND student_id=$2',[req.user.school_id,studentId]);
    } else await client.query('DELETE FROM records WHERE id=$1 AND school_id=$2',[id,req.user.school_id]);
  });
  await audit(req.user.id,'record.delete',row.kind); res.json({ok:true});
}));
app.get('/api/users',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const [users,linked,assigned]=await Promise.all([
    query('SELECT id,email,name,role,school_id,active,created_at,teaching_subject,teaching_grades FROM users WHERE school_id=$1 ORDER BY name',[req.user.school_id]),
    query('SELECT user_id,student_id FROM account_students WHERE school_id=$1',[req.user.school_id]),
    query('SELECT user_id,student_id FROM teacher_students WHERE school_id=$1',[req.user.school_id])
  ]);
  const map=new Map(), assignmentMap=new Map();
  for (const x of linked.rows) map.set(String(x.user_id),[...(map.get(String(x.user_id))||[]),x.student_id]);
  for (const x of assigned.rows) assignmentMap.set(String(x.user_id),[...(assignmentMap.get(String(x.user_id))||[]),x.student_id]);
  res.json({users:users.rows.map(u=>({...u,teachingSubject:u.teaching_subject||'',teachingGrades:Array.isArray(u.teaching_grades)?u.teaching_grades:[],linkedStudentIds:map.get(String(u.id))||[],assignedStudentIds:assignmentMap.get(String(u.id))||[]}))});
}));
app.post('/api/users',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  if (req.user.school_id==='DEMO-SCHOOL') return res.status(403).json({message:'لا يمكن إنشاء حسابات مدرسية رسمية من بيئة الاختبار المعزولة.'});
  const email=safeText(req.body?.email,254).toLowerCase(), name=safeText(req.body?.name,140), role=safeText(req.body?.role,32);
  const studentIds=Array.isArray(req.body?.studentIds)?[...new Set(req.body.studentIds.map(v=>safeText(v,80)).filter(Boolean))]:[];
  const roles=['teacher','senior_teacher','principal','parent','student'];
  if (!emailAllowed(email)) return res.status(400).json({message:'يجب استخدام بريد رسمي من نطاقي الوزارة.'});
  if (!name || !roles.includes(role)) return res.status(400).json({message:'الاسم أو الدور غير صالح.'});
  if ((role==='parent' && !studentIds.length) || (role==='student' && studentIds.length!==1) || (['principal','senior_teacher'].includes(role)&&studentIds.length)) return res.status(400).json({message:'عدد الطلبة المرتبطين لا يتوافق مع الدور المحدد.'});
  for (const sid of studentIds) if (!await studentExistsInSchool(sid,req.user.school_id)) return res.status(400).json({message:'أحد الطلبة المحددين غير موجود في سجلات المدرسة.'});
  try {
    const id=await withTransaction(async client=>{
      const r=await client.query('INSERT INTO users(email,name,role,school_id,student_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[email,name,role,req.user.school_id,role==='student'?studentIds[0]:null]);
      const userId=r.rows[0].id;
      for (const sid of studentIds) {
        if (['parent','student'].includes(role)) await client.query('INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3)',[userId,sid,req.user.school_id]);
        if (role==='teacher') await client.query('INSERT INTO teacher_students(user_id,student_id,school_id) VALUES($1,$2,$3)',[userId,sid,req.user.school_id]);
      }
      return userId;
    });
    await audit(req.user.id,'user.create',role);
    res.status(201).json({ok:true,id,email,name,role,linkedStudentIds:['parent','student'].includes(role)?studentIds:[],assignedStudentIds:role==='teacher'?studentIds:[]});
  } catch(error) {
    if (error.code==='23505') return res.status(409).json({message:'هذا البريد مسجل مسبقًا.'});
    throw error;
  }
}));
app.put('/api/users/:id/assignments',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const targetId=Number(req.params.id), target=(await query('SELECT id,role,school_id FROM users WHERE id=$1 AND school_id=$2',[targetId,req.user.school_id])).rows[0];
  if (!target || target.role!=='teacher') return res.status(404).json({message:'حساب المعلم غير موجود في المدرسة.'});
  const ids=Array.isArray(req.body?.studentIds)?[...new Set(req.body.studentIds.map(v=>safeText(v,80)).filter(Boolean))]:[];
  for (const sid of ids) if (!await studentExistsInSchool(sid,req.user.school_id)) return res.status(400).json({message:'أحد الطلبة المحددين غير موجود في سجلات المدرسة.'});
  await withTransaction(async client=>{
    await client.query('DELETE FROM teacher_students WHERE user_id=$1 AND school_id=$2',[targetId,req.user.school_id]);
    for (const sid of ids) await client.query('INSERT INTO teacher_students(user_id,student_id,school_id) VALUES($1,$2,$3)',[targetId,sid,req.user.school_id]);
  });
  await audit(req.user.id,'user.assignments.update',String(targetId)); res.json({ok:true,userId:targetId,assignedStudentIds:ids});
}));
app.put('/api/users/:id/teaching-assignment',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const targetId=Number(req.params.id), target=(await query("SELECT id,role,school_id FROM users WHERE id=$1 AND school_id=$2",[targetId,req.user.school_id])).rows[0];
  if (!target || target.role!=='teacher') return res.status(404).json({message:'حساب المعلم غير موجود في المدرسة.'});
  const subject=safeText(req.body?.subject,120);
  const grades=Array.isArray(req.body?.grades)?[...new Set(req.body.grades.map(v=>safeText(v,20)).filter(Boolean))].slice(0,12):[];
  if (!subject || !grades.length) return res.status(400).json({message:'حدد مادة واحدة وصفًا واحدًا على الأقل.'});
  await query('UPDATE users SET teaching_subject=$1,teaching_grades=$2::text[] WHERE id=$3 AND school_id=$4',[subject,grades,targetId,req.user.school_id]);
  await audit(req.user.id,'user.teaching_assignment.update',`${target.role}:${targetId}:${subject}:${grades.join(',')}`);
  res.json({ok:true,userId:targetId,teachingSubject:subject,teachingGrades:grades});
}));
app.put('/api/users/:id/student-links',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const targetId=Number(req.params.id), target=(await query('SELECT id,role,school_id FROM users WHERE id=$1 AND school_id=$2',[targetId,req.user.school_id])).rows[0];
  if (!target || !['parent','student'].includes(target.role)) return res.status(404).json({message:'حساب الطالب أو ولي الأمر غير موجود في المدرسة.'});
  const ids=Array.isArray(req.body?.studentIds)?[...new Set(req.body.studentIds.map(v=>safeText(v,80)).filter(Boolean))]:[];
  if ((target.role==='student'&&ids.length!==1)||(target.role==='parent'&&!ids.length)) return res.status(400).json({message:'عدد الطلبة المرتبطين لا يتوافق مع الدور المحدد.'});
  for (const sid of ids) if (!await studentExistsInSchool(sid,req.user.school_id)) return res.status(400).json({message:'أحد الطلبة المحددين غير موجود في سجلات المدرسة.'});
  await withTransaction(async client=>{
    await client.query('DELETE FROM account_students WHERE user_id=$1 AND school_id=$2',[targetId,req.user.school_id]);
    for (const sid of ids) await client.query('INSERT INTO account_students(user_id,student_id,school_id) VALUES($1,$2,$3)',[targetId,sid,req.user.school_id]);
    await client.query('UPDATE users SET student_id=$1 WHERE id=$2 AND school_id=$3',[target.role==='student'?ids[0]:null,targetId,req.user.school_id]);
  });
  await audit(req.user.id,'user.student_links.update',`${target.role}:${targetId}`);
  res.json({ok:true,userId:targetId,linkedStudentIds:ids});
}));

const skillMap=[
 {keys:['تمثيل الكسور','الكسور','كسر','البسط','المقام'],title:'تمثيل الكسور',prerequisites:['الجزء والكل','معرفة البسط والمقام'],next:['مقارنة الكسور','العمليات على الكسور'],strategies:['استخدم شرائط الكسور والأشكال المقسمة لربط الجزء بالكل.','اطلب من الطالب تسمية البسط والمقام قبل تمثيل الكسر.','قدّم سؤال تحقق قصيرًا بعد كل مثال.']},
 {keys:['العمليات على الكسور','جمع الكسور','طرح الكسور'],title:'العمليات على الكسور',prerequisites:['تمثيل الكسور','الكسور المتكافئة'],next:['حل المسائل اللفظية على الكسور'],strategies:['راجع تمثيل الكسر بصريًا قبل الانتقال إلى الخوارزمية.','استخدم نماذج متكافئة للمقامات.','درّب الطالب على تفسير سبب اختيار العملية.']},
 {keys:['الفهم المقروء','فهم المقروء','الفهم القرائي','القراءة'],title:'الفهم المقروء',prerequisites:['الطلاقة القرائية','المفردات والسياق'],next:['الفكرة الرئيسة','الاستدلال من النص'],strategies:['استخدم نصوصًا قصيرة متعددة المستويات.','درّب الطلبة على تحديد الدليل النصي.','اطلب إعادة صياغة الفكرة بكلمات الطالب.']},
 {keys:['الفكرة الرئيسة','الفكرة الرئيسية'],title:'الفكرة الرئيسة',prerequisites:['المفردات والسياق','الفهم المقروء'],next:['التلخيص','الاستدلال من النص'],strategies:['استخدم عناوين وصورًا متوقعة قبل القراءة.','ميّز بين الفكرة الرئيسة والتفاصيل الداعمة.','اطلب اختيار عنوان مناسب مع ذكر الدليل.']},
 {keys:['الاستدلال','الاستنتاج'],title:'الاستدلال من النص',prerequisites:['الفهم المقروء','المفردات والسياق'],next:['التفسير النقدي'],strategies:['استخدم أسئلة لماذا وكيف مع مطالبة الطالب بالدليل.','اعرض قرائن متفرقة واطلب ربطها.','ناقش أكثر من احتمال قبل اختيار الاستنتاج.']}
];
const normalizeArabic=value=>safeText(value,160).toLowerCase().replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/[ًٌٍَُِّْـ]/g,'').trim();
function findSkill(skill) {
  const key=normalizeArabic(skill);
  const matches=skillMap.flatMap(item=>item.keys.filter(k=>key.includes(normalizeArabic(k))||normalizeArabic(k).includes(key)).map(k=>({item,length:normalizeArabic(k).length})));
  matches.sort((a,b)=>b.length-a.length); return matches[0]?.item || null;
}
async function analyzeLearning(user,body) {
  const skill=safeText(body.skill||body.question,160)||'مهارة غير محددة', studentId=safeText(body.student_id,80);
  if (studentId && !await findStudentOwnedBy(user,studentId)) throw Object.assign(new Error('الطالب غير تابع لسجلاتك أو غير موجود في المدرسة.'),{status:403});
  let rows;
  if (['principal','senior_teacher'].includes(user.role)) rows=(await query("SELECT payload FROM records WHERE school_id=$1 AND kind='assessment' ORDER BY id DESC LIMIT 1000",[user.school_id])).rows;
  else {
    const assigned=user.role==='teacher'?await assignedStudentIds(user):[];
    rows=(await query(`SELECT payload FROM records WHERE school_id=$1 AND kind='assessment' AND (owner_id=$2 OR payload->>'student_id'=ANY($3::text[])) ORDER BY id DESC LIMIT 800`,[user.school_id,user.id,assigned])).rows;
  }
  let assessments=rows.map(r=>r.payload);
  if (studentId) assessments=assessments.filter(a=>a.student_id===studentId);
  const mapped=findSkill(skill), targetSkill=normalizeArabic(mapped?.title||skill);
  // Compare canonical skill names so aliases such as فهم المقروء / الفهم القرائي match.
  const canonicalSkill=value=>normalizeArabic(findSkill(value)?.title||value);
  const matches=(record,target)=>{const s=canonicalSkill(record.skill||record.name||''),t=canonicalSkill(target);return Boolean(s&&t&&(s===t||s.includes(t)||t.includes(s)));};
  const latestPerLearner=records=>{
    const groups=new Map();
    for(const record of records){const key=record.student_id||`class:${record.grade||''}:${record.section||''}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}
    return [...groups.values()].map(items=>items.slice(0,2));
  };
  const history=latestPerLearner(assessments.filter(a=>matches(a,targetSkill)));
  const scores=history.map(x=>Number(x[0]?.pct)).filter(Number.isFinite);
  const targetScore=scores.length?Number((scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1)):null;
  const changes=history.filter(x=>x.length>1&&Number.isFinite(Number(x[0].pct))&&Number.isFinite(Number(x[1].pct))).map(x=>Number(x[0].pct)-Number(x[1].pct));
  const trend=changes.length?Number((changes.reduce((a,b)=>a+b,0)/changes.length).toFixed(1)):null;
  const prerequisiteEvidence=(mapped?.prerequisites||[]).map(name=>{
    const h=latestPerLearner(assessments.filter(a=>matches(a,normalizeArabic(name))));
    const values=h.map(x=>Number(x[0]?.pct)).filter(Number.isFinite);
    return {skill:name,score:values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(1)):null,sampleSize:values.length};
  });
  const likelyRoots=prerequisiteEvidence.filter(x=>x.score!==null&&x.score<70);
  const strategies=mapped?.strategies||['ابدأ بتقويم تشخيصي قصير يحدد نوع الخطأ.','قسّم المهارة إلى خطوات أصغر، ثم قدّم نموذجًا محلولًا.','استخدم سؤال تحقق مستقلًا بعد النشاط.'];
  const recommendations=targetScore===null?['أدخل نتيجة تقويم لهذه المهارة أولًا.','نفّذ تقويمًا قصيرًا للمهارات السابقة لتحديد جذر الفجوة.']:targetScore<70?strategies:['قدّم نشاطًا تطبيقيًا للتحقق من ثبات الإتقان.','انتقل تدريجيًا إلى المهارات اللاحقة دون إلغاء المراجعة.'];
  const evidence=[];
  if(targetScore!==null)evidence.push(`آخر نتيجة مسجلة للمهارة ${targetScore}%.`);
  if(trend!==null)evidence.push(`التغير عن التقويم السابق ${trend>0?'+':''}${trend} نقطة مئوية.`);
  if(likelyRoots.length)evidence.push(`ظهرت فجوة في مهارات سابقة: ${likelyRoots.map(x=>`${x.skill} (${x.score}%)`).join('، ')}.`);
  if(!likelyRoots.length&&prerequisiteEvidence.length)evidence.push('لا توجد نتائج منخفضة مسجلة للمهارات السابقة ضمن البيانات المتاحة؛ يُنصح بالتأكد منها بتقويم تشخيصي عند الحاجة.');
  if(!studentId&&scores.length)evidence.push(`احتُسب متوسط المهارة من أحدث نتيجة لكل طالب/مجموعة؛ عدد السجلات الممثلة: ${scores.length}.`);
  if(safeText(body.observedErrors,1000))evidence.push(`ملاحظة المعلم: ${safeText(body.observedErrors,1000)}`);
  return {skill:mapped?.title||skill,level:targetScore===null?'لا تتوفر نتائج كافية':targetScore<50?'تعثر مرتفع':targetScore<70?'يحتاج إلى دعم':targetScore<85?'قريب من الإتقان':'متقن',targetScore,trend,sampleSize:scores.length,likelyRoots,prerequisiteEvidence,nextSkills:mapped?.next||[],evidence,recommendations,disclaimer:'تحليل مساند مبني على السجلات المتاحة وخريطة مهارات أولية؛ لا يمثل تشخيصًا نهائيًا، ويعتمد القرار على مراجعة المعلم.'};
}

const aiAnalysisLimiter = rateLimit({ windowMs:60*1000, limit:8, standardHeaders:true, legacyHeaders:false, message:{message:'تم الوصول إلى حد التحليل الذكي المؤقت. حاول بعد قليل.'} });
function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  for (const item of payload?.output || []) {
    for (const part of item?.content || []) if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
  }
  return '';
}
async function generateTeachingAI(analysis, observedErrors, body) {
  const provider=(process.env.AI_PROVIDER || (process.env.GROQ_API_KEY?'groq':process.env.OPENAI_API_KEY?'openai':'')).toLowerCase();
  if (!provider || (provider==='groq'&&!process.env.GROQ_API_KEY) || (provider==='openai'&&!process.env.OPENAI_API_KEY)) return {status:'not_configured'};
  if (!['groq','openai'].includes(provider)) throw new Error('AI_PROVIDER must be groq or openai.');
  const evidenceOnly = {
    skill:analysis.skill,
    level:analysis.level,
    targetScore:analysis.targetScore,
    trend:analysis.trend,
    sampleSize:analysis.sampleSize,
    prerequisiteEvidence:analysis.prerequisiteEvidence,
    nextSkills:analysis.nextSkills,
    recommendations:analysis.recommendations,
    teacherObservation:safeText(observedErrors,1000),
    grade:safeText(body.grade,30),
    subject:safeText(body.subject,80),
    lesson:safeText(body.lesson,120),
    classSize:safeText(body.class_size,10),
    deliveryMode:['offline','shared','digital'].includes(body.delivery_mode)?body.delivery_mode:'shared'
  };
  const instructions='أنت مساعد تربوي للمعلم في سلطنة عُمان. حلّل بيانات التعلم المقدمة فقط. لا تخترع نتائج أو أدلة أو بيانات منهجية. فرّق بوضوح بين الدليل والفرضية، ولا تصف أي جذر بأنه سبب مؤكد ما لم تدعمه نتائج مباشرة. لا تشخّص الطالب ولا تصدر أحكامًا عليه. اقترح إجراءات صفية قابلة للتنفيذ في صف كبير، مع بدائل دون أجهزة أو باستخدام جهاز المعلم/الشاشة المشتركة. اجعل المعلم صاحب القرار. أخرج JSON صالحًا باللغة العربية بالمفاتيح: errorPattern (string), possibleRoots (array of objects {skill:string,evidence:string,confidence:string}), teacherChecks (array of strings), differentiated (object {support:string,expected:string,enrichment:string}), nextCheck (string), cautions (array of strings).';
  const userPrompt=`حلّل هذه البيانات التعليمية المجمّعة والمجرّدة من أسماء الطلبة ومعرّفاتهم، وأعد JSON فقط:\n${JSON.stringify(evidenceOnly)}`;
  const endpoint=provider==='groq'?'https://api.groq.com/openai/v1/chat/completions':'https://api.openai.com/v1/responses';
  const headers={'Authorization':`Bearer ${provider==='groq'?process.env.GROQ_API_KEY:process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'};
  const requestBody=provider==='groq'?{
    model:process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    messages:[{role:'system',content:instructions},{role:'user',content:userPrompt}],
    response_format:{type:'json_object'},
    max_tokens:1200,
    temperature:0.2
  }:{
    model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    store:false,
    max_output_tokens:1200,
    instructions,
    input:userPrompt,
    text:{format:{type:'json_object'}}
  };
  const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify(requestBody)});
  if (!response.ok) {
    const errorBody=await response.text();
    throw new Error(`${provider} API ${response.status}: ${errorBody.slice(0,500)}`);
  }
  const payload=await response.json();
  const raw=provider==='groq'?payload?.choices?.[0]?.message?.content:extractResponseText(payload);
  if (typeof raw!=='string' || !raw.trim()) throw new Error('لم تُرجع خدمة الذكاء الاصطناعي نصًا قابلًا للقراءة.');
  const parsed=JSON.parse(raw);
  const list=value=>Array.isArray(value)?value.map(x=>safeText(x,500)).filter(Boolean).slice(0,6):[];
  const roots=Array.isArray(parsed.possibleRoots)?parsed.possibleRoots.slice(0,5).map(x=>({
    skill:safeText(x?.skill,120),
    evidence:safeText(x?.evidence,400),
    confidence:['منخفضة','متوسطة','مرتفعة'].includes(x?.confidence)?x.confidence:'غير محددة'
  })).filter(x=>x.skill):[];
  return {
    status:'ok',
    provider:provider==='groq'?'Groq':'OpenAI API',
    errorPattern:safeText(parsed.errorPattern,700),
    possibleRoots:roots,
    teacherChecks:list(parsed.teacherChecks),
    differentiated:{
      support:safeText(parsed.differentiated?.support,700),
      expected:Number.isFinite(Number(analysis.targetScore))
        ? `المستوى المستهدف: رفع الإتقان من ${Number(analysis.targetScore)}% إلى 70% على الأقل خلال أسبوعين، ويُتحقق منه بقياس بعدي.`
        : 'يُحدَّد المستوى المتوقع بعد تنفيذ تقويم تشخيصي قصير واعتماد خط أساس واضح.',
      enrichment:safeText(parsed.differentiated?.enrichment,700)
    },
    nextCheck:safeText(parsed.nextCheck,500),
    cautions:list(parsed.cautions),
    disclaimer:'مقترحات مولّدة آليًا من بيانات مجمّعة وملاحظة المعلم؛ ليست تشخيصًا ولا تثبت السببية. راجعها وعدّلها قبل التطبيق.'
  };
}
app.post('/api/analysis',requireAuth,requireRole('teacher','senior_teacher','principal'),aiAnalysisLimiter,asyncRoute(async(req,res)=>{
  try {
    const requestBody=req.body||{};
    const result=await analyzeLearning(req.user,requestBody), studentId=safeText(requestBody.student_id,80)||null;
    let aiAssist={status:'not_configured'};
    try { aiAssist=await generateTeachingAI(result,requestBody.observedErrors,requestBody); }
    catch(error) { console.error('Teaching AI unavailable:',error.message); aiAssist={status:'unavailable',message:'تعذر إكمال التحليل الذكي الآن؛ ما زال التحليل القائم على نتائج التقويم متاحًا.'}; }
    const saved=await query('INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[req.user.school_id,req.user.id,'analysis',JSON.stringify({student_id:studentId,skill:result.skill,result,aiAssist,date:new Date().toISOString()})]);
    await audit(req.user.id,'learning.analysis',result.skill);
    res.json({analysis:result,aiAssist,id:saved.rows[0].id});
  } catch(error) { res.status(error.status||500).json({message:error.status?error.message:'تعذر تحليل البيانات.'}); }
}));
app.use((error,req,res,next)=>{
  console.error(error);
  if(res.headersSent)return next(error);
  if(error.code==='23505')return res.status(409).json({message:'يوجد سجل مكرر.'});
  res.status(error.status||500).json({message:error.status?error.message:'حدث خطأ داخلي. راجع سجل الخادم.'});
});
await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS teaching_subject TEXT');
await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS teaching_grades TEXT[] NOT NULL DEFAULT '{}'::text[]");
const server=app.listen(port,()=>console.log(`ATHAR API PostgreSQL v3 listening on ${port}`));
async function shutdown(signal) {
  console.log(`${signal}: closing ATHAR API`);
  server.close(async()=>{try{await pool.end();process.exit(0);}catch(error){console.error(error);process.exit(1);}});
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

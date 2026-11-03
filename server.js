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
  const r=await query('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE id=$1',[id]);
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
async function studentExistsInSchool(studentId,schoolId) {
  const r=await query("SELECT id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[schoolId,studentId]);
  return Boolean(r.rowCount);
}
async function findStudentOwnedBy(user,studentId) {
  const r=await query("SELECT id,owner_id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[user.school_id,studentId]);
  const record=r.rows[0]; if (!record) return null;
  if (user.role==='teacher' && (String(record.owner_id)===String(user.id) || (await assignedStudentIds(user)).includes(studentId))) return record;
  if (['senior_teacher','principal'].includes(user.role)) return record;
  return null;
}
async function getRecordsForUser(user) {
  if (['principal','senior_teacher'].includes(user.role)) {
    return (await query('SELECT id,kind,payload,created_at FROM records WHERE school_id=$1 ORDER BY id DESC LIMIT 1000',[user.school_id])).rows;
  }
  if (user.role==='teacher') {
    const assigned=await assignedStudentIds(user);
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
      const [linked,assigned]=await Promise.all([linkedStudentIds(user),assignedStudentIds(user)]);
      res.json({ user:{ ...user,roleName:roleNames[user.role],linkedStudentIds:linked,assignedStudentIds:assigned,...(extra.demo ? {isDemo:true}:{}) }, ...(extra.warning ? {warning:extra.warning}:{}) });
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
  await query("UPDATE users SET student_id=NULL WHERE email='demo.student@athar.test'");
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
  const [linked,assigned]=await Promise.all([linkedStudentIds(req.user),assignedStudentIds(req.user)]);
  res.json({ user:{...req.user,roleName:roleNames[req.user.role],linkedStudentIds:linked,assignedStudentIds:assigned,isDemo:req.user.school_id==='DEMO-SCHOOL'} });
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
    query('SELECT id,email,name,role,school_id,active,created_at FROM users WHERE school_id=$1 ORDER BY name',[req.user.school_id]),
    query('SELECT user_id,student_id FROM account_students WHERE school_id=$1',[req.user.school_id]),
    query('SELECT user_id,student_id FROM teacher_students WHERE school_id=$1',[req.user.school_id])
  ]);
  const map=new Map(), assignmentMap=new Map();
  for (const x of linked.rows) map.set(String(x.user_id),[...(map.get(String(x.user_id))||[]),x.student_id]);
  for (const x of assigned.rows) assignmentMap.set(String(x.user_id),[...(assignmentMap.get(String(x.user_id))||[]),x.student_id]);
  res.json({users:users.rows.map(u=>({...u,linkedStudentIds:map.get(String(u.id))||[],assignedStudentIds:assignmentMap.get(String(u.id))||[]}))});
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
 {keys:['الفهم القرائي','القراءة','فهم المقروء'],title:'الفهم القرائي',prerequisites:['الطلاقة القرائية','المفردات والسياق'],next:['الفكرة الرئيسة','الاستدلال من النص'],strategies:['استخدم نصوصًا قصيرة متعددة المستويات.','درّب الطلبة على تحديد الدليل النصي.','اطلب إعادة صياغة الفكرة بكلمات الطالب.']},
 {keys:['الفكرة الرئيسة','الفكرة الرئيسية'],title:'الفكرة الرئيسة',prerequisites:['المفردات والسياق','الفهم القرائي'],next:['التلخيص','الاستدلال من النص'],strategies:['استخدم عناوين وصورًا متوقعة قبل القراءة.','ميّز بين الفكرة الرئيسة والتفاصيل الداعمة.','اطلب اختيار عنوان مناسب مع ذكر الدليل.']},
 {keys:['الاستدلال','الاستنتاج'],title:'الاستدلال من النص',prerequisites:['الفهم القرائي','المفردات والسياق'],next:['التفسير النقدي'],strategies:['استخدم أسئلة لماذا وكيف مع مطالبة الطالب بالدليل.','اعرض قرائن متفرقة واطلب ربطها.','ناقش أكثر من احتمال قبل اختيار الاستنتاج.']}
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
  const matches=(record,target)=>{const s=normalizeArabic(record.skill||record.name||'');return Boolean(s&&target&&(s.includes(target)||target.includes(s)));};
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
app.post('/api/analysis',requireAuth,requireRole('teacher','senior_teacher','principal'),asyncRoute(async(req,res)=>{
  try {
    const result=await analyzeLearning(req.user,req.body||{}), studentId=safeText(req.body?.student_id,80)||null;
    const saved=await query('INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[req.user.school_id,req.user.id,'analysis',JSON.stringify({student_id:studentId,skill:result.skill,result,date:new Date().toISOString()})]);
    await audit(req.user.id,'learning.analysis',result.skill); res.json({analysis:result,id:saved.rows[0].id});
  } catch(error) { res.status(error.status||500).json({message:error.status?error.message:'تعذر تحليل البيانات.'}); }
}));
app.use((error,req,res,next)=>{
  console.error(error);
  if(res.headersSent)return next(error);
  if(error.code==='23505')return res.status(409).json({message:'يوجد سجل مكرر.'});
  res.status(error.status||500).json({message:error.status?error.message:'حدث خطأ داخلي. راجع سجل الخادم.'});
});
const server=app.listen(port,()=>console.log(`ATHAR API PostgreSQL v3 listening on ${port}`));
async function shutdown(signal) {
  console.log(`${signal}: closing ATHAR API`);
  server.close(async()=>{try{await pool.end();process.exit(0);}catch(error){console.error(error);process.exit(1);}});
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

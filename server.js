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
const roleNames = { teacher:'المعلم', senior_teacher:'المعلم الأول', principal:'المدير', supervisor:'المشرف التربوي', parent:'ولي الأمر', student:'الطالب' };
const demoEnabled = process.env.DEMO_LOGIN_ENABLED === 'true';
let otpExpiryUsesTimestamp = false;
let otpCreatedUsesTimestamp = false;
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
  cookie:{ httpOnly:true, secure:production, sameSite:process.env.COOKIE_SAMESITE || (production ? 'none':'lax'), partitioned:production, maxAge:8*60*60*1000 }
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
  const r=await query('SELECT subject,grade,sections FROM teacher_teaching_assignments WHERE user_id=$1 AND school_id=$2 ORDER BY subject,grade',[user.id,user.school_id]);
  if (r.rows.length) return { assignments:r.rows.map(row=>({subject:row.subject,grade:String(row.grade),sections:Array.isArray(row.sections)?row.sections:[]})) };
  const legacy=await query('SELECT teaching_subject,teaching_grades FROM users WHERE id=$1 AND school_id=$2',[user.id,user.school_id]);
  const row=legacy.rows[0] || {};
  return { assignments:(Array.isArray(row.teaching_grades)?row.teaching_grades:[]).map(grade=>({subject:row.teaching_subject||'',grade:String(grade),sections:[]})).filter(item=>item.subject) };
}
function teacherAssignmentMatches(assignments, student) {
  const grade=String(student?.grade ?? '').trim();
  const section=String(student?.section ?? '').trim();
  return (assignments||[]).some(item=>assignedGradeLabels([item.grade]).includes(grade) && (!item.sections?.length || item.sections.map(String).includes(section)));
}
async function validateStudentPlacement(user,gradeValue,sectionValue) {
  const gradeNames={'الأول':'1','الاول':'1','الثاني':'2','الثالث':'3','الرابع':'4','الخامس':'5','السادس':'6','السابع':'7','الثامن':'8','التاسع':'9','العاشر':'10','الحادي عشر':'11','الثاني عشر':'12'};
  const rawGrade=String(gradeValue||'').trim().replace(/^الصف\\s*/,'');
  const grade=/^(?:[1-9]|1[0-2])$/.test(rawGrade)?rawGrade:(gradeNames[rawGrade]||'');
  const section=String(sectionValue||'').trim();
  const config=(await query('SELECT section_count FROM school_grade_sections WHERE school_id=$1 AND grade=$2',[user.school_id,grade])).rows[0];
  if(!config)throw Object.assign(new Error('لم يحدد المدير إعداد الصف وعدد شعبه بعد.'),{status:403});
  const allowed=new Set(Array.from({length:Number(config.section_count)},(_,i)=>String(i+1)));
  if(!allowed.has(section))throw Object.assign(new Error('هذه الشعبة غير معتمدة من المدير لهذا الصف.'),{status:403});
  if(user.role==='teacher'){
    const teaching=await teacherTeachingAssignment(user);
    const permitted=teaching.assignments.some(item=>assignedGradeLabels([item.grade]).includes(String(gradeValue).trim())&&(!item.sections?.length||item.sections.includes(section)));
    if(!permitted)throw Object.assign(new Error('لا يمكنك تسجيل طلبة خارج الصفوف والشعب المسندة إليك.'),{status:403});
  }
}
async function studentExistsInSchool(studentId,schoolId) {
  const r=await query("SELECT id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[schoolId,studentId]);
  return Boolean(r.rowCount);
}
function assignedGradeLabels(grades) {
  const labels={1:'الأول',2:'الثاني',3:'الثالث',4:'الرابع',5:'الخامس',6:'السادس',7:'السابع',8:'الثامن',9:'التاسع',10:'العاشر',11:'الحادي عشر',12:'الثاني عشر'};
  return [...new Set((grades || []).flatMap(value => {
    const number=String(value);
    return labels[number] ? [number,labels[number],`الصف ${labels[number]}`] : [number];
  }))];
}
async function findStudentOwnedBy(user,studentId) {
  const r=await query("SELECT id,owner_id,payload FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[user.school_id,studentId]);
  const record=r.rows[0]; if (!record) return null;
  if (user.role==='teacher') {
    if (String(record.owner_id)===String(user.id) || (await assignedStudentIds(user)).includes(studentId)) return record;
    const teaching=await teacherTeachingAssignment(user);
    if (teacherAssignmentMatches(teaching.assignments,record.payload)) return record;
  }
  if (['senior_teacher','principal'].includes(user.role)) return record;
  return null;
}
async function getRecordsForUser(user) {
  if (user.role==='supervisor') {
    // Supervisors use the aggregate school and recommendation endpoints only.
    // Do not expose identifiable student, assessment, or intervention records.
    return [];
  }
  if (['principal','senior_teacher'].includes(user.role)) {
    return (await query('SELECT id,kind,payload,created_at FROM records WHERE school_id=$1 ORDER BY id DESC LIMIT 1000',[user.school_id])).rows;
  }
  if (user.role==='teacher') {
    const [assigned,teaching,studentRows]=await Promise.all([
      assignedStudentIds(user),
      teacherTeachingAssignment(user),
      query("SELECT payload FROM records WHERE school_id=$1 AND kind='student'",[user.school_id])
    ]);
    const visibleStudents=studentRows.rows.filter(row=>teacherAssignmentMatches(teaching.assignments,row.payload)).map(row=>String(row.payload?.student_id||'')).filter(Boolean);
    const visible=[...new Set([...assigned,...visibleStudents])];
    if (visible.length) {
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
      const [linked,assigned,teaching]=await Promise.all([linkedStudentIds(user),assignedStudentIds(user),user.role==='teacher'?teacherTeachingAssignment(user):Promise.resolve({assignments:[]})]);
      const assignments=teaching.assignments||[];
      res.json({ user:{ ...user,roleName:roleNames[user.role],linkedStudentIds:linked,assignedStudentIds:assigned,teachingAssignments:assignments,teachingSubjects:[...new Set(assignments.map(x=>x.subject))],teachingGrades:[...new Set(assignments.map(x=>x.grade))],...(extra.demo ? {isDemo:true}:{}) }, ...(extra.warning ? {warning:extra.warning}:{}) });
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
    const expiresAt=otpExpiryUsesTimestamp?new Date(now+600000):now+600000;
    const createdAt=otpCreatedUsesTimestamp?new Date(now):now;
    await query(`INSERT INTO otp_codes(email,code_hash,expires_at,attempts,created_at) VALUES($1,$2,$3,0,$4)
      ON CONFLICT(email) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,attempts=0,created_at=EXCLUDED.created_at`,
      [email,hashOtp(email,code),expiresAt,createdAt]);
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
  const expiresAtMs=row?.expires_at instanceof Date?row.expires_at.getTime():(Number.isFinite(Number(row?.expires_at))?Number(row.expires_at):Date.parse(row?.expires_at));
  if (!row || !Number.isFinite(expiresAtMs) || expiresAtMs<Date.now() || row.attempts>=5) {
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
  const demoUsers=[
    ['demo.teacher@athar.test','معلّم تجريبي','teacher'],
    ['demo.senior@athar.test','معلم أول تجريبي','senior_teacher'],
    ['demo.principal@athar.test','مدير تجريبي','principal'],
    ['demo.supervisor@athar.test','مشرف تربوي تجريبي','supervisor'],
    ['demo.parent@athar.test','ولي أمر تجريبي','parent'],
    ['demo.student@athar.test','طالب تجريبي','student']
  ];
  const users={};
  for (const [email,name,role] of demoUsers) {
    let user=(await query('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE email=$1',[email])).rows[0];
    if (!user) user=(await query('INSERT INTO users(email,name,role,school_id,student_id,active) VALUES($1,$2,$3,$4,NULL,TRUE) RETURNING id,email,name,role,school_id,student_id,active',[email,name,role,schoolId])).rows[0];
    if (!user.active || user.school_id!==schoolId || user.role!==role) throw new Error('Demo account configuration conflict.');
    users[role]=user;
  }

  // Give the isolated demo school a consistent numeric section setup.
  for (let grade=1;grade<=12;grade++) {
    await query('INSERT INTO school_grade_sections(school_id,grade,section_count) VALUES($1,$2,1) ON CONFLICT(school_id,grade) DO NOTHING',[schoolId,String(grade)]);
  }

  const supervisor=users.supervisor;
  await query(
    'INSERT INTO supervisor_schools(user_id,school_id,school_name) VALUES($1,$2,$3) ON CONFLICT(user_id,school_id) DO UPDATE SET school_name=EXCLUDED.school_name',
    [supervisor.id,'DEMO-SCHOOL','مدرسة أثَر التجريبية الأولى']
  );
  await query(
    'INSERT INTO supervisor_schools(user_id,school_id,school_name) VALUES($1,$2,$3) ON CONFLICT(user_id,school_id) DO UPDATE SET school_name=EXCLUDED.school_name',
    [supervisor.id,'DEMO-SCHOOL-2','مدرسة أثَر التجريبية الثانية']
  );
  await query(
    "INSERT INTO records(school_id,owner_id,kind,payload) SELECT $1,$2,'student',$3::jsonb WHERE NOT EXISTS (SELECT 1 FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$4)",
    ['DEMO-SCHOOL-2',supervisor.id,JSON.stringify({student_id:'ATHAR-DEMO-STUDENT-002',name:'طالبة تجريبية',grade:'6',section:'1',source:'demo'}),'ATHAR-DEMO-STUDENT-002']
  );
  await query(
    "INSERT INTO records(school_id,owner_id,kind,payload) SELECT $1,$2,'assessment',$3::jsonb WHERE NOT EXISTS (SELECT 1 FROM records WHERE school_id=$1 AND kind='assessment' AND payload->>'student_id'=$4 AND payload->>'skill'=$5)",
    ['DEMO-SCHOOL-2',supervisor.id,JSON.stringify({student_id:'ATHAR-DEMO-STUDENT-002',student_name:'طالبة تجريبية',skill:'الكسور',name:'الكسور',subject:'الرياضيات',grade:'6',section:'1',pct:62,total:10,correct:6.2,date:'2026-10-05',source:'demo'}),'ATHAR-DEMO-STUDENT-002','الكسور']
  );

  const teacher=users.teacher;
  const demoAssignments=[
    {subject:'تقنية المعلومات',grade:'5',sections:['1']},
    {subject:'اللغة العربية',grade:'5',sections:['1']}
  ];
  await query("UPDATE users SET teaching_subject=$1,teaching_grades=ARRAY['5']::text[] WHERE id=$2",[demoAssignments[0].subject,teacher.id]);
  for (const item of demoAssignments) {
    await query(
      'INSERT INTO teacher_teaching_assignments(user_id,school_id,subject,grade,sections) VALUES($1,$2,$3,$4,$5::text[]) ON CONFLICT(user_id,school_id,subject,grade) DO UPDATE SET sections=EXCLUDED.sections',
      [teacher.id,schoolId,item.subject,item.grade,item.sections]
    );
  }

  const studentId='ATHAR-DEMO-STUDENT-001';
  const studentPayload={student_id:studentId,name:'طالب تجريبي',grade:'5',section:'1',source:'demo'};
  const learner=(await query("SELECT id FROM records WHERE school_id=$1 AND kind='student' AND payload->>'student_id'=$2 LIMIT 1",[schoolId,studentId])).rows[0];
  if (!learner) {
    await query("INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,'student',$3::jsonb)",[schoolId,teacher.id,JSON.stringify(studentPayload)]);
  } else {
    await query("UPDATE records SET payload=payload || $1::jsonb WHERE id=$2",[JSON.stringify(studentPayload),learner.id]);
  }

  async function upsertDemoRecord(kind,demoKey,payload) {
    const existingRows=(await query(
      "SELECT id,payload FROM records WHERE school_id=$1 AND kind=$2 AND payload->>'student_id'=$3 AND payload->>'source'='demo' ORDER BY id",
      [schoolId,kind,studentId]
    )).rows;
    const existing=existingRows.find(row=>row.payload?.demo_key===demoKey)
      || existingRows.find(row=>row.payload?.skill===payload.skill)
      || ((kind==='intervention'||kind==='impact')?existingRows.find(row=>!row.payload?.skill&&!row.payload?.demo_key):null);
    if (existing) {
      await query('UPDATE records SET payload=$1::jsonb WHERE id=$2',[JSON.stringify({...payload,demo_key:demoKey}),existing.id]);
      return Number(existing.id);
    }
    const saved=await query(
      'INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id',
      [schoolId,teacher.id,kind,JSON.stringify({...payload,demo_key:demoKey})]
    );
    return Number(saved.rows[0].id);
  }

  await upsertDemoRecord('assessment','reading-assessment',{
    student_id:studentId,student_name:'طالب تجريبي',skill:'الفهم المقروء',name:'الفهم المقروء',
    subject:'اللغة العربية',grade:'5',section:'1',assessment_scope:'individual',
    pct:45,total:20,correct:9,date:'2026-10-01',source:'demo'
  });
  await upsertDemoRecord('assessment','word-assessment',{
    student_id:studentId,student_name:'طالب تجريبي',skill:'فتح تطبيق Word',name:'فتح تطبيق Word',
    subject:'تقنية المعلومات',grade:'5',section:'1',assessment_scope:'individual',
    pct:50,total:2,correct:1,date:'2026-10-03',source:'demo'
  });

  await upsertDemoRecord('intervention','reading-intervention',{
    student_id:studentId,student_name:'طالب تجريبي',skill:'الفهم المقروء',
    goal:'أن يحدد الطالب الفكرة الرئيسة ويستخرج دليلًا من نص قصير وفق معيار يحدده المعلم',
    steps:'1. يعرض المعلم نصًا قصيرًا ويقرأه بصوت واضح.\n2. يحدد الطالب الفكرة الرئيسة بمساندة سؤال شفهي.\n3. يستخرج الطالب جملة واحدة تدعم إجابته.\n4. يجيب عن سؤال تحقق مستقل.',
    enrichment:'قارن بين فكرتين رئيسيتين في نصين قصيرين وادعم الاختيار بدليل.',
    observed_errors:'يحتاج إلى دعم في تحديد الفكرة الرئيسة واستخراج الدليل من النص.',
    curriculum:{grade:'5',subject:'اللغة العربية',unit:'نصوص قرائية',lesson:'الفكرة الرئيسة والدليل',learning_outcome:''},
    activity_mode:'offline',activity_duration:15,status:'active',date:'2026-10-02',source:'demo'
  });
  const wordInterventionId=await upsertDemoRecord('intervention','word-intervention',{
    student_id:studentId,student_name:'طالب تجريبي',skill:'فتح تطبيق Word',
    goal:'أن يفتح الطالب تطبيق Word بصورة مستقلة في محاولتين متتاليتين',
    steps:'1. يتعرف الطالب إلى رمز Word بين ثلاثة رموز.\n2. ينفذ فتح التطبيق على جهاز المعلم مع تلميح واحد عند الحاجة.\n3. يعيد فتح التطبيق دون مساعدة، ويسجل المعلم الاستقلالية.',
    enrichment:'يفتح مستندًا جديدًا بعد تشغيل البرنامج إذا كان ذلك ضمن الدرس.',
    observed_errors:'يحتاج إلى دعم في الوصول إلى تطبيق Word وفتحه.',
    curriculum:{grade:'5',subject:'تقنية المعلومات',unit:'معالجة النصوص',lesson:'فتح تطبيق Word',learning_outcome:''},
    activity_mode:'shared',activity_duration:15,status:'active',date:'2026-10-04',source:'demo'
  });

  await upsertDemoRecord('impact','word-impact',{
    student_id:studentId,student_name:'طالب تجريبي',intervention_record_id:wordInterventionId,
    intervention_skill:'فتح تطبيق Word',intervention_goal:'أن يفتح الطالب تطبيق Word بصورة مستقلة في محاولتين متتاليتين',
    before:50,after:75,difference:25,date:'2026-10-18',
    evidence_tool:'بطاقة ملاحظة الأداء العملي',before_date:'2026-10-04',after_date:'2026-10-18',
    activity_mode:'shared',sessions_planned:4,sessions_done:4,
    evidence_note:'فتح التطبيق في المحاولة الثانية دون مساعدة وفق بطاقة الملاحظة.',
    followup_score:75,evidence_status:'أدلة تجريبية توضيحية — ليست نتائج ميدانية',
    source:'demo'
  });

  await query("UPDATE users SET student_id=$1 WHERE email='demo.student@athar.test' AND school_id=$2",[studentId,schoolId]);
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
  if (!['teacher','senior_teacher','principal','supervisor','parent','student'].includes(role)) return res.status(400).json({ message:'شخصية الاختبار غير معروفة.' });
  const users=await ensureDemoFixtures(), user=users[role];
  if (!user?.active) return res.status(403).json({ message:'حساب الاختبار غير نشط.' });
  await sessionLogin(req,res,user,{demo:true,warning:'وضع اختبار فقط مع بيانات اصطناعية في مدرسة معزولة. لا تستخدم بيانات حقيقية.'});
}));
app.get('/api/auth/me',requireAuth,asyncRoute(async(req,res)=>{
  const [linked,assigned,teaching]=await Promise.all([linkedStudentIds(req.user),assignedStudentIds(req.user),req.user.role==='teacher'?teacherTeachingAssignment(req.user):Promise.resolve({assignments:[]})]);
  const assignments=teaching.assignments||[];
  res.json({ user:{...req.user,roleName:roleNames[req.user.role],linkedStudentIds:linked,assignedStudentIds:assigned,teachingAssignments:assignments,teachingSubjects:[...new Set(assignments.map(x=>x.subject))],teachingGrades:[...new Set(assignments.map(x=>x.grade))],isDemo:req.user.school_id==='DEMO-SCHOOL'} });
}));
app.post('/api/auth/logout',requireAuth,asyncRoute(async(req,res)=>{
  await audit(req.user.id,'logout');
  req.session.destroy(()=>{ res.clearCookie('athar.sid'); res.json({ok:true}); });
}));
app.get('/api/records',requireAuth,asyncRoute(async(req,res)=>{
  const rows=await getRecordsForUser(req.user);
  res.json({ records:rows.map(row=>({...row,payload:row.payload})) });
}));
app.get('/api/supervisor/schools',requireAuth,requireRole('supervisor'),asyncRoute(async(req,res)=>{
  const schools=(await query(
    `SELECT s.school_id,s.school_name,
      COUNT(DISTINCT r.payload->>'student_id') FILTER (WHERE r.kind='student' AND COALESCE(r.payload->>'student_id','')<>'')::int AS students,
      COUNT(r.id) FILTER (WHERE r.kind='assessment')::int AS assessments,
      COUNT(r.id) FILTER (WHERE r.kind='intervention')::int AS interventions,
      COUNT(r.id) FILTER (WHERE r.kind='intervention' AND r.payload->>'status'='completed')::int AS completed_interventions,
      COUNT(r.id) FILTER (WHERE r.kind='impact')::int AS impacts,
      COUNT(r.id) FILTER (WHERE r.kind='impact' AND COALESCE(r.payload->>'intervention_record_id','')<>'')::int AS linked_impacts,
      COUNT(r.id) FILTER (WHERE r.kind='impact'
        AND COALESCE(r.payload->>'evidence_tool','')<>''
        AND COALESCE(r.payload->>'before_date','')<>''
        AND COALESCE(r.payload->>'after_date','')<>''
        AND COALESCE(r.payload->>'activity_mode','')<>''
        AND COALESCE(r.payload->>'evidence_note','')<>''
        AND CASE
          WHEN length(COALESCE(r.payload->>'sessions_planned','')) BETWEEN 1 AND 2
           AND COALESCE(r.payload->>'sessions_planned','') !~ '[^0-9]'
           AND length(COALESCE(r.payload->>'sessions_done','')) BETWEEN 1 AND 2
           AND COALESCE(r.payload->>'sessions_done','') !~ '[^0-9]'
          THEN LPAD(r.payload->>'sessions_planned',2,'0') BETWEEN '01' AND '30'
           AND LPAD(r.payload->>'sessions_done',2,'0') BETWEEN '00' AND '30'
           AND LPAD(r.payload->>'sessions_done',2,'0') >= LPAD(r.payload->>'sessions_planned',2,'0')
          ELSE FALSE
        END)::int AS documented_impacts,
      MAX(r.created_at) AS last_activity
     FROM supervisor_schools s
     LEFT JOIN records r ON r.school_id=s.school_id
     WHERE s.user_id=$1
     GROUP BY s.school_id,s.school_name
     ORDER BY s.school_name`,
    [req.user.id]
  )).rows;
  res.json({schools});
}));

app.get('/api/supervisor/recommendations',requireAuth,requireRole('supervisor'),asyncRoute(async(req,res)=>{
  const rows=(await query(
    "SELECT r.id,r.school_id,ss.school_name,r.area,r.subject,r.body,r.priority,r.follow_up_date,r.status,r.principal_response,r.created_at,r.updated_at,u.name AS supervisor_name " +
    "FROM supervisor_recommendations r JOIN supervisor_schools ss ON ss.user_id=r.supervisor_id AND ss.school_id=r.school_id " +
    "JOIN users u ON u.id=r.supervisor_id WHERE r.supervisor_id=$1 ORDER BY r.created_at DESC,r.id DESC",
    [req.user.id]
  )).rows;
  res.json({recommendations:rows});
}));
app.get('/api/principal/recommendations',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const rows=(await query(
    "SELECT r.id,r.school_id,r.area,r.subject,r.body,r.priority,r.follow_up_date,r.status,r.principal_response,r.created_at,r.updated_at,u.name AS supervisor_name " +
    "FROM supervisor_recommendations r JOIN users u ON u.id=r.supervisor_id WHERE r.school_id=$1 ORDER BY r.created_at DESC,r.id DESC",
    [req.user.school_id]
  )).rows;
  res.json({recommendations:rows});
}));
app.post('/api/supervisor/recommendations',recordLimiter,requireAuth,requireRole('supervisor'),asyncRoute(async(req,res)=>{
  const schoolId=safeText(req.body?.school_id,100), area=safeText(req.body?.area,100);
  const subject=safeText(req.body?.subject,160), body=safeText(req.body?.body,3000);
  const priority=safeText(req.body?.priority,20), followUpDate=safeText(req.body?.follow_up_date,10);
  if(!schoolId||!area||!body||!['low','medium','high'].includes(priority))
    return res.status(400).json({message:'حدد المدرسة والمجال ونص التوصية والأولوية.'});
  if(followUpDate&&!/^\d{4}-\d{2}-\d{2}$/.test(followUpDate))
    return res.status(400).json({message:'تاريخ المتابعة غير صالح.'});
  const assigned=await query('SELECT school_id FROM supervisor_schools WHERE user_id=$1 AND school_id=$2',[req.user.id,schoolId]);
  if(!assigned.rowCount)return res.status(403).json({message:'هذه المدرسة غير مسندة إلى نطاق إشرافك.'});
  const saved=await query(
    'INSERT INTO supervisor_recommendations(supervisor_id,school_id,area,subject,body,priority,follow_up_date) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [req.user.id,schoolId,area,subject||null,body,priority,followUpDate||null]
  );
  await audit(req.user.id,'supervisor.recommendation.create',schoolId+': '+area);
  res.status(201).json({id:saved.rows[0].id});
}));
app.put('/api/principal/recommendations/:id',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const id=Number(req.params.id), status=safeText(req.body?.status,20);
  const response=safeText(req.body?.principal_response,2000);
  if(!Number.isSafeInteger(id)||id<1||!['pending','in_progress','completed'].includes(status))
    return res.status(400).json({message:'حالة التنفيذ غير صالحة.'});
  const updated=await query(
    'UPDATE supervisor_recommendations SET status=$1,principal_response=$2,status_updated_by=$3,updated_at=NOW() WHERE id=$4 AND school_id=$5 RETURNING id',
    [status,response,req.user.id,id,req.user.school_id]
  );
  if(!updated.rowCount)return res.status(404).json({message:'التوصية غير موجودة ضمن مدرستك.'});
  await audit(req.user.id,'supervisor.recommendation.followup',String(id)+': '+status);
  res.json({ok:true});
}));
app.post('/api/records',recordLimiter,requireAuth,requireRole('teacher','senior_teacher','principal'),asyncRoute(async(req,res)=>{
  const kind=safeText(req.body?.kind,40), payload=req.body?.payload;
  if (!['student','assessment','intervention','impact'].includes(kind) || !payload || typeof payload!=='object' || Array.isArray(payload)) return res.status(400).json({message:'نوع السجل أو بياناته غير صالحة.'});
  const clean={...payload}; delete clean.school_id; delete clean.owner_id;
  if (kind==='student') {
    clean.student_id=safeText(clean.student_id,80); clean.name=safeText(clean.name,140);
    if (!clean.student_id || !clean.name) return res.status(400).json({message:'اسم الطالب ومعرّفه مطلوبان.'});
    try { await validateStudentPlacement(req.user,clean.grade,clean.section); } catch(error) { return res.status(error.status||400).json({message:error.message}); }
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
      try { await validateStudentPlacement(req.user,clean.grade,clean.section); } catch(error) { return res.status(error.status||400).json({message:error.message}); }
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
  let suggestionSource=current.suggestion_source || 'teacher';
  let analysisRecordId=current.analysis_record_id ?? null;
  let assessmentRecordId=current.assessment_record_id ?? null;
  if (incoming.suggestion_source==='teacher') {
    suggestionSource='teacher';
    analysisRecordId=null;
    assessmentRecordId=null;
  } else if (incoming.suggestion_source==='athar-analysis') {
    const requestedAnalysisId=Number(incoming.analysis_record_id);
    if (!Number.isSafeInteger(requestedAnalysisId) || requestedAnalysisId<1) {
      return res.status(400).json({message:'معرّف تحليل أثَر المرتبط غير صالح.'});
    }
    const visibleRecords=await getRecordsForUser(req.user);
    const analysisRecord=visibleRecords.find(record=>Number(record.id)===requestedAnalysisId&&record.kind==='analysis');
    if (!analysisRecord) return res.status(400).json({message:'التحليل المرتبط غير موجود أو غير متاح ضمن صلاحيات هذا الحساب.'});
    const analysisPayload=analysisRecord.payload || {};
    if (String(analysisPayload.student_id || '')!==String(current.student_id || '')) {
      return res.status(400).json({message:'لا يمكن ربط التدخل بتحليل يخص طالبًا آخر.'});
    }
    const requestedAssessmentId=Number(incoming.assessment_record_id || analysisPayload.assessment_record_id || 0) || null;
    if (requestedAssessmentId) {
      const assessmentRecord=visibleRecords.find(record=>Number(record.id)===requestedAssessmentId&&record.kind==='assessment');
      if (!assessmentRecord || Number(analysisPayload.assessment_record_id || 0)!==requestedAssessmentId) {
        return res.status(400).json({message:'التقويم المرتبط لا يطابق التحليل أو غير متاح ضمن صلاحيات هذا الحساب.'});
      }
    }
    suggestionSource='athar-analysis';
    analysisRecordId=requestedAnalysisId;
    assessmentRecordId=requestedAssessmentId;
  }
  const updated={
    ...current,
    skill,goal,steps,
    enrichment:safeText(incoming.enrichment,3000),
    observed_errors:safeText(incoming.observed_errors,2000),
    curriculum,
    activity_mode:activityMode,
    activity_duration:duration,
    status,
    suggestion_source:suggestionSource,
    analysis_record_id:analysisRecordId,
    assessment_record_id:assessmentRecordId
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
app.get('/api/school/grade-sections',requireAuth,asyncRoute(async(req,res)=>{
  const rows=await query('SELECT grade,section_count FROM school_grade_sections WHERE school_id=$1 ORDER BY grade',[req.user.school_id]);
  res.json({grades:rows.rows.map(row=>({grade:String(row.grade),sectionCount:Number(row.section_count),sections:Array.from({length:Number(row.section_count)},(_,i)=>String(i+1))}))});
}));
app.put('/api/school/grade-sections',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const grades=Array.isArray(req.body?.grades)?req.body.grades:[];
  const clean=grades.map(item=>({grade:safeText(item?.grade,2),sectionCount:Number(item?.sectionCount)}))
    .filter(item=>/^(?:[1-9]|1[0-2])$/.test(item.grade)&&Number.isInteger(item.sectionCount)&&item.sectionCount>=1&&item.sectionCount<=30);
  if(!clean.length)return res.status(400).json({message:'حددي صفًا واحدًا على الأقل وعدد شعب من 1 إلى 30.'});
  if(new Set(clean.map(x=>x.grade)).size!==clean.length)return res.status(400).json({message:'يوجد صف مكرر في الإعدادات.'});
  await withTransaction(async client=>{
    for(const item of clean)await client.query('INSERT INTO school_grade_sections(school_id,grade,section_count) VALUES($1,$2,$3) ON CONFLICT(school_id,grade) DO UPDATE SET section_count=EXCLUDED.section_count,updated_at=NOW()',[req.user.school_id,item.grade,item.sectionCount]);
    await client.query('DELETE FROM school_grade_sections WHERE school_id=$1 AND grade<>ALL($2::text[])',[req.user.school_id,clean.map(x=>x.grade)]);
  });
  await audit(req.user.id,'school.grade_sections.update',clean.map(x=>x.grade+':'+x.sectionCount).join(','));
  res.json({ok:true,grades:clean.map(item=>({...item,sections:Array.from({length:item.sectionCount},(_,i)=>String(i+1))}))});
}));
app.get('/api/users',requireAuth,requireRole('principal'),asyncRoute(async(req,res)=>{
  const [users,linked,assigned,teaching]=await Promise.all([
    query('SELECT id,email,name,role,school_id,active,created_at FROM users WHERE school_id=$1 ORDER BY name',[req.user.school_id]),
    query('SELECT user_id,student_id FROM account_students WHERE school_id=$1',[req.user.school_id]),
    query('SELECT user_id,student_id FROM teacher_students WHERE school_id=$1',[req.user.school_id]),
    query('SELECT user_id,subject,grade,sections FROM teacher_teaching_assignments WHERE school_id=$1 ORDER BY subject,grade',[req.user.school_id])
  ]);
  const map=new Map(), assignmentMap=new Map(), teachingMap=new Map();
  for (const x of linked.rows) map.set(String(x.user_id),[...(map.get(String(x.user_id))||[]),x.student_id]);
  for (const x of assigned.rows) assignmentMap.set(String(x.user_id),[...(assignmentMap.get(String(x.user_id))||[]),x.student_id]);
  for (const x of teaching.rows) teachingMap.set(String(x.user_id),[...(teachingMap.get(String(x.user_id))||[]),{subject:x.subject,grade:String(x.grade),sections:Array.isArray(x.sections)?x.sections:[]}]);
  res.json({users:users.rows.map(u=>({...u,teachingAssignments:teachingMap.get(String(u.id))||[],linkedStudentIds:map.get(String(u.id))||[],assignedStudentIds:assignmentMap.get(String(u.id))||[]}))});
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
  let assignments=Array.isArray(req.body?.assignments)?req.body.assignments:[];
  // Backward compatibility for the previous single-subject form.
  if (!assignments.length && req.body?.subject && Array.isArray(req.body?.grades)) {
    assignments=req.body.grades.map(grade=>({subject:req.body.subject,grade,sections:[]}));
  }
  const clean=assignments.map(item=>({
    subject:safeText(item?.subject,120),
    grade:safeText(item?.grade,2),
    sections:Array.isArray(item?.sections)?[...new Set(item.sections.map(v=>safeText(v,30)).filter(Boolean))].slice(0,30):[]
  })).filter(item=>item.subject && /^(?:[1-9]|1[0-2])$/.test(item.grade));
  const keys=new Set();
  for (const item of clean) {
    const key=`${item.subject.toLocaleLowerCase('ar')}|${item.grade}`;
    if (keys.has(key)) return res.status(400).json({message:'يوجد تكليف مكرر للمادة والصف نفسيهما.'});
    keys.add(key);
    const configured=(await query('SELECT section_count FROM school_grade_sections WHERE school_id=$1 AND grade=$2',[req.user.school_id,item.grade])).rows[0];
    if(!configured)return res.status(400).json({message:`لم يحدد المدير عدد الشعب للصف ${item.grade} بعد.`});
    const allowedSections=new Set(Array.from({length:Number(configured.section_count)},(_,i)=>String(i+1)));
    if(item.sections.some(section=>!allowedSections.has(section)))return res.status(400).json({message:`توجد شعبة غير معتمدة للصف ${item.grade}.`});
  }
  if (!clean.length) return res.status(400).json({message:'أضف تكليفًا واحدًا على الأقل يتضمن المادة والصف.'});
  await withTransaction(async client=>{
    await client.query('DELETE FROM teacher_teaching_assignments WHERE user_id=$1 AND school_id=$2',[targetId,req.user.school_id]);
    for (const item of clean) await client.query('INSERT INTO teacher_teaching_assignments(user_id,school_id,subject,grade,sections) VALUES($1,$2,$3,$4,$5::text[])',[targetId,req.user.school_id,item.subject,item.grade,item.sections]);
    const legacyGrades=[...new Set(clean.map(item=>item.grade))];
    await client.query('UPDATE users SET teaching_subject=$1,teaching_grades=$2::text[] WHERE id=$3 AND school_id=$4',[clean[0].subject,legacyGrades,targetId,req.user.school_id]);
  });
  await audit(req.user.id,'user.teaching_assignment.update',`${target.role}:${targetId}:${clean.length} assignments`);
  res.json({ok:true,userId:targetId,teachingAssignments:clean});
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
  // Use the same permission-filtered record set shown to this account in the interface.
  // This keeps radar analysis aligned with teaching assignments and explicit student links.
  const visibleRecords=await getRecordsForUser(user);
  const rows=visibleRecords.filter(record=>record.kind==='assessment');
  let assessments=rows.map(record=>record.payload);
  if (studentId) assessments=assessments.filter(a=>String(a.student_id||'')===studentId);
  const subject=normalizeArabic(body.subject||'');
  const grade=safeText(body.grade,30);
  const section=safeText(body.section,30);
  if (subject) assessments=assessments.filter(a=>normalizeArabic(a.subject||'')===subject);
  if (grade) assessments=assessments.filter(a=>String(a.grade||'')===grade);
  if (section) assessments=assessments.filter(a=>String(a.section||'')===section);
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
    unit:safeText(body.unit,120),
    lesson:safeText(body.lesson,120),
    learningOutcome:safeText(body.learning_outcome,700),
    activityDuration:['10','15','20'].includes(String(body.activity_duration))?String(body.activity_duration):'15',
    classSize:safeText(body.class_size,10),
    deliveryMode:['offline','shared','online'].includes(body.delivery_mode)?body.delivery_mode:'offline'
  };
  const instructions='أنت مساعد تربوي خبير في تصميم التدخلات التعليمية في مدارس سلطنة عُمان. صمّم خطة علاجية تطبيقية مرتبطة مباشرة بالمهارة المستهدفة وملاحظة المعلم وناتج التعلم والدرس والمادة والوقت وإمكانات المدرسة. لا تستخدم أنشطة لمهارة أخرى؛ مثال: لا تقترح نصوص فهم مقروء إذا كانت المهارة تنسيق البريد الإلكتروني. ابدأ بتحويل ملاحظة المعلم إلى سلوك قابل للملاحظة، ثم صغ هدفًا محددًا قابلًا للقياس مرتبطًا بالمهارة نفسها، وحدد خط الأساس والهدف والزمن دون ضمان تحسن غير مثبت. اكتب 3 إلى 5 خطوات متدرجة قابلة للتنفيذ خلال الوقت المحدد، تتضمن نموذجًا من المعلم وممارسة موجهة وممارسة مستقلة وتحققًا قصيرًا. راع حجم الصف وإمكانات التنفيذ: offline يعني ورقة وسبورة دون أجهزة؛ shared يعني جهاز المعلم وشاشة مشتركة دون افتراض جهاز لكل طالب؛ online يسمح بأجهزة الطلبة. اجعل الأنشطة مرتبطة بمحتوى الدرس وناتج التعلم إن توفرا، ولا تخترع تفاصيل من الكتاب. أضف تكييفًا للمتعثر ومسارًا إثرائيًا. اجعل الهدف والخطوات محددة وليست عبارات عامة. قاعدة مهمة عند وجود صعوبة قراءة: لا تجعل قراءة تعليمات مكتوبة شرطًا لتنفيذ النشاط؛ استخدم تعليمات شفهية قصيرة، رموزًا أو صورًا، ونمذجة عملية، وتحقق من فهم التعليمات قبل الحكم على المهارة. إذا كانت المادة تقنية المعلومات أو الحاسوب والمهارة عامة مثل التعامل مع الحاسوب، فلا تفترض أن الطالبة لا تعرف استخدام الجهاز؛ افصل بين القدرة على قراءة التعليمات وبين أداء المهارة الحاسوبية. صمم نشاطًا يبدأ بتعليمات شفهية/مصورة، ثم أداء خطوة حاسوبية محددة يختارها المعلم من الدرس، مع بديل ورقي يحاكي الخطوات عند عدم توفر جهاز، واذكر أن المحاكاة الورقية لا تثبت إتقان التنفيذ الفعلي على الحاسوب. لا تخترع اسم برنامج أو أمر أو مهارة فرعية غير موجودة في البيانات. إذا لم يحدد الدرس أو ناتج التعلم المهمة الدقيقة، اطلب من المعلم تحديدها أو اقترح أمثلة مشروطة لا تقدمها كحقيقة. يجب أن تتضمن الخطوات أمثلة تنفيذية فعلية وألا تكتفي بعبارات مثل نفذ المهمة أو رتب الخطوات. اجعل أسئلة التحقق غير معتمدة على القراءة وحدها. أخرج JSON عربيًا موجزًا فقط بالمفاتيح: errorPattern (string), goal (string), interventionSteps (array of strings), possibleRoots (array of objects {skill:string,evidence:string,confidence:string}), teacherChecks (array of strings), differentiated (object {support:string,expected:string,enrichment:string}), nextCheck (string), cautions (array of strings).';
  const userPrompt=`صمّم تدخلًا تربويًا مخصصًا اعتمادًا على البيانات التالية فقط. يجب أن تتطابق الأنشطة مع المهارة والدرس والمادة، وأن تراعي الوقت والإمكانات. إذا كانت معلومة غير متاحة فلا تفترضها. أعد JSON فقط:\n${JSON.stringify(evidenceOnly)}`;
  const endpoint=provider==='groq'?'https://api.groq.com/openai/v1/chat/completions':'https://api.openai.com/v1/responses';
  const headers={'Authorization':`Bearer ${provider==='groq'?process.env.GROQ_API_KEY:process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'};
  const requestBody=provider==='groq'?{
    model:process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    messages:[{role:'system',content:instructions},{role:'user',content:userPrompt}],
    response_format:{type:'json_object'},
    max_tokens:2500,
    temperature:0.2
  }:{
    model:process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    store:false,
    max_output_tokens:2500,
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
    goal:safeText(parsed.goal,900),
    interventionSteps:list(parsed.interventionSteps),
    possibleRoots:roots,
    teacherChecks:list(parsed.teacherChecks),
    differentiated:{
      support:safeText(parsed.differentiated?.support,700),
      expected:safeText(parsed.differentiated?.expected,700),
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
    const assessmentRecordId=Number(requestBody.assessment_record_id)||null;
    if(assessmentRecordId){
      const visibleRecords=await getRecordsForUser(req.user);
      const sourceAssessment=visibleRecords.find(record=>String(record.id)===String(assessmentRecordId)&&record.kind==='assessment');
      if(!sourceAssessment)return res.status(400).json({message:'التقويم المرتبط غير موجود أو غير متاح ضمن صلاحيات هذا الحساب.'});
      const source=sourceAssessment.payload||{};
      if(String(source.student_id||'')!==String(requestBody.student_id||''))return res.status(400).json({message:'الطالب المحدد لا يطابق الطالب المرتبط بالتقويم.'});
      for(const field of ['subject','grade','section']){
        if(requestBody[field]!==undefined&&String(source[field]||'')!==String(requestBody[field]||''))return res.status(400).json({message:'بيانات الصف أو المادة لا تطابق التقويم المرتبط.'});
      }
      const sourceSkill=normalizeArabic(findSkill(source.skill||source.name||'')?.title||source.skill||source.name||'');
      const requestedSkill=normalizeArabic(findSkill(requestBody.skill||requestBody.question||'')?.title||requestBody.skill||requestBody.question||'');
      if(sourceSkill&&requestedSkill&&sourceSkill!==requestedSkill)return res.status(400).json({message:'المهارة المحددة لا تطابق المهارة المسجلة في التقويم.'});
    }
    const result=await analyzeLearning(req.user,requestBody), studentId=safeText(requestBody.student_id,80)||null;
    let aiAssist={status:'not_configured'};
    try { aiAssist=await generateTeachingAI(result,requestBody.observedErrors,requestBody); }
    catch(error) { console.error('Teaching AI unavailable:',error.message); aiAssist={status:'unavailable',message:'تعذر إكمال التحليل الذكي الآن؛ ما زال التحليل القائم على نتائج التقويم متاحًا.'}; }
    const saved=await query('INSERT INTO records(school_id,owner_id,kind,payload) VALUES($1,$2,$3,$4::jsonb) RETURNING id',[req.user.school_id,req.user.id,'analysis',JSON.stringify({student_id:studentId,assessment_record_id:assessmentRecordId,skill:result.skill,grade:safeText(requestBody.grade,30),subject:safeText(requestBody.subject,80),unit:safeText(requestBody.unit,120),lesson:safeText(requestBody.lesson,120),learning_outcome:safeText(requestBody.learning_outcome,700),result,aiAssist,date:new Date().toISOString()})]);
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
await query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check");
await query("ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('teacher','senior_teacher','principal','supervisor','parent','student'))");
await query("CREATE TABLE IF NOT EXISTS supervisor_schools (" +
  "user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
  "school_id TEXT NOT NULL, school_name TEXT NOT NULL, " +
  "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,school_id))");
await query("CREATE INDEX IF NOT EXISTS idx_supervisor_schools_school ON supervisor_schools(school_id,user_id)");
await query("CREATE TABLE IF NOT EXISTS supervisor_recommendations (" +
  "id BIGSERIAL PRIMARY KEY, supervisor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, " +
  "school_id TEXT NOT NULL, area TEXT NOT NULL, subject TEXT, body TEXT NOT NULL, " +
  "priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')), follow_up_date DATE, " +
  "status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')), " +
  "principal_response TEXT NOT NULL DEFAULT '', status_updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL, " +
  "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
await query("CREATE INDEX IF NOT EXISTS idx_supervisor_recommendations_school ON supervisor_recommendations(school_id,created_at DESC)");
await query("CREATE INDEX IF NOT EXISTS idx_supervisor_recommendations_owner ON supervisor_recommendations(supervisor_id,created_at DESC)");
await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS teaching_grades TEXT[] NOT NULL DEFAULT '{}'::text[]");
await query("CREATE TABLE IF NOT EXISTS account_students (" +
  "user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
  "student_id TEXT NOT NULL, school_id TEXT NOT NULL, PRIMARY KEY(user_id,student_id))");
await query("CREATE INDEX IF NOT EXISTS idx_account_students_student ON account_students(school_id,student_id)");
await query("CREATE TABLE IF NOT EXISTS teacher_students (" +
  "user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
  "student_id TEXT NOT NULL, school_id TEXT NOT NULL, PRIMARY KEY(user_id,student_id))");
await query("CREATE INDEX IF NOT EXISTS idx_teacher_students_student ON teacher_students(school_id,student_id)");
const otpColumnTypes=await query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='otp_codes'");
const otpTypes=new Map(otpColumnTypes.rows.map(row=>[row.column_name,row.data_type]));
otpExpiryUsesTimestamp=otpTypes.get('expires_at')==='timestamp with time zone';
otpCreatedUsesTimestamp=otpTypes.get('created_at')==='timestamp with time zone';
await query("CREATE TABLE IF NOT EXISTS school_grade_sections (" +
  "school_id TEXT NOT NULL, grade TEXT NOT NULL, section_count INTEGER NOT NULL CHECK(section_count BETWEEN 1 AND 30), " +
  "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(school_id,grade))");
await query("CREATE TABLE IF NOT EXISTS teacher_teaching_assignments (" +
  "id BIGSERIAL PRIMARY KEY, " +
  "user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
  "school_id TEXT NOT NULL, " +
  "subject TEXT NOT NULL, " +
  "grade TEXT NOT NULL, " +
  "sections TEXT[] NOT NULL DEFAULT '{}'::text[], " +
  "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), " +
  "UNIQUE(user_id,school_id,subject,grade))");
await query("CREATE INDEX IF NOT EXISTS idx_teacher_teaching_assignments_school ON teacher_teaching_assignments(school_id,subject,grade)");
await query("INSERT INTO teacher_teaching_assignments(user_id,school_id,subject,grade,sections) " +
  "SELECT u.id,u.school_id,u.teaching_subject,grade,'{}'::text[] " +
  "FROM users u CROSS JOIN LATERAL unnest(u.teaching_grades) AS grade " +
  "WHERE u.role='teacher' AND COALESCE(u.teaching_subject,'')<>'' " +
  "ON CONFLICT(user_id,school_id,subject,grade) DO NOTHING");
const server=app.listen(port,()=>console.log(`ATHAR API PostgreSQL v3 listening on ${port}`));
async function shutdown(signal) {
  console.log(`${signal}: closing ATHAR API`);
  server.close(async()=>{try{await pool.end();process.exit(0);}catch(error){console.error(error);process.exit(1);}});
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));

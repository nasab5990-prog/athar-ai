import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';

const roles = ['teacher','senior_teacher','principal','parent','student'];
const roleNames = { teacher:'المعلم', senior_teacher:'المعلم الأول', principal:'المدير', parent:'ولي الأمر', student:'الطالب' };
const domains = new Set(['moe.om','edu.moe.om']);
const clean = (value, max=300) => String(value ?? '').trim().slice(0,max);
const validEmail = email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && domains.has((email.split('@')[1]||'').toLowerCase());
const hash = (secret,email,code) => crypto.createHmac('sha256',secret).update(email+':'+code).digest('hex');
const equal = (a,b) => {
  const x=Buffer.from(String(a),'hex'), y=Buffer.from(String(b),'hex');
  return x.length===y.length && x.length>0 && crypto.timingSafeEqual(x,y);
};
const limiter = rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false});

export function registerPostgresAuthRoutes(app,{auth,access,demoEnabled=false,otpSecret,sessionSecret,mailConfig={}}) {
  const transporter = mailConfig.host ? nodemailer.createTransport({
    host:mailConfig.host, port:Number(mailConfig.port||587), secure:mailConfig.secure===true,
    auth:mailConfig.user?{user:mailConfig.user,pass:mailConfig.pass}:undefined
  }) : null;
  const audit=(id,event,details='')=>auth.writeAudit(id,event,details);
  const regenerate=req=>new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
  const save=req=>new Promise((resolve,reject)=>req.session.save(e=>e?reject(e):resolve()));
  async function present(user,extra={}) {
    return {...user,roleName:roleNames[user.role],
      linkedStudentIds:await access.listLinkedStudentIds(user),
      assignedStudentIds:await access.listAssignedStudentIds(user),...extra};
  }
  async function requireAuth(req,res,next) {
    try {
      const id=req.session?.user?.id;
      if(!id) return res.status(401).json({message:'يلزم تسجيل الدخول.'});
      const user=await auth.findActiveUserById(String(id));
      if(!user) { req.session.destroy(()=>{}); return res.status(401).json({message:'الحساب غير نشط.'}); }
      req.user=user; next();
    } catch(error) { next(error); }
  }
  app.get('/api/auth/mode',(req,res)=>res.json({mode:demoEnabled?'demo':'otp',otpAvailable:Boolean(transporter)}));
  app.post('/api/auth/request-code',limiter,async(req,res)=>{
    const email=clean(req.body?.email,254).toLowerCase();
    if(!validEmail(email)) return res.status(400).json({message:'استخدم البريد الرسمي ضمن @moe.om أو @edu.moe.om.'});
    if(!transporter) return res.status(503).json({message:'الدخول بالبريد غير مفعّل بعد.'});
    const user=await auth.findActiveUserByEmail(email);
    if(user) {
      const code=String(crypto.randomInt(0,1000000)).padStart(6,'0'), now=Date.now();
      await auth.saveOtp({email,codeHash:hash(otpSecret||sessionSecret,email,code),expiresAt:now+600000,createdAt:now});
      try {
        await transporter.sendMail({from:mailConfig.from||mailConfig.user,to:email,subject:'رمز التحقق — أثَر',
          text:'رمز التحقق: '+code+'\nصالح لمدة 10 دقائق. لا تشاركه مع أحد.'});
      } catch(error) {
        await auth.deleteOtp(email); console.error('OTP delivery failed:',error.message);
        return res.status(502).json({message:'تعذر إرسال رمز التحقق.'});
      }
    }
    res.json({message:'إذا كان البريد مسجلًا ومفعّلًا، فسيصلك رمز تحقق خلال لحظات.'});
  });
  app.post('/api/auth/verify-code',limiter,async(req,res)=>{
    const email=clean(req.body?.email,254).toLowerCase(), code=clean(req.body?.code,6);
    if(!validEmail(email)||!/^\d{6}$/.test(code)) return res.status(400).json({message:'البريد أو رمز التحقق غير صالح.'});
    const row=await auth.claimOtpAttempt(email);
    if(!row||!equal(row.code_hash,hash(otpSecret||sessionSecret,email,code)))
      return res.status(401).json({message:'رمز التحقق غير صالح أو انتهت صلاحيته.'});
    await auth.deleteOtp(email);
    const user=await auth.findActiveUserByEmail(email);
    if(!user) return res.status(401).json({message:'الحساب غير مفعّل. راجع مسؤول النظام.'});
    await regenerate(req); req.session.user={id:String(user.id)}; await save(req);
    await audit(user.id,'login',user.role);
    res.json({user:await present(user)});
  });
  app.post('/api/auth/demo',limiter,async(req,res)=>{
    if(!demoEnabled) return res.status(404).json({message:'وضع الاختبار غير مفعّل.'});
    const role=clean(req.body?.persona||'teacher',32);
    if(!roles.includes(role)) return res.status(400).json({message:'شخصية الاختبار غير معروفة.'});
    const users=await auth.ensureDemoUsers(), user=users[role];
    if(!user?.active) return res.status(403).json({message:'حساب الاختبار غير نشط.'});
    await regenerate(req); req.session.user={id:String(user.id)}; await save(req);
    await audit(user.id,'demo.login',role);
    res.json({user:await present(user,{isDemo:true}),warning:'بيئة اختبار معزولة؛ لا تستخدم بيانات حقيقية.'});
  });
  app.get('/api/auth/me',requireAuth,async(req,res)=>res.json({user:await present(req.user,{isDemo:req.user.school_id==='DEMO-SCHOOL'})}));
  app.post('/api/auth/logout',requireAuth,async(req,res)=>{
    await audit(req.user.id,'logout');
    req.session.destroy(error=>{if(error)return res.status(500).json({message:'تعذر إنهاء الجلسة.'});res.clearCookie('athar.sid');res.json({ok:true});});
  });
  return {requireAuth,requireRole:(...allowed)=>(req,res,next)=>allowed.includes(req.user?.role)?next():res.status(403).json({message:'ليس لديك صلاحية لتنفيذ هذا الإجراء.'})};
}

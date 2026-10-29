import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import SQLiteStoreFactory from 'connect-sqlite3';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const port=Number(process.env.PORT||3000);
if(process.env.NODE_ENV==='production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32 || !process.env.OTP_SECRET || process.env.OTP_SECRET.length<32)) { throw new Error('Production requires SESSION_SECRET and OTP_SECRET of at least 32 characters.'); }
const allowedDomains=['moe.om','edu.moe.om'];
const frontendOrigin=(process.env.FRONTEND_ORIGIN||'').split(',').map(s=>s.trim()).filter(Boolean);
const dbPath=process.env.DB_PATH||path.join(__dirname,'data','athar.sqlite');
import fs from 'node:fs';
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('teacher','senior_teacher','principal','parent')),
 school_id TEXT NOT NULL,student_id TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS otp_codes(
 email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log(
 id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,event TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS records(
 id INTEGER PRIMARY KEY AUTOINCREMENT, school_id TEXT NOT NULL, owner_id INTEGER NOT NULL,
 kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);
const SQLiteStore=SQLiteStoreFactory(session);
app.set('trust proxy',1);
app.use(helmet({crossOriginResourcePolicy:{policy:'cross-origin'}}));
app.use(cors({origin:(origin,cb)=>{if(!origin||!frontendOrigin.length||frontendOrigin.includes(origin))return cb(null,true);return cb(new Error('Origin not allowed'));},credentials:true}));
app.use(express.json({limit:'100kb'}));
app.use(session({
 name:'athar.sid',secret:process.env.SESSION_SECRET||'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET_BEFORE_DEPLOYMENT',
 resave:false,saveUninitialized:false,store:new SQLiteStore({db:'sessions.sqlite',dir:path.dirname(dbPath)}),
 cookie:{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:process.env.COOKIE_SAMESITE||'lax',maxAge:8*60*60*1000}
}));
const loginLimiter=rateLimit({windowMs:15*60*1000,limit:10,standardHeaders:true,legacyHeaders:false,message:{message:'محاولات كثيرة. حاول لاحقًا.'}});
const transporter=process.env.SMTP_HOST?nodemailer.createTransport({
 host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',
 auth:process.env.SMTP_USER?{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined
}):null;
const hashOtp=(email,code)=>crypto.createHmac('sha256',process.env.OTP_SECRET||process.env.SESSION_SECRET||'replace-me').update(`${email}:${code}`).digest('hex');
const safeEqual=(a,b)=>{try{return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}catch{return false;}};
const domainAllowed=email=>{const domain=(email.split('@')[1]||'').toLowerCase();return allowedDomains.includes(domain);};
function audit(userId,event,details=''){db.prepare('INSERT INTO audit_log(user_id,event,details) VALUES(?,?,?)').run(userId,event,details);}
function requireAuth(req,res,next){const user=req.session.user;if(!user)return res.status(401).json({message:'يلزم تسجيل الدخول.'});const fresh=db.prepare('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE id=?').get(user.id);if(!fresh||!fresh.active){req.session.destroy(()=>{});return res.status(401).json({message:'الحساب غير نشط.'});}req.user=fresh;next();}
const roleNames={teacher:'المعلم',senior_teacher:'المعلم الأول',principal:'المدير',parent:'ولي الأمر'};
function requireRole(...roles){return (req,res,next)=>{if(!req.user||!roles.includes(req.user.role))return res.status(403).json({message:'ليس لديك صلاحية لتنفيذ هذا الإجراء.'});next();};}
app.get('/api/health',(req,res)=>res.json({ok:true,service:'athar-api'}));
app.post('/api/auth/request-code',loginLimiter,async(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!domainAllowed(email))return res.status(400).json({message:'استخدم البريد الرسمي ضمن @moe.om أو @edu.moe.om.'});
 if(!transporter)return res.status(503).json({message:'لم يتم إعداد خدمة البريد في الخادم بعد. أضف إعدادات SMTP قبل تفعيل تسجيل الدخول.'});
 const user=db.prepare('SELECT id,email,active FROM users WHERE email=?').get(email);
 // Generic response prevents account enumeration.
 if(user?.active){
   const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
   db.prepare(`INSERT INTO otp_codes(email,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,created_at=excluded.created_at`)
     .run(email,hashOtp(email,code),Date.now()+10*60*1000,0,Date.now());
   await transporter.sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to:email,subject:'رمز التحقق — أثَر',text:`رمز التحقق للدخول إلى منصة أثَر هو: ${code}\nصالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.`});
 }
 res.json({message:'إذا كان البريد مسجلًا ومفعّلًا، فسيصلك رمز تحقق خلال لحظات.'});
});
app.post('/api/auth/verify-code',loginLimiter,(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(),code=String(req.body?.code||'').trim();
 if(!domainAllowed(email)||!/^\d{6}$/.test(code))return res.status(400).json({message:'البريد أو رمز التحقق غير صالح.'});
 const row=db.prepare('SELECT * FROM otp_codes WHERE email=?').get(email);
 if(!row||row.expires_at<Date.now()||row.attempts>=5){db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);return res.status(401).json({message:'انتهت صلاحية الرمز أو لم يعد صالحًا. اطلب رمزًا جديدًا.'});}
 const match=safeEqual(row.code_hash,hashOtp(email,code));
 if(!match){db.prepare('UPDATE otp_codes SET attempts=attempts+1 WHERE email=?').run(email);return res.status(401).json({message:'رمز التحقق غير صحيح.'});}
 db.prepare('DELETE FROM otp_codes WHERE email=?').run(email);
 const user=db.prepare('SELECT id,email,name,role,school_id,student_id,active FROM users WHERE email=? AND active=1').get(email);
 if(!user)return res.status(401).json({message:'الحساب غير مفعّل. راجع مسؤول النظام.'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({message:'تعذر إنشاء جلسة آمنة.'});req.session.user={id:user.id};audit(user.id,'login');res.json({user:{...user,roleName:roleNames[user.role]}});});
});
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({user:{...req.user,roleName:roleNames[req.user.role]}}));
app.post('/api/auth/logout',requireAuth,(req,res)=>{audit(req.user.id,'logout');req.session.destroy(()=>{res.clearCookie('athar.sid');res.json({ok:true});});});

// All record access is checked on the server, not merely by hiding navigation.
app.get('/api/records',requireAuth,(req,res)=>{
 let rows;
 if(req.user.role==='parent'){
   rows=db.prepare("SELECT id,kind,payload,created_at FROM records WHERE school_id=? AND kind='parent_view' AND json_extract(payload,'$.student_id')=? ORDER BY id DESC").all(req.user.school_id,req.user.student_id||'');
 } else if(req.user.role==='principal'||req.user.role==='senior_teacher'){
   rows=db.prepare('SELECT id,kind,payload,created_at FROM records WHERE school_id=? ORDER BY id DESC LIMIT 500').all(req.user.school_id);
 } else {
   rows=db.prepare("SELECT id,kind,payload,created_at FROM records WHERE school_id=? AND (owner_id=? OR kind IN ('shared_assessment','shared_intervention')) ORDER BY id DESC LIMIT 300").all(req.user.school_id,req.user.id);
 }
 res.json({records:rows.map(r=>({...r,payload:JSON.parse(r.payload)}))});
});
app.post('/api/records',requireAuth,requireRole('teacher','senior_teacher','principal'),(req,res)=>{
 const kind=String(req.body?.kind||'').trim(),payload=req.body?.payload;
 const permitted=['student','assessment','intervention','impact','shared_assessment','shared_intervention'];
 if(!permitted.includes(kind)||!payload||typeof payload!=='object')return res.status(400).json({message:'نوع السجل أو بياناته غير صالحة.'});
 const info=db.prepare('INSERT INTO records(school_id,owner_id,kind,payload) VALUES(?,?,?,?)').run(req.user.school_id,req.user.id,kind,JSON.stringify(payload));
 audit(req.user.id,'record.create',kind);
 res.status(201).json({id:info.lastInsertRowid,kind,payload});
});
app.get('/api/users',requireAuth,requireRole('principal'),(req,res)=>{
 const users=db.prepare('SELECT id,email,name,role,school_id,active,created_at FROM users WHERE school_id=? ORDER BY name').all(req.user.school_id);
 res.json({users});
});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({message:'حدث خطأ داخلي. راجع سجل الخادم.'});});
app.listen(port,()=>console.log(`ATHAR API listening on ${port}`));

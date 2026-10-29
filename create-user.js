import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
const dbPath=process.env.DB_PATH||path.join(process.cwd(),'data','athar.sqlite');
fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new Database(dbPath);
db.exec(`CREATE TABLE IF NOT EXISTS users(
 id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('teacher','senior_teacher','principal','parent')),
 school_id TEXT NOT NULL,student_id TEXT,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
const [emailArg,nameArg,roleArg,schoolArg,studentArg]=process.argv.slice(2);
const email=(emailArg||'').toLowerCase().trim(),name=(nameArg||'').trim(),role=roleArg||'',school=(schoolArg||'').trim(),student=(studentArg||'').trim()||null;
if(!email||!name||!school||!['teacher','senior_teacher','principal','parent'].includes(role)){console.error('Usage: npm run create-user -- user@moe.om "Name" teacher SCHOOL_ID [STUDENT_ID-for-parent]');process.exit(1);}
const domain=email.split('@')[1];
if(!['moe.om','edu.moe.om'].includes(domain)){console.error('Only @moe.om and @edu.moe.om are allowed.');process.exit(1);}
if(role==='parent'&&!student){console.error('Parent account requires a linked STUDENT_ID.');process.exit(1);}
try{db.prepare('INSERT INTO users(email,name,role,school_id,student_id) VALUES(?,?,?,?,?)').run(email,name,role,school,student);console.log(`Created ${role} account for ${email} in school ${school}.`);}
catch(e){console.error('Could not create account:',e.message);process.exit(1);}

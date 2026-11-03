import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import session from 'express-session';
import * as auth from '../db/auth.js';
import * as access from '../db/authorization.js';
import { registerPostgresAuthRoutes } from '../db/postgres-auth-routes.js';

test('demo authentication creates a session, exposes current user and destroys session on logout', async () => {
  const app=express();
  app.set('trust proxy',1);
  app.use(express.json());
  app.use(session({
    name:'athar.sid',
    secret:'integration-test-session-secret-at-least-32-chars',
    resave:false,
    saveUninitialized:false,
    cookie:{httpOnly:true,secure:true,sameSite:'none',maxAge:8*60*60*1000}
  }));
  registerPostgresAuthRoutes(app,{auth,access,demoEnabled:true,sessionSecret:'integration-test-session-secret-at-least-32-chars',cookieClearOptions:{path:'/',secure:true,sameSite:'none'}});
  const server=app.listen(0);
  const base=await new Promise(resolve=>server.once('listening',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
  let cookie='';
  try {
    let response=await fetch(`${base}/api/auth/mode`);
    assert.deepEqual(await response.json(),{mode:'demo',otpAvailable:false});
    response=await fetch(`${base}/api/auth/demo`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https'},body:JSON.stringify({persona:'not-a-role'})});
    assert.equal(response.status,400);
    response=await fetch(`${base}/api/auth/demo`,{method:'POST',headers:{'content-type':'application/json','x-forwarded-proto':'https'},body:JSON.stringify({persona:'teacher'})});
    assert.equal(response.status,200);
    const login=await response.json();
    assert.equal(login.user.role,'teacher');
    assert.equal(login.user.school_id,'DEMO-SCHOOL');
    assert.equal(login.user.isDemo,true);
    cookie=(response.headers.get('set-cookie')||'').split(';')[0];
    assert.ok(cookie.startsWith('athar.sid='));
    const setCookie=response.headers.get('set-cookie')||'';
    assert.match(setCookie,/; HttpOnly/i);
    assert.match(setCookie,/; Secure/i);
    assert.match(setCookie,/; SameSite=None/i);
    assert.match(setCookie,/; Path=\//i);
    // A second HTTP request carrying the cookie models a page refresh/session restore.
    response=await fetch(`${base}/api/auth/me`,{headers:{cookie,'x-forwarded-proto':'https'}});
    assert.equal(response.status,200);
    assert.equal((await response.json()).user.role,'teacher');
    response=await fetch(`${base}/api/auth/logout`,{method:'POST',headers:{cookie,'x-forwarded-proto':'https'}});
    assert.equal(response.status,200);
    const clearedCookie=response.headers.get('set-cookie')||'';
    assert.match(clearedCookie,/athar\\.sid=;/i);
    assert.match(clearedCookie,/; Path=\//i);
    assert.match(clearedCookie,/; Secure/i);
    assert.match(clearedCookie,/; SameSite=None/i);
    response=await fetch(`${base}/api/auth/me`,{headers:{cookie,'x-forwarded-proto':'https'}});
    assert.equal(response.status,401);
  } finally {
    await new Promise(resolve=>server.close(resolve));
  }
});

test('demo authentication is unavailable unless explicitly enabled', async () => {
  const app=express(); app.use(express.json());
  app.use(session({secret:'integration-test-session-secret-at-least-32-chars',resave:false,saveUninitialized:false}));
  registerPostgresAuthRoutes(app,{auth,access,demoEnabled:false,sessionSecret:'integration-test-session-secret-at-least-32-chars'});
  const server=app.listen(0);
  const base=await new Promise(resolve=>server.once('listening',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
  try {
    const response=await fetch(`${base}/api/auth/demo`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({persona:'teacher'})});
    assert.equal(response.status,404);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

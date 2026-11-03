import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.TEST_PORT || 3197);
const base = `http://127.0.0.1:${port}`;
let child;

function startServer() {
  child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', DEMO_LOGIN_ENABLED: 'true', FRONTEND_ORIGIN: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => process.stdout.write(data));
  child.stderr.on('data', data => process.stderr.write(data));
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  current.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => current.once('exit', resolve)),
    delay(5000).then(() => current.kill('SIGKILL'))
  ]);
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch {}
    await delay(500);
  }
  throw new Error('API did not become healthy within 20 seconds.');
}

async function request(path, { method = 'GET', body, cookie, expected = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (response.status !== expected) {
    throw new Error(`${method} ${path}: expected ${expected}, received ${response.status}: ${text}`);
  }
  return { response, data };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL smoke tests.');
  startServer();
  const health = await waitForHealth();
  if (health.database !== 'postgresql') throw new Error('Health endpoint did not identify PostgreSQL.');
  const mode = await request('/api/auth/mode');
  if (mode.data.mode !== 'demo') throw new Error('Demo login mode is not enabled for test run.');

  const login = await request('/api/auth/demo', { method:'POST', body:{ persona:'teacher' } });
  const setCookie = login.response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Login did not return a session cookie.');
  const cookie = setCookie.split(';')[0];
  const me = await request('/api/auth/me', { cookie });
  if (me.data.user.role !== 'teacher' || !me.data.user.isDemo) throw new Error('Demo teacher session is invalid.');

  const studentId = `PG-TEST-${Date.now()}`;
  const student = await request('/api/records', {
    method:'POST', cookie, expected:201,
    body:{ kind:'student', payload:{ student_id:studentId, name:'طالب اختبار PostgreSQL', grade:'5', section:'A' } }
  });
  const assessment = await request('/api/records', {
    method:'POST', cookie, expected:201,
    body:{ kind:'assessment', payload:{ student_id:studentId, skill:'تمثيل الكسور', pct:45, date:new Date().toISOString() } }
  });
  const listed = await request('/api/records', { cookie });
  if (!listed.data.records.some(row => row.payload?.student_id === studentId)) throw new Error('Created student was not returned by records endpoint.');

  const analysis = await request('/api/analysis', {
    method:'POST', cookie,
    body:{ student_id:studentId, skill:'تمثيل الكسور' }
  });
  if (!analysis.data.analysis || analysis.data.analysis.targetScore !== 45) throw new Error('Learning analysis did not use the saved PostgreSQL assessment.');

  await request(`/api/records/${assessment.data.id}`, { method:'DELETE', cookie });
  await request(`/api/records/${student.data.id}`, { method:'DELETE', cookie });

  await stopServer();
  startServer();
  await waitForHealth();
  const restored = await request('/api/auth/me', { cookie });
  if (restored.data.user.role !== 'teacher') throw new Error('Session did not survive an API restart.');

  await request('/api/auth/logout', { method:'POST', cookie });
  console.log('PASS: PostgreSQL health, demo authentication, JSONB records, learning analysis, record deletion, and persistent sessions.');
}

main()
  .catch(error => { console.error('PostgreSQL smoke test FAILED:', error); process.exitCode = 1; })
  .finally(async () => { await stopServer(); });

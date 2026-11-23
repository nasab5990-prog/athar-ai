import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static regression checks only: never imports server.js or touches PostgreSQL.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = server.indexOf(start);
  assert.notEqual(from, -1, `Missing source marker: ${start}`);
  const to = server.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Missing end marker: ${end}`);
  return server.slice(from, to);
}

test('production startup requires strong session and OTP secrets', () => {
  assert.match(server, /if \(production && \(!process\.env\.SESSION_SECRET \|\| process\.env\.SESSION_SECRET\.length < 32 \|\| !process\.env\.OTP_SECRET \|\| process\.env\.OTP_SECRET\.length < 32\)\)/);
});

test('sessions use PostgreSQL storage and secure production cookie attributes', () => {
  assert.match(server, /store:new PgSession\(\{ pool, tableName:'session', createTableIfMissing:true \}\)/);
  assert.match(server, /httpOnly:true/);
  assert.match(server, /secure:production/);
  assert.match(server, /sameSite:process\.env\.COOKIE_SAMESITE/);
  assert.match(server, /partitioned:production/);
  assert.match(server, /maxAge:8\*60\*60\*1000/);
});

test('authenticated requests reload active user records and enforce role guards', () => {
  const auth = section('const requireAuth = asyncRoute', 'async function linkedStudentIds');
  assert.match(auth, /req\.session\?\.user\?\.id/);
  assert.match(auth, /await freshUser\(id\)/);
  assert.match(auth, /!user \|\| !user\.active/);
  assert.match(auth, /const requireRole = \(\.\.\.roles\)/);
});

test('OTP login is rate limited, expires codes, caps attempts and compares hashes safely', () => {
  const otp = section("app.post('/api/auth/request-code'", "async function ensureDemoFixtures");
  assert.match(otp, /request-code',loginLimiter/);
  assert.match(otp, /verify-code',loginLimiter/);
  assert.match(otp, /row\.attempts>=5/);
  assert.match(otp, /expiresAtMs<Date\.now\(\)/);
  assert.match(otp, /safeHexEqual\(row\.code_hash,submittedHash\)/);
  assert.match(otp, /attempts=attempts\+1/);
});

test('failed OTP email delivery only removes the code from that send attempt', () => {
  const otp = section("app.post('/api/auth/request-code'", "app.post('/api/auth/verify-code'");
  assert.match(otp, /DELETE FROM otp_codes WHERE email=\$1 AND code_hash=\$2/);
  assert.match(otp, /hashOtp\(email,code\)/);
});

test('OTP verification consumes the matching unexpired code atomically to prevent replay', () => {
  const otp = section("app.post('/api/auth/verify-code'", "async function ensureDemoFixtures");
  assert.match(otp, /const consumeNow=otpExpiryUsesTimestamp\?new Date\(\):Date\.now\(\)/);
  assert.match(otp, /DELETE FROM otp_codes WHERE email=\$1 AND code_hash=\$2 AND attempts<5 AND expires_at>\$3 RETURNING email/);
  assert.match(otp, /if \(!consumed\.rowCount\) return res\.status\(401\)/);
  assert.match(otp, /UPDATE otp_codes SET attempts=attempts\+1 WHERE email=\$1 AND code_hash=\$2 AND attempts<5/);
  assert.match(otp, /DELETE FROM otp_codes WHERE email=\$1 AND code_hash=\$2/);
});

test('demo login is explicitly gated and restricted to supported personas', () => {
  const demo = section("app.post('/api/auth/demo'", "app.get('/api/auth/me'");
  assert.match(demo, /if \(!demoEnabled\)/);
  assert.match(demo, /\['teacher','senior_teacher','principal','supervisor','parent','student'\]/);
  assert.match(demo, /ensureDemoFixtures\(\)/);
});

test('login regenerates the session and logout destroys it and clears the cookie', () => {
  const login = section('async function sessionLogin', "app.get('/api/health'");
  const logout = section("app.post('/api/auth/logout'", "app.get('/api/records'");
  assert.match(login, /req\.session\.regenerate\(/);
  assert.match(login, /req\.session\.user=\{ id:user\.id \}/);
  assert.match(logout, /req\.session\.destroy\(/);
  assert.match(logout, /res\.clearCookie\('athar\.sid'\)/);
});

test('OTP request does not reveal whether an official email is registered', () => {
  const request = section("app.post('/api/auth/request-code'", "app.post('/api/auth/verify-code'");
  assert.match(request, /res\.json\(\{ message:'إذا كان البريد مسجلًا ومفعّلًا، فسيصلك رمز تحقق خلال لحظات\.' \}\)/);
  assert.match(request, /if \(user\?\.active\)/);
});

test('supervisor record feed is empty to prevent identifiable-record exposure', () => {
  const scope = section('async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /user\.role==='supervisor'[\s\S]*?return \[\]/);
});

test('principal and senior-teacher records are restricted to their own school', () => {
  const scope = section('async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /\['principal','senior_teacher'\][\s\S]*?WHERE school_id=\$1[\s\S]*?\[user\.school_id\]/);
});

test('parent and student records are restricted to linked IDs and matching school', () => {
  const scope = section('async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /linkedStudentIds\(user\)/);
  assert.match(scope, /WHERE r\.school_id=\$1/);
  assert.match(scope, /r\.payload->>'student_id'=ANY\(\$2::text\[\]\)/);
});

test('linked parent and student accounts can see class interventions for matching grade and section only', () => {
  const scope = section('async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /r\.kind='intervention'/);
  assert.match(scope, /COALESCE\(r\.payload->>'student_id',''\)=''/);
  assert.match(scope, /SELECT 1 FROM records s/);
  assert.match(scope, /s\.payload->>'student_id'=ANY\(\$2::text\[\]\)/);
  assert.match(scope, /r\.payload->'curriculum'->>'grade'/);
  assert.match(scope, /r\.payload->'curriculum'->>'section'/);
});

test('teacher record access remains school and assignment scoped', () => {
  const scope = section('async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /assignedStudentIds\(user\)/);
  assert.match(scope, /teacherTeachingAssignment\(user\)/);
  assert.match(scope, /WHERE school_id=\$1/);
  assert.match(scope, /payload->>'student_id'=ANY\(\$3::text\[\]\)/);
});

test('radar analysis must match the linked assessment student, scope, and skill', () => {
  const route = section("app.post('/api/analysis'", "app.use((error,req,res,next)=>");
  assert.match(route, /sourceAssessment\.payload/);
  assert.match(route, /String\(source\.student_id\|\|''\)!==String\(requestBody\.student_id\|\|''\)/);
  assert.match(route, /for\(const field of \['subject','grade','section'\]\)/);
  assert.match(route, /sourceSkill&&requestedSkill&&sourceSkill!==requestedSkill/);
  assert.match(route, /assessment_record_id:assessmentRecordId/);
});

test('individual assessments require a real student in the selected grade and section', () => {
  const route = section("app.post('/api/records'", "app.put('/api/records/:id'");
  assert.match(route, /assessmentScope==='individual'[\s\S]*?if\(!clean\.student_id\)/);
  assert.match(route, /WHERE school_id=\$1 AND kind='student' AND payload->>'student_id'=\$2/);
  assert.match(route, /normalizeGrade\(studentRow\.payload\?\.grade\)!==normalizeGrade\(clean\.grade\)/);
  assert.match(route, /studentRow\.payload\?\.section[\s\S]*?clean\.section/);
  assert.match(route, /\}else\{[\s\S]*?clean\.student_id=null/);
});

test('supervisor linked-impact counts require an existing intervention in the same school', () => {
  const route = section("app.get('/api/supervisor/schools'", "app.get('/api/supervisor/recommendations'");
  assert.ok(route.includes("COALESCE(r.payload->>'intervention_record_id','') ~ '^[0-9]+$'"));
  assert.ok(route.includes('EXISTS ('));
  assert.ok(route.includes('i.school_id=r.school_id'));
  assert.ok(route.includes("i.kind='intervention'"));
  assert.ok(route.includes("i.id::text=r.payload->>'intervention_record_id'"));
});

test('supervisor recommendations are limited to explicitly assigned schools', () => {
  const route = section("app.get('/api/supervisor/recommendations'", "app.get('/api/principal/recommendations'");
  assert.match(route, /supervisor_schools ss/);
  assert.match(route, /ss\.user_id=r\.supervisor_id AND ss\.school_id=r\.school_id/);
  assert.match(route, /WHERE r\.supervisor_id=\$1/);
});

test('principal recommendation updates are limited to the principal school', () => {
  const route = section("app.put('/api/principal/recommendations/:id'", "app.post('/api/records'");
  assert.match(route, /WHERE id=\$4 AND school_id=\$5/);
  assert.match(route, /req\.user\.school_id/);
});

test('parent and student class interventions normalize Arabic grade prefixes and section digits', () => {
  const scope = section('async function getRecordsForUser(user)', 'app.get(\'/api/records\'');
  assert.match(scope, /regexp_replace\(btrim\(COALESCE\(r\.payload->'curriculum'->>'grade',''\)\), '\^الصف\\\\s\*'/);
  assert.match(scope, /regexp_replace\(btrim\(COALESCE\(s\.payload->>'grade',''\)\), '\^الصف\\\\s\*'/);
  assert.match(scope, /translate\(btrim\(r\.payload->'curriculum'->>'section'\),'٠١٢٣٤٥٦٧٨٩','0123456789'\)=translate\(btrim\(COALESCE\(s\.payload->>'section',''\)\),'٠١٢٣٤٥٦٧٨٩','0123456789'\)/);
});


test('impact grade normalizer strips the Arabic الصف prefix and maps Arabic digits', () => {
  const helper = section('function normalizedGradeKey(value)', 'function assignedGradeLabels(grades)');
  assert.ok(helper.includes(String.raw`replace(/^الصف\s*/,'')`));
  assert.ok(helper.includes("replace(/[٠-٩]/g"));
  assert.ok(helper.includes("return labels[raw] || raw"));
  assert.match(helper, /function normalizedSectionKey/);
});

test('impact linked to a class intervention normalizes grade prefixes and Arabic section digits', () => {
  const route = section("app.post('/api/records'", "app.put('/api/records/:id'");
  assert.match(route, /normalizedGradeKey\(curriculum\.grade\)/);
  assert.match(route, /normalizedGradeKey\(studentRow\.payload\?\.grade\)/);
  assert.match(route, /normalizedSectionKey\(curriculum\.section\)/);
  assert.match(route, /normalizedSectionKey\(studentRow\.payload\?\.section\)/);
  assert.match(route, /interventionGrade!==studentGrade/);
  assert.match(route, /interventionSection!==studentSection/);
});

test('individual intervention create and edit enforce normalized student grade and section', () => {
  const createRoute = section("app.post('/api/records'", "app.put('/api/records/:id'");
  const updateRoute = section("app.put('/api/records/:id'", "app.delete('/api/records/:id'");
  for (const route of [createRoute, updateRoute]) {
    assert.match(route, /normalizedGradeKey\(curriculum\.grade\)!==normalizedGradeKey\(assignedGrade\)/);
    assert.match(route, /normalizedSectionKey\(curriculum\.section\)!==normalizedSectionKey\(assignedSection\)/);
    assert.match(route, /curriculum\.grade=assignedGrade/);
    assert.match(route, /curriculum\.section=assignedSection/);
  }
});

test('all roles must use an existing same-school student for individual interventions', () => {
  const createRoute = section("app.post('/api/records'", "app.put('/api/records/:id'");
  const updateRoute = section("app.put('/api/records/:id'", "app.delete('/api/records/:id'");
  assert.ok(createRoute.indexOf("if (clean.student_id)") < createRoute.indexOf("if (req.user.role==='teacher')"));
  assert.ok(updateRoute.indexOf("if (current.student_id)") < updateRoute.indexOf("if (req.user.role==='teacher')"));
  for (const route of [createRoute, updateRoute]) {
    assert.match(route, /WHERE school_id=\$1 AND kind='student' AND payload->>'student_id'=\$2/);
    assert.match(route, /normalizedGradeKey\(curriculum\.grade\)!==normalizedGradeKey\(assignedGrade\)/);
    assert.match(route, /normalizedSectionKey\(curriculum\.section\)!==normalizedSectionKey\(assignedSection\)/);
  }
});

test('class-wide impact without a selected student still enforces teacher teaching assignment', () => {
  const route = section("app.post('/api/records'", "app.put('/api/records/:id'");
  const impact = route.slice(route.indexOf("if (kind==='impact')"));
  assert.match(impact, /else if \(!clean\.student_id && !linkedStudentId && req\.user\.role==='teacher'\)/);
  assert.match(impact, /const classGrade=normalizedGradeKey\(linkedCurriculum\.grade\)/);
  assert.match(impact, /!linkedCurriculum\.subject/);
  assert.match(impact, /validateTeacherTeachingContext\(req\.user/);
  assert.match(impact, /section:normalizedSectionKey\(linkedCurriculum\.section\)/);
});


test('parents and students receive class-wide impact only through a matching same-school class intervention', () => {
  const scope = section('async function getRecordsForUser(user)', 'app.get(\'\/api\/records\'');
  assert.match(scope, /r\.kind='impact'/);
  assert.match(scope, /r\.payload->>'intervention_record_id'/);
  assert.match(scope, /i\.id::text=r\.payload->>'intervention_record_id'/);
  assert.match(scope, /i\.school_id=r\.school_id/);
  assert.match(scope, /i\.kind='intervention'/);
  assert.match(scope, /i\.payload->'curriculum'->>'grade'/);
  assert.match(scope, /i\.payload->'curriculum'->>'section'/);
  assert.match(scope, /s\.payload->>'student_id'=ANY\(\$2::text\[\]\)/);
  const classImpact = scope.slice(scope.indexOf("JOIN records s ON s.school_id=i.school_id"));
  assert.match(classImpact, /COALESCE\(r\.payload->>'student_id',''\)='' OR r\.payload->>'student_id'=s\.payload->>'student_id'/);
});


test('parents and students receive individual impact only when its intervention belongs to the same linked learner', () => {
  const scope = section('async function getRecordsForUser(user)', 'app.get(\'/api/records\'');
  assert.match(scope, /r\.kind<>'impact' AND r\.payload->>'student_id'=ANY\(\$2::text\[\]\)/);
  const individualImpact = scope.slice(scope.indexOf("r.kind='impact' AND COALESCE(r.payload->>'intervention_record_id'"));
  assert.match(individualImpact, /i\.id::text=r\.payload->>'intervention_record_id'/);
  assert.match(individualImpact, /i\.payload->>'student_id'=r\.payload->>'student_id'/);
  assert.match(individualImpact, /COALESCE\(r\.payload->>'student_id',''\)=ANY\(\$2::text\[\]\)/);
  assert.match(individualImpact, /i\.school_id=r\.school_id/);
});

test('impact writes require a same-school intervention and enforce teacher ownership', () => {
  const impact = section("if (kind==='impact') {", "if (clean.student_id) {");
  assert.match(impact, /SELECT id,owner_id,payload FROM records WHERE id=\$1 AND school_id=\$2 AND kind='intervention'/);
  assert.match(impact, /req\.user\.role==='teacher'[\s\S]*?linked\.owner_id[\s\S]*?req\.user\.id/);
  assert.match(impact, /linkedStudentId!==clean\.student_id/);
  assert.match(impact, /clean\.intervention_record_id=interventionId/);
});

test('impact writes validate real calendar dates, ordered measurements, modes and session counts', () => {
  const impact = section("if (kind==='impact') {", "if (clean.student_id) {");
  assert.match(impact, /validEvidenceDate=value=>/);
  assert.match(impact, /parsed\.toISOString\(\)\.slice\(0,10\)===date/);
  assert.match(impact, /clean\.before_date>clean\.after_date/);
  assert.match(impact, /\['offline','shared','online'\]/);
  assert.match(impact, /planned<1\|\|planned>30\|\|!Number\.isInteger\(done\)\|\|done<0\|\|done>planned/);
  assert.match(impact, /sessions_planned===undefined[\s\S]*?sessions_done===undefined/);
});

test('supervisor completed intervention count is distinct from total intervention count and school scoped', () => {
  const route = section("app.get('/api/supervisor/schools'", "app.get('/api/supervisor/recommendations'");
  assert.match(route, /COUNT\(r\.id\) FILTER \(WHERE r\.kind='intervention'\)::int AS interventions/);
  assert.match(route, /COUNT\(r\.id\) FILTER \(WHERE r\.kind='intervention' AND r\.payload->>'status'='completed'\)::int AS completed_interventions/);
  assert.match(route, /r\.school_id=s\.school_id/);
  assert.match(route, /GROUP BY s\.school_id,s\.school_name/);
});

test('supervisor documented impact count requires a valid same-school intervention link', () => {
  const route = section("app.get('/api/supervisor/schools'", "app.get('/api/supervisor/recommendations'");
  const documented = route.slice(route.indexOf("AS documented_impacts") > -1 ? route.lastIndexOf("COUNT(r.id) FILTER (WHERE r.kind='impact'", route.indexOf("AS documented_impacts")) : route.indexOf("COUNT(r.id) FILTER (WHERE r.kind='impact' AND length"));
  assert.match(documented, /intervention_record_id/);
  assert.match(documented, /EXISTS \(/);
  assert.match(documented, /i\.school_id=r\.school_id/);
  assert.match(documented, /i\.kind='intervention'/);
  assert.match(documented, /i\.id::text=r\.payload->>'intervention_record_id'/);
  assert.match(documented, /evidence_tool/);
  assert.match(documented, /sessions_done/);
});

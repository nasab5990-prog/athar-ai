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

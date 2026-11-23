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

test('teacher subject assignment matching collapses real whitespace sequences', () => {
  const helper = section('async function validateTeacherTeachingContext', 'async function studentExistsInSchool');
  assert.equal((helper.match(/replace\\(\\/\\\\s\\+\\/g/g) || []).length, 2);
});

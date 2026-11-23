import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static checks only. This suite never imports server.js, starts a listener,
// connects to PostgreSQL/SQLite, or writes application data.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Missing end marker: ${end}`);
  return source.slice(from, to);
}

test('supervisor role does not receive individual records', () => {
  const scope = section(server, 'function getRecordsForUser(user) {', 'function findStudentOwnedBy');
  const explicit = /user\.role\s*===\s*['"]supervisor['"][\s\S]*?return \[\]/.test(scope);
  const fallback = /return \[\]\s*;\s*\}/.test(scope);
  assert.ok(explicit || fallback, 'Supervisor must be explicitly denied or fall through to an empty result');
});

test('principal and senior-teacher records are school-scoped', () => {
  const scope = section(server, 'function getRecordsForUser(user) {', 'function findStudentOwnedBy');
  assert.match(scope, /principal/);
  assert.match(scope, /senior_teacher/);
  assert.match(scope, /school_id\s*=\s*\?/);
});

test('parents and students receive only linked learner records in their school', () => {
  const scope = section(server, 'function getRecordsForUser(user) {', 'function findStudentOwnedBy');
  assert.match(scope, /linkedStudentIds\(user\)/);
  assert.match(scope, /kind IN \('student','assessment','intervention','impact'\)/);
  assert.match(scope, /school_id\s*=\s*\?/);
  assert.match(scope, /student_id/);
});

test('teacher records are limited to the school and assigned learners', () => {
  const scope = section(server, 'function getRecordsForUser(user) {', 'function findStudentOwnedBy');
  assert.match(scope, /assignedStudentIds\(user\)/);
  assert.match(scope, /school_id\s*=\s*\?/);
  assert.match(scope, /owner_id/);
  assert.match(scope, /student_id/);
});

test('principal class intervention counts include matching grade and normalized section records', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /if \(i\.student_id\) return ids\.has\(i\.student_id\)/);
  assert.match(view, /gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /sectionNumber\(curriculum\.section\)/);
  assert.match(view, /sectionNumber\(group\[0\]\?\.section\)/);
});

test('reports list only impact measurements linked to an existing intervention', () => {
  const report = section(app, 'const interventionById = new Map(interventions.map', 'const impactRowsHtml = linkedImpactRows');
  assert.match(report, /interventions\.map\(item => \[String\(item\.recordId\), item\]\)/);
  assert.match(report, /if \(!intervention\) return false/);
  assert.match(report, /if \(intervention\.student_id\) return String\(item\.student_id \|\| ''\) === String\(intervention\.student_id\)/);
});

test('student progress includes individual and matching class interventions with normalized sections', () => {
  const view = section(app, 'function renderStudentProgress() {', 'function renderPrincipalView()');
  assert.match(view, /if \(i\.student_id\) return i\.student_id === student\.student_id/);
  assert.match(view, /gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /sectionNumber\(curriculum\.section\)/);
  assert.match(view, /sectionNumber\(student\.section\)/);
});

test('grade and section helpers normalize Arabic digits and grade prefixes', () => {
  const helper = section(app, 'function gradeNumber(value)', 'function filterInterventionStudents()');
  assert.ok(helper.includes(String.raw`replace(/^الصف\\s*/,'')`));
  assert.ok(helper.includes("replace(/[٠-٩]/g"));
  assert.ok(helper.includes('function sectionNumber(value)'));
});


test('principal summaries group equivalent Arabic and Western grade and section labels together', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /gradeNumber\(student\.grade\)/);
  assert.match(view, /sectionNumber\(student\.section\)/);
  assert.match(view, /groups\.has\(key\)/);
});

test('principal class summaries include class-wide assessments only in matching grade and section', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /if \(a\.student_id\) return ids\.has\(a\.student_id\)/);
  assert.match(view, /gradeNumber\(a\.grade\) === gradeNumber\(group\[0\]\?\.grade\)/);
  assert.match(view, /sectionNumber\(a\.section\) === sectionNumber\(group\[0\]\?\.section\)/);
});

test('latest assessment summaries keep subjects grades and sections separate', () => {
  const helper = section(app, 'function latestAssessmentRows(rows = assessments)', 'let supervisorRecommendations');
  assert.match(helper, /assessment\.subject/);
  assert.match(helper, /gradeNumber\(assessment\.grade\)/);
  assert.match(helper, /sectionNumber\(assessment\.section\)/);
  assert.match(helper, /displaySkillName\(assessment\.skill/);
});




test('student progress shows impact linked to visible class interventions', () => {
  const view = section(app, 'function renderStudentProgress() {', 'function renderPrincipalView()');
  assert.match(view, /const visibleInterventionIds = new Set\(interventionRows\.map/);
  assert.match(view, /i\.student_id === student\.student_id/);
  assert.match(view, /visibleInterventionIds\.has\(String\(i\.intervention_record_id\)\)/);
});


test('supervisor report separates unlinked and linked-but-undocumented impacts', () => {
  const report = section(app, 'function renderReports() {', 'let schoolGradeSections');
  assert.match(report, /Math\.max\(0, impactsCount - linkedCount\)/);
  assert.match(report, /Math\.max\(0, linkedCount - documentedCount\)/);
  assert.match(report, /من '\+linkedCount\+' المرتبطة/);
  assert.match(report, /غير المرتبط: '\+Math\.max\(0,schoolImpacts-schoolLinked\)/);
});

test('student progress keeps same-named skills separate across subjects and class scopes', () => {
  const view = section(app, 'function renderStudentProgress() {', 'function renderPrincipalView()');
  assert.match(view, /latestAssessmentRows\(personal\)/);
  assert.match(view, /String\(a\.subject \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(view, /gradeNumber\(a\.grade\)/);
  assert.match(view, /sectionNumber\(a\.section\)/);
  assert.match(view, /displaySkillName\(a\.skill \|\| a\.name/);
});

test('principal mastery average never blends class-wide and individual assessment results', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /const individualAssessments = latestAssessmentRows\(scopedAssessments\.filter\(a => a\.student_id\)\)/);
  assert.match(view, /const classAssessments = latestAssessmentRows\(scopedAssessments\.filter\(a => !a\.student_id\)\)/);
  assert.match(view, /const learnerMastery = \[\.\.\.learnerAverages\.values\(\)\]/);
  assert.match(view, /const average = learnerMastery\.length/);
  assert.match(view, /: classAssessments\.length/);
  assert.match(view, /النتائج الفردية:/);
  assert.match(view, /التقويمات الصفية:/);
});

test('principal mastery average weights each learner equally and labels low-mastery counts accurately', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /const learnerAverages = new Map\(\)/);
  assert.match(view, /learnerAverages\.get\(learnerId\)\.push\(Number\(assessment\.pct \|\| 0\)\)/);
  assert.match(view, /const learnerMastery = \[\.\.\.learnerAverages\.values\(\)\]/);
  assert.match(view, /learnerMastery\.reduce\(\(sum, value\) => sum \+ value, 0\) \/ learnerMastery\.length/);
  assert.match(view, /classAssessments\.reduce\(\(sum, assessment\) => sum \+ Number\(assessment\.pct \|\| 0\), 0\) \/ classAssessments\.length/);
  assert.match(view, /const gapLabel = individualAssessments\.length \? 'طلبة دون 70%' : 'نتائج صفية دون 70%'/);
});

test('latest assessment selection relies on newest-first record ordering', () => {
  const loader = section(server, 'async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(loader, /ORDER BY id DESC/);
  const latest = section(app, 'function latestAssessmentRows(rows = assessments) {', 'let supervisorRecommendations');
  assert.match(latest, /if \(!latest\.has\(key\)\) latest\.set\(key, assessment\)/);
});

test('general reports separate individual and class assessment populations and group skills by subject', () => {
  const view = section(app, 'function renderReports() {', 'let schoolGradeSections');
  assert.match(view, /const individualReportAssessments = latestAssessmentRows\(allLatestAssessments\.filter\(a => a\.student_id\)\)/);
  assert.match(view, /const classReportAssessments = latestAssessmentRows\(allLatestAssessments\.filter\(a => !a\.student_id\)\)/);
  assert.match(view, /const currentAssessments = individualReportAssessments\.length \? individualReportAssessments : classReportAssessments/);
  assert.match(view, /const label = subject \? subject \+ ' — ' \+ skill : skill/);
  assert.match(view, /عدد النتائج الفردية:/);
  assert.match(view, /عدد التقويمات الصفية:/);
});

test('report impact rows require a valid intervention and matching learner or class scope', () => {
  const view = section(app, 'function renderReports() {', 'let schoolGradeSections');
  assert.match(view, /const interventionById = new Map\(interventions\.map/);
  assert.match(view, /if \(intervention\.student_id\) return String\(item\.student_id \|\| ''\) === String\(intervention\.student_id\)/);
  assert.match(view, /const learnerGrade = gradeNumber\(learner\?\.grade\)/);
  assert.match(view, /const targetGrade = gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /if \(targetSection && targetSection !== sectionNumber\(learner\.section\)\) return false/);
  assert.match(view, /const skill = displaySkillName\(intervention\?\.skill/);
});

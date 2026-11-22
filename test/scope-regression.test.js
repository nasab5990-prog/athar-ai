import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static regression checks only: this file deliberately does not import server.js,
// start an HTTP listener, connect to PostgreSQL, or write any application data.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `Missing source marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `Missing end marker: ${end}`);
  return source.slice(from, to);
}

test('supervisors cannot retrieve identifiable records through the records endpoint', () => {
  const scope = section(server, 'async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /user\.role==='supervisor'[\s\S]*?return \[\]/);
});

test('principals and senior teachers are restricted to their own school records', () => {
  const scope = section(server, 'async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /\['principal','senior_teacher'\][\s\S]*?WHERE school_id=\$1[\s\S]*?\[user\.school_id\]/);
});

test('parents and students receive only linked learners within their own school', () => {
  const scope = section(server, 'async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /linkedStudentIds\(user\)/);
  assert.match(scope, /kind IN \('student','assessment','intervention','impact'\)/);
  assert.match(scope, /WHERE school_id=\$1[\s\S]*?payload->>'student_id'=ANY\(\$2::text\[\]\)/);
});

test('teachers receive records limited by their assigned learners and school', () => {
  const scope = section(server, 'async function getRecordsForUser(user) {', 'async function sessionLogin');
  assert.match(scope, /assignedStudentIds\(user\)/);
  assert.match(scope, /teacherTeachingAssignment\(user\)/);
  assert.match(scope, /WHERE school_id=\$1/);
  assert.match(scope, /payload->>'student_id'=ANY\(\$3::text\[\]\)/);
});

test('principal class intervention counts include matching grade and section records', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /if \(i\.student_id\) return ids\.has\(i\.student_id\)/);
  assert.match(view, /gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /interventionSection === String\(group\[0\]?.section/);
});

test('student progress includes individual and matching class interventions', () => {
  const view = section(app, 'function renderStudentProgress() {', 'function renderPrincipalView()');
  assert.match(view, /if \(i\.student_id\) return i\.student_id === student\.student_id/);
  assert.match(view, /gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /section === String\(student\.section/);
});

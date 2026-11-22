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

test('principal class intervention counts include matching grade and section records', () => {
  const view = section(app, 'function renderPrincipalView() {', 'let supervisorReportSchoolId');
  assert.match(view, /if \(i\.student_id\) return ids\.has\(i\.student_id\)/);
  assert.match(view, /gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /interventionSection === String\(group\[0\]\?\.section/);
});

test('student progress includes individual and matching class interventions', () => {
  const view = section(app, 'function renderStudentProgress() {', 'function renderPrincipalView()');
  assert.match(view, /if \(i\.student_id\) return i\.student_id === student\.student_id/);
  assert.match(view, /gradeNumber\(curriculum\.grade\)/);
  assert.match(view, /section === String\(student\.section/);
});

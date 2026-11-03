import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canManageSchoolUsers,
  canCreateEducationalRecords,
  canRunLearningAnalysis
} from '../db/role-policy.js';

const roles = ['teacher', 'senior_teacher', 'principal', 'parent', 'student'];

test('only a principal outside the demo school can manage school users', () => {
  for (const role of roles) {
    assert.equal(
      canManageSchoolUsers({ role, school_id: 'SCHOOL-1' }),
      role === 'principal',
      `unexpected user-management permission for ${role}`
    );
  }
  assert.equal(canManageSchoolUsers({ role: 'principal', school_id: 'DEMO-SCHOOL' }), false);
  assert.equal(canManageSchoolUsers(null), false);
});

test('only instructional staff can create educational records', () => {
  for (const role of roles) {
    assert.equal(
      canCreateEducationalRecords({ role }),
      ['teacher', 'senior_teacher', 'principal'].includes(role)
    );
  }
  assert.equal(canCreateEducationalRecords(undefined), false);
});

test('only instructional staff can run learning analysis', () => {
  for (const role of roles) {
    assert.equal(
      canRunLearningAnalysis({ role }),
      ['teacher', 'senior_teacher', 'principal'].includes(role)
    );
  }
  assert.equal(canRunLearningAnalysis(null), false);
});

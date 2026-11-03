export const EDUCATIONAL_ROLES = Object.freeze(['teacher', 'senior_teacher', 'principal']);

export function canManageSchoolUsers(user) {
  return user?.role === 'principal' && user.school_id !== 'DEMO-SCHOOL';
}

export function canCreateEducationalRecords(user) {
  return EDUCATIONAL_ROLES.includes(user?.role);
}

export function canRunLearningAnalysis(user) {
  return EDUCATIONAL_ROLES.includes(user?.role);
}

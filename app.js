/* ATHAR AI v3 — centralized records, strict roles, and data-driven learning analysis. */
let students = [];
let assessments = [];
let interventions = [];
let editingInterventionId = null;
let impacts = [];
let analyses = [];
let currentRole = null;
let currentUser = null;
let loginMode = 'otp';
let linkedStudentIds = [];
const API_BASE = String(window.ATHAR_CONFIG?.apiBase || '').replace(/\/$/, '');
const apiUrl = path => `${API_BASE}${path}`;

async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({ message: 'استجابة غير مفهومة من الخادم.' }));
  if (!response.ok) throw new Error(data.message || `تعذر تنفيذ الطلب (${response.status})`);
  return data;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}
function displaySkillName(value) {
  const name = String(value ?? '').trim();
  return ['الفهم القرائي','فهم المقروء','الفهم المقروء'].includes(name) ? 'الفهم المقروء' : name;
}
function setAuthMessage(message, error = false) {
  const el = document.getElementById('authMessage');
  if (el) { el.textContent = message; el.style.color = error ? '#C62828' : '#00796B'; }
}
function setLoginMode(mode) {
  loginMode = mode;
  const otp = document.getElementById('otpLoginArea');
  const demo = document.getElementById('demoLoginArea');
  const modeNote = document.getElementById('loginModeNote');
  if (otp) otp.hidden = mode === 'demo';
  if (demo) demo.hidden = mode !== 'demo';
  if (modeNote) modeNote.textContent = mode === 'demo'
    ? 'بيئة اختبار معزولة ببيانات اصطناعية. لا تدخل بيانات حقيقية للطلبة.'
    : 'الدخول الرسمي متاح للحسابات المسجلة على نطاقي الوزارة. يحدد مسؤول النظام دور الحساب.';
  const subtitle = document.getElementById('loginSubtitle');
  if (subtitle) subtitle.textContent = mode === 'demo' ? 'اختبار أدوار المنصة ببيانات تجريبية' : 'دخول آمن بالبريد الإلكتروني الرسمي';
}
async function refreshLoginMode() {
  try {
    const result = await api('/api/auth/mode');
    setLoginMode(result.mode === 'demo' ? 'demo' : 'otp');
    if (result.mode !== 'demo' && !result.otpAvailable) setAuthMessage('الدخول الرسمي غير جاهز: يلزم إعداد خدمة البريد في الخادم.', true);
  } catch {
    setLoginMode('otp');
    setAuthMessage('تعذر الاتصال بالخادم. تحقق من رابط API وإعدادات النشر.', true);
  }
}
async function requestLoginCode() {
  const email = document.getElementById('loginEmail')?.value.trim().toLowerCase() || '';
  if (!email) return setAuthMessage('أدخل بريدك الإلكتروني الرسمي.', true);
  const btn = document.getElementById('requestCodeBtn');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/api/auth/request-code', { method:'POST', body:JSON.stringify({ email }) });
    document.getElementById('otpArea').hidden = false;
    setAuthMessage(result.message || 'تم طلب رمز التحقق.');
  } catch (error) { setAuthMessage(error.message, true); }
  finally { if (btn) btn.disabled = false; }
}
async function verifyLoginCode() {
  const email = document.getElementById('loginEmail')?.value.trim().toLowerCase() || '';
  const code = document.getElementById('loginCode')?.value.trim() || '';
  if (!/^\d{6}$/.test(code)) return setAuthMessage('أدخل رمز التحقق المكوّن من 6 أرقام.', true);
  const btn = document.getElementById('verifyCodeBtn');
  if (btn) btn.disabled = true;
  try {
    const result = await api('/api/auth/verify-code', { method:'POST', body:JSON.stringify({ email, code }) });
    await acceptLogin(result.user);
  } catch (error) { setAuthMessage(error.message, true); }
  finally { if (btn) btn.disabled = false; }
}
async function demoLogin() {
  const btn = document.getElementById('demoLoginBtn');
  if (btn) btn.disabled = true;
  try {
    const persona = document.getElementById('demoPersona')?.value || 'teacher';
    const result = await api('/api/auth/demo', { method:'POST', body:JSON.stringify({ persona }) });
    await acceptLogin(result.user);
    setAuthMessage(result.warning || 'تم الدخول إلى بيئة الاختبار.');
  } catch (error) { setAuthMessage(error.message, true); }
  finally { if (btn) btn.disabled = false; }
}
async function acceptLogin(user) {
  currentUser = user;
  currentRole = user.role;
  linkedStudentIds = user.linkedStudentIds || [];
  const demoNotice = document.getElementById('demoEnvironmentBanner');
  if (demoNotice) demoNotice.hidden = !user.isDemo && user.school_id !== 'DEMO-SCHOOL';
  document.getElementById('loginScreen')?.classList.add('hidden');
  applyRoleUI();
  try { await loadRecords(); }
  catch (error) { showToast(`تم الدخول، لكن تعذّر تحميل السجلات: ${error.message}`); }
  showToast(`مرحبًا ${user.name || user.email} — ${getRoleName(currentRole)}`);
}
async function restoreSession() {
  await refreshLoginMode();
  let result;
  try { result = await api('/api/auth/me'); }
  catch {
    currentUser = null;
    currentRole = null;
    document.getElementById('loginScreen')?.classList.remove('hidden');
    return;
  }
  currentUser = result.user;
  currentRole = result.user.role;
  linkedStudentIds = result.user.linkedStudentIds || [];
  const demoNotice = document.getElementById('demoEnvironmentBanner');
  if (demoNotice) demoNotice.hidden = !result.user.isDemo;
  document.getElementById('loginScreen')?.classList.add('hidden');
  applyRoleUI();
  try { await loadRecords(); }
  catch (error) { showToast(`تعذّر تحميل السجلات: ${error.message}`); }
}
async function logout() {
  try { await api('/api/auth/logout', { method:'POST' }); } catch { /* Session may already have expired. */ }
  currentUser = null; currentRole = null; linkedStudentIds = [];
  const demoNotice = document.getElementById('demoEnvironmentBanner'); if (demoNotice) demoNotice.hidden = true;
  students = []; assessments = []; interventions = []; impacts = []; analyses = [];
  document.getElementById('loginCode') && (document.getElementById('loginCode').value = '');
  document.getElementById('loginScreen')?.classList.remove('hidden');
  await refreshLoginMode();
}

async function syncRecord(kind, payload) {
  if (!currentUser) throw new Error('الجلسة غير متصلة. سجّل الدخول مجددًا.');
  return api('/api/records', { method:'POST', body:JSON.stringify({ kind, payload }) });
}
async function loadRecords() {
  const result = await api('/api/records');
  const rows = result.records || [];
  students = rows.filter(x => x.kind === 'student').map(x => ({ ...x.payload, recordId:x.id }));
  assessments = rows.filter(x => x.kind === 'assessment').map(x => ({ ...x.payload, recordId:x.id }));
  interventions = rows.filter(x => x.kind === 'intervention').map(x => ({ ...x.payload, recordId:x.id }));
  impacts = rows.filter(x => x.kind === 'impact').map(x => ({ ...x.payload, recordId:x.id }));
  analyses = rows.filter(x => x.kind === 'analysis').map(x => ({ ...x.payload, recordId:x.id }));
  renderStudents(); renderAssess(); renderInt(); fillStudentSelects();
  renderImpactHistory(); renderAnalysisHistory();
  renderStudentProgress(); renderPrincipalView(); updateDashboard(); updateCycle(); updateAlerts(); updateStatus(); renderReports();
}

// Curriculum selectors are populated only from verified curriculum records.
const ATHAR_CURRICULUM_CATALOG = window.ATHAR_CURRICULUM_CATALOG || {};
const ATHAR_SUBJECTS_BY_GRADE = window.ATHAR_SUBJECTS_BY_GRADE || {};
function setCurriculumOptions(select, placeholder, values) {
  if (!select) return;
  select.innerHTML = '';
  const first = document.createElement('option');
  first.value = ''; first.textContent = placeholder; select.appendChild(first);
  (values || []).forEach(item => {
    const option = document.createElement('option');
    option.value = typeof item === 'string' ? item : item.id;
    option.textContent = typeof item === 'string' ? item : item.title;
    select.appendChild(option);
  });
  select.disabled = !(values || []).length;
}
function updateCurriculumSubjects() {
  const grade = document.getElementById('intGrade')?.value || '';
  const subject = document.getElementById('intSubject');
  const unit = document.getElementById('intUnit');
  const lesson = document.getElementById('intLesson');
  const outcome = document.getElementById('intOutcome');
  const status = document.getElementById('curriculumCatalogStatus');
  const rows = ATHAR_CURRICULUM_CATALOG[grade] || {};
  const subjects = Object.keys(rows);
  const verifiedSubjects = subjects.length ? subjects : ATHAR_SUBJECTS_BY_GRADE[grade] || [];
  setCurriculumOptions(subject, grade ? 'اختر المادة' : 'اختر الصف أولًا', verifiedSubjects);
  setCurriculumOptions(unit, 'اختر المادة أولًا', []);
  setCurriculumOptions(lesson, 'اختر الوحدة أولًا', []);
  if (outcome) outcome.value = '';
  document.getElementById('curriculumUnitField').hidden = true;
  document.getElementById('curriculumLessonField').hidden = true;
  document.getElementById('curriculumOutcomeField').hidden = true;
  if (status) {
    status.hidden = !grade || !verifiedSubjects.length;
    status.textContent = !grade ? '' : verifiedSubjects.length
      ? 'لم تُفهرس وحدات هذا الصف بالكامل بعد؛ لن نعرض إلا المحتوى الموثق.'
      : 'فهرسة مواد هذا الصف قيد الاستكمال.';
  }
}
function updateCurriculumUnits() {
  const grade = document.getElementById('intGrade')?.value || '';
  const subject = document.getElementById('intSubject')?.value || '';
  const rows = ATHAR_CURRICULUM_CATALOG[grade]?.[subject] || {};
  const unitKeys = Object.keys(rows);
  const unitField = document.getElementById('curriculumUnitField');
  const lessonField = document.getElementById('curriculumLessonField');
  const outcomeField = document.getElementById('curriculumOutcomeField');
  if (unitField) unitField.hidden = !unitKeys.length;
  if (lessonField) lessonField.hidden = true;
  if (outcomeField) outcomeField.hidden = true;
  setCurriculumOptions(document.getElementById('intUnit'), 'اختر الوحدة', unitKeys.map(key => ({id:key,title:rows[key].title || key})));
  setCurriculumOptions(document.getElementById('intLesson'), 'اختر الوحدة أولًا', []);
  const outcome = document.getElementById('intOutcome'); if (outcome) outcome.value = '';
  const status = document.getElementById('curriculumCatalogStatus');
  if (status) { status.hidden = !!unitKeys.length; status.textContent = unitKeys.length ? '' : 'لا تتوفر وحدات موثقة لهذه المادة بعد.'; }
}
function updateCurriculumLessons() {
  const grade = document.getElementById('intGrade')?.value || '';
  const subject = document.getElementById('intSubject')?.value || '';
  const unit = document.getElementById('intUnit')?.value || '';
  const lessons = ATHAR_CURRICULUM_CATALOG[grade]?.[subject]?.[unit]?.lessons || {};
  const lessonKeys = Object.keys(lessons);
  const lessonField = document.getElementById('curriculumLessonField');
  const outcomeField = document.getElementById('curriculumOutcomeField');
  if (lessonField) lessonField.hidden = !lessonKeys.length;
  if (outcomeField) outcomeField.hidden = true;
  setCurriculumOptions(document.getElementById('intLesson'), 'اختر الدرس', lessonKeys.map(key => ({id:key,title:lessons[key].title || key})));
  const outcome = document.getElementById('intOutcome'); if (outcome) outcome.value = '';
  const status = document.getElementById('curriculumCatalogStatus');
  if (status) { status.hidden = !!lessonKeys.length; status.textContent = lessonKeys.length ? '' : 'لا تتوفر دروس موثقة لهذه الوحدة بعد.'; }
}
function updateCurriculumOutcome() {
  const grade = document.getElementById('intGrade')?.value || '';
  const subject = document.getElementById('intSubject')?.value || '';
  const unit = document.getElementById('intUnit')?.value || '';
  const lesson = document.getElementById('intLesson')?.value || '';
  const record = ATHAR_CURRICULUM_CATALOG[grade]?.[subject]?.[unit]?.lessons?.[lesson];
  const outcome = document.getElementById('intOutcome');
  if (outcome) outcome.value = record?.learning_outcome || '';
  const outcomeField = document.getElementById('curriculumOutcomeField');
  if (outcomeField) outcomeField.hidden = !record?.learning_outcome;
  const status = document.getElementById('curriculumCatalogStatus');
  if (status) { status.hidden = !!record?.learning_outcome; status.textContent = record?.learning_outcome ? '' : 'لا يوجد ناتج تعلم موثق لهذا الدرس حتى الآن.'; }
}

function toggleGroup(el) {
  const group = el?.parentElement;
  if (!group) return;
  const wasOpen = group.classList.contains('open');
  document.querySelectorAll('.menu-group.open').forEach(item => item.classList.remove('open'));
  if (!wasOpen) group.classList.add('open');
}
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (window.innerWidth <= 900) {
    sidebar.classList.toggle('open');
    document.body.classList.toggle('sidebar-open', sidebar.classList.contains('open'));
  } else {
    sidebar.classList.toggle('closed');
    document.body.classList.toggle('sidebar-closed', sidebar.classList.contains('closed'));
  }
}
const roleSections = {
  teacher: ['dashboard','students','assessment','radar','assistant','intervention','activities','impact','reports','inclusive','lowresource','privacy','teacherdev','curriculum','guide','about'],
  senior_teacher: ['dashboard','students','assessment','radar','assistant','intervention','activities','impact','reports','principalView','inclusive','lowresource','privacy','teacherdev','curriculum','guide','about'],
  principal: ['dashboard','students','assessment','radar','assistant','intervention','activities','impact','reports','principalView','roles','inclusive','lowresource','privacy','teacherdev','curriculum','guide','about'],
  parent: ['dashboard','studentProgress','guide','privacy','about'],
  student: ['dashboard','studentProgress','guide','privacy','about']
};
function canOpenSection(id) { return (roleSections[currentRole] || []).includes(id); }
function show(id) {
  if (!canOpenSection(id)) return showToast('هذه الصفحة غير متاحة لدور حسابك.');
  document.querySelectorAll('.section').forEach(section => section.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  document.querySelectorAll('.sidebar a[data-section]').forEach(link => link.classList.toggle('active', link.dataset.section === id));
  window.scrollTo({ top:0, behavior:'smooth' });
  if (window.innerWidth <= 900) {
    document.getElementById('sidebar')?.classList.remove('open');
    document.body.classList.remove('sidebar-open');
  }
  if (id === 'students') renderStudents();
  if (id === 'assessment') renderAssess();
  if (id === 'intervention') renderInt();
  if (id === 'studentProgress') renderStudentProgress();
  if (id === 'principalView') renderPrincipalView();
  if (id === 'roles' && currentRole === 'principal') loadSchoolUsers();
  if (id === 'reports') renderReports();
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('intGrade')?.addEventListener('change', updateCurriculumSubjects);
  document.getElementById('intSubject')?.addEventListener('change', updateCurriculumUnits);
  document.getElementById('intUnit')?.addEventListener('change', updateCurriculumLessons);
  document.getElementById('intLesson')?.addEventListener('change', updateCurriculumOutcome);
  document.querySelectorAll('.sidebar a[data-section]').forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); show(link.dataset.section);
  }));
  restoreSession();
});
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.style.display = 'none'; }, 2800);
}
function toggleDark() {
  document.body.classList.toggle('dark');
  localStorage.setItem('athar_dark', document.body.classList.contains('dark'));
}
if (localStorage.getItem('athar_dark') === 'true') document.body.classList.add('dark');
function togglePresentation() {
  document.body.classList.toggle('presentation');
  showToast(document.body.classList.contains('presentation') ? 'وضع العرض مفعّل' : 'وضع العرض متوقف');
}
function getRoleName(role) {
  return ({ teacher:'المعلم', senior_teacher:'المعلم الأول', principal:'المدير', parent:'ولي الأمر', student:'الطالب' })[role] || 'مستخدم';
}
function applyRoleUI() {
  const allowed = roleSections[currentRole] || [];
  document.querySelectorAll('.sidebar a[data-section]').forEach(link => {
    link.style.display = allowed.includes(link.dataset.section) ? '' : 'none';
  });
  document.querySelectorAll('.menu-group').forEach(group => {
    const visible = [...group.querySelectorAll('a[data-section]')].some(link => link.style.display !== 'none');
    group.style.display = visible ? '' : 'none';
  });
  const roleInfo = document.getElementById('roleInfo');
  if (roleInfo) roleInfo.innerHTML = `<div class="card"><strong>${esc(getRoleName(currentRole))}</strong><p>${esc(({ teacher:'إدارة طلبة الفصول والتقويمات والتدخلات المسندة إليك.', senior_teacher:'متابعة سجلات المدرسة والتدخلات ومؤشرات الصفوف.', principal:'إدارة حسابات المدرسة ومتابعة المؤشرات والسجلات.', parent:'متابعة الأبناء المرتبطين بحسابك فقط.', student:'متابعة تقدمك ونتائجك الفردية فقط.' })[currentRole] || '')}</p></div>`;
  const accountAdmin = document.getElementById('accountAdmin');
  if (accountAdmin) accountAdmin.hidden = currentRole !== 'principal';
  document.getElementById('currentUserLabel') && (document.getElementById('currentUserLabel').textContent = `${currentUser?.name || ''} • ${getRoleName(currentRole)}`);
  const dataAdmin = document.getElementById('teacherDataAdmin');
  if (dataAdmin) dataAdmin.hidden = ['parent','student'].includes(currentRole);
  const progressTitle = document.getElementById('progressPageTitle');
  if (progressTitle) progressTitle.textContent = currentRole === 'student' ? 'تقدمي الدراسي' : 'متابعة الأبناء';
  const progressLabel = document.getElementById('progressStudentLabel');
  if (progressLabel) progressLabel.textContent = currentRole === 'student' ? 'سجلك الدراسي' : 'اختيار الابن';
}

function fillStudentSelects() {
  const selectors = ['assessmentStudent','interventionStudent','impactStudent','analysisStudent','assistantStudent','progressStudent','accountStudentIds'];
  for (const id of selectors) {
    const select = document.getElementById(id);
    if (!select) continue;
    const previous = id === 'accountStudentIds' ? [...select.selectedOptions].map(o => o.value) : select.value;
    const includeAll = ['assessmentStudent','interventionStudent','impactStudent','analysisStudent','assistantStudent'].includes(id);
    select.innerHTML = includeAll ? '<option value="">تقويم/تدخل صفي (دون ربط بطالب)</option>' : '';
    for (const student of students) {
      const option = document.createElement('option');
      option.value = student.student_id;
      option.textContent = `${student.name} — ${student.grade || ''} ${student.section || ''}`;
      select.appendChild(option);
      if (id === 'accountStudentIds' && previous.includes(option.value)) option.selected = true;
    }
    if (id !== 'accountStudentIds' && previous && [...select.options].some(o => o.value === previous)) select.value = previous;
  }
  fillImpactInterventions();
  if (currentRole === 'student' || currentRole === 'parent') {
    const progress = document.getElementById('progressStudent');
    if (progress) {
      progress.innerHTML = '';
      const visible = students.filter(s => linkedStudentIds.includes(s.student_id));
      for (const s of visible) {
        const option = document.createElement('option'); option.value = s.student_id; option.textContent = s.name; progress.appendChild(option);
      }
      if (currentRole === 'student' && linkedStudentIds[0]) progress.value = linkedStudentIds[0];
      progress.disabled = currentRole === 'student';
    }
  }
}

async function fillImpactInterventions() {
  const select = document.getElementById('impactIntervention');
  if (!select) return;
  const studentId = document.getElementById('impactStudent')?.value || '';
  const previous = select.value;
  const rows = interventions.filter(item => studentId
    ? item.student_id === studentId
    : true
  );
  select.innerHTML = '<option value="">اختر التدخل المرتبط بالقياس</option>';
  rows.forEach(item => {
    if (item.recordId === undefined || item.recordId === null) return;
    const option = document.createElement('option');
    option.value = String(item.recordId);
    const studentName = item.student_name || students.find(student => student.student_id === item.student_id)?.name || 'تدخل صفي';
    option.textContent = `${displaySkillName(item.skill || 'مهارة غير محددة')} — ${studentName} — ${formatDate(item.date)}`;
    select.appendChild(option);
  });
  if (previous && [...select.options].some(option => option.value === previous)) select.value = previous;
  if (studentId && !rows.length) {
    select.innerHTML = '<option value="">لا توجد تدخلات مسجلة لهذا الطالب</option>';
  }
}

function renderStudents() {
  const el = document.getElementById('studentsList');
  const countEl = document.getElementById('studentCount');
  if (!el) return;
  const grade = document.getElementById('filterGrade')?.value || '';
  const section = document.getElementById('filterSection')?.value.trim() || '';
  const filtered = students.filter(student => (!grade || student.grade === grade) && (!section || student.section === section));
  if (countEl) countEl.textContent = String(filtered.length);
  el.innerHTML = filtered.length ? filtered.map(student => `<div class="student-row" style="padding:.65rem 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:.6rem;align-items:center"><div><strong>${esc(student.name)}</strong><div class="subtitle">${esc(student.grade || '—')} • شعبة ${esc(student.section || '—')}</div></div><button class="btn small outline" onclick="removeStudent('${esc(student.student_id)}')">حذف</button></div>`).join('') : '<p class="note">لا توجد سجلات طلبة مطابقة. أضف طالبًا لتبدأ.</p>';
}
function makeId() {
  return globalThis.crypto?.randomUUID ? crypto.randomUUID() : `stu-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
}
async function addStudent() {
  const name = document.getElementById('newName')?.value.trim() || '';
  const grade = document.getElementById('newGrade')?.value || '';
  const section = document.getElementById('newSection')?.value.trim() || 'أ';
  if (!name) return showToast('أدخل اسم الطالب.');
  try {
    const payload = { student_id:makeId(), name, grade, section };
    const result = await syncRecord('student', payload);
    students.unshift({ ...result.payload, recordId:result.id });
    document.getElementById('newName').value = '';
    fillStudentSelects(); await renderStudents(); updateDashboard(); updateStatus();
    showToast('تم حفظ الطالب في قاعدة بيانات المدرسة.');
  } catch (error) { showToast(error.message); }
}
async function bulkAddStudents() {
  const grade = document.getElementById('bulkGrade')?.value || '';
  const section = document.getElementById('bulkSection')?.value || '';
  const raw = document.getElementById('bulkStudentNames')?.value || '';
  const names = [...new Set(raw.split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
  const resultEl = document.getElementById('bulkImportResult');
  if (!grade || !section || !names.length) return showToast('اختاري الصف والشعبة وأدخلي اسمًا واحدًا على الأقل.');
  if (names.length > 100) return showToast('الحد الأقصى 100 طالب في الدفعة الواحدة.');
  const records = names.map(name => ({ kind:'student', payload:{ student_id:makeId(), name, grade, section } }));
  try {
    const result = await api('/api/records/bulk', { method:'POST', body:JSON.stringify({ records }) });
    await loadRecords();
    document.getElementById('bulkStudentNames').value = '';
    if (resultEl) resultEl.textContent = `تم حفظ ${result.count} طالبًا بنجاح.`;
    showToast(`تم حفظ ${result.count} طالبًا في قاعدة بيانات المدرسة.`);
  } catch (error) {
    if (resultEl) resultEl.textContent = error.message;
    showToast(error.message);
  }
}
async function removeStudent(studentId) {
  const student = students.find(s => s.student_id === studentId);
  if (!student?.recordId) return showToast('تعذر تحديد سجل الطالب.');
  if (!confirm(`حذف سجل الطالب ${student.name}؟ سيتم رفض الحذف إذا كان الحساب مرتبطًا به.`)) return;
  try {
    await api(`/api/records/${student.recordId}`, { method:'DELETE' });
    await loadRecords(); showToast('تم حذف السجل.');
  } catch (error) { showToast(error.message); }
}
async function saveAssessment() {
  const skill = document.getElementById('assessName')?.value.trim() || '';
  const studentId = document.getElementById('assessmentStudent')?.value || null;
  const student = students.find(s => s.student_id === studentId);
  const diagnosticFields = [...document.querySelectorAll('[data-diagnostic-question]')];
  const diagnosticRatings = [...document.querySelectorAll('[data-diagnostic-rating]')];
  let total, correct, pct, diagnosticQuestions = [];
  if (diagnosticFields.length) {
    if (diagnosticRatings.length !== diagnosticFields.length || diagnosticRatings.some(field => !field.value)) {
      return showToast('قيّم كل سؤال أولًا: متقن، متقن جزئيًا، أو يحتاج إلى دعم.');
    }
    total = diagnosticFields.length;
    const scores = diagnosticRatings.map(field => Number(field.value));
    correct = scores.filter(score => score === 100).length;
    pct = Math.round(scores.reduce((sum, score) => sum + score, 0) / total);
    diagnosticQuestions = diagnosticFields.map((field, index) => ({
      number:index + 1,
      question:field.value.trim(),
      rating:scores[index] === 100 ? 'متقن' : scores[index] === 50 ? 'متقن جزئيًا' : 'يحتاج إلى دعم',
      score:scores[index],
      note:document.querySelector('[data-diagnostic-note="' + index + '"]')?.value.trim() || ''
    })).filter(item => item.question);
  } else {
    total = Number(document.getElementById('total')?.value || 0);
    correct = Number(document.getElementById('correct')?.value || 0);
    pct = total > 0 ? Math.round(correct / total * 100) : 0;
    if (total <= 0 || correct < 0 || correct > total) return showToast('تحقق من إجمالي البنود وعدد الإجابات الصحيحة.');
  }
  if (!skill) return showToast('أدخل اسم التقويم أو المهارة أولًا.');
  const payload = {
    student_id:studentId, student_name:student?.name || null, skill, name:skill,
    total, correct, pct, date:new Date().toISOString(),
    diagnostic_questions:diagnosticQuestions,
    diagnostic_source:diagnosticQuestions.length ? 'قوالب إرشادية قابلة للتحرير مع تقدير المعلم لكل سؤال' : null,
    scoring_method:diagnosticQuestions.length ? 'متقن=100، متقن جزئيًا=50، يحتاج إلى دعم=0' : 'عدد الإجابات الصحيحة من الإجمالي'
  };
  try {
    const result = await syncRecord('assessment', payload);
    assessments.unshift({ ...result.payload, recordId:result.id });
    const el = document.getElementById('assessResult');
    if (el) el.innerHTML = `<strong>نسبة الإتقان: ${payload.pct}%</strong><p class="note">${student ? `الطالب: ${esc(student.name)}` : 'تقويم صفي غير مرتبط بطالب محدد'} — ${diagnosticQuestions.length ? `تقييم ${total} أسئلة؛ ${correct} متقنة بالكامل، مع احتساب الإتقان الجزئي.` : 'احتُسبت من الإجابات الصحيحة'} — حُفظ على الخادم.</p>`;
    renderAssess(); updateDashboard(); updateCycle(); updateAlerts();
    const lastAnalysis = window.atharLastAnalysisRequest;
    const sameStudentScope = lastAnalysis && String(lastAnalysis.student_id || '') === String(studentId || '');
    const isPrerequisiteAssessment = lastAnalysis && sameStudentScope &&
      (window.atharLastAnalysisPrerequisites || []).some(item => displaySkillName(item.skill) === displaySkillName(skill));
    if (isPrerequisiteAssessment) {
      try {
        const refreshed = await api('/api/analysis', { method:'POST', body:JSON.stringify(lastAnalysis) });
        const refreshedAnalysis = { ...refreshed.analysis, aiAssist:refreshed.aiAssist || null };
        analyses.unshift({ student_id:lastAnalysis.student_id || null, skill:refreshedAnalysis.skill, result:refreshedAnalysis, date:new Date().toISOString(), recordId:refreshed.id });
        renderAnalysisHistory();
        renderAnalysis(refreshedAnalysis, 'analysisResult');
        showToast('حُفظ التقويم وتحدّثت خريطة الجذور بالنتيجة الجديدة.');
      } catch (refreshError) {
        showToast(`حُفظ التقويم، لكن تعذر تحديث الخريطة تلقائيًا: ${refreshError.message}`);
      }
    } else {
      showToast('تم حفظ التقويم مركزيًا.');
    }
  } catch (error) { showToast(error.message); }
}
function diagnosticQuestionSet(skill) {
  const name = displaySkillName(skill);
  const normalized = name.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
  if (/الفهم المقروء|فهم المقروء/.test(normalized)) {
    const passage = 'خرجت مريم إلى الحديقة صباحًا، فرأت عامل النظافة يجمع الأوراق المتناثرة. ساعدته مريم، ثم وضعت الأوراق في سلة المهملات.';
    return [
      { question:`اقرأ النص: «${passage}» ثم: أين ذهبت مريم؟`, guide:'الإجابة المتوقعة: إلى الحديقة.' },
      { question:'ماذا فعلت مريم عندما رأت عامل النظافة؟', guide:'الإجابة المتوقعة: ساعدته في جمع الأوراق.' },
      { question:'استخرج من النص دليلًا يدل على تعاون مريم.', guide:'الإجابة المتوقعة: «ساعدته مريم».' }
    ];
  }
  if (/الطلاقة|القراءة الجهرية/.test(normalized)) return [
    {question:'اطلب من المتعلم قراءة فقرة قصيرة مناسبة لمستواه بصوت مسموع.',guide:'لاحظ صحة نطق الكلمات دون حذف أو إبدال.'},
    {question:'اطلب إعادة قراءة جملتين مع مراعاة علامات الترقيم.',guide:'لاحظ الوقف المناسب والتنغيم.'},
    {question:'اطلب قراءة الفقرة مرة أخرى بسلاسة.',guide:'سجّل الترددات والتوقفات غير المناسبة.'}
  ];
  if (/المفردات|معاني الكلمات|معنى الكلمة/.test(normalized)) return [
    {question:'في جملة من اختيار المعلم، حدّد معنى كلمة مستهدفة بالاستعانة بالسياق.',guide:'يحدد المعنى المناسب من سياق الجملة، لا بالتخمين المنفصل.'},
    {question:'اختر الكلمة الأقرب معنى للكلمة المستهدفة من بين ثلاثة بدائل.',guide:'يختار مرادفًا صحيحًا.'},
    {question:'استخدم الكلمة المستهدفة في جملة من إنشائك.',guide:'يوظف الكلمة بمعنى صحيح في سياق جديد.'}
  ];
  if (/الفكر[ةه] الرئيس|الفكرة العامة/.test(normalized)) return [
    {question:'اقرأ فقرة قصيرة، ثم عبّر عن موضوعها في جملة واحدة.',guide:'تعبّر الجملة عن الفكرة الجامعة لا عن تفصيل واحد.'},
    {question:'اختر العنوان الأنسب للفقرة من بين ثلاثة عناوين.',guide:'يختار عنوانًا يشمل معظم أفكار النص.'},
    {question:'حدّد تفصيلًا واحدًا يدعم الفكرة الرئيسة.',guide:'يذكر تفصيلًا مرتبطًا مباشرة بالفكرة.'}
  ];
  if (/الاستدلال|الاستنتاج/.test(normalized)) return [
    {question:'اقرأ موقفًا قصيرًا يقدمه المعلم، ثم استنتج ما يمكن أن يحدث بعده.',guide:'يقدم استنتاجًا منطقيًا مستندًا إلى قرينة.'},
    {question:'لماذا تصرّف الشخص في الموقف بهذه الطريقة؟ اذكر قرينة.',guide:'يربط السبب بقرينة واضحة في النص أو الموقف.'},
    {question:'ما المعلومة التي يمكن استنتاجها دون أن تُذكر صراحة؟',guide:'يميز بين المعلومة الصريحة والاستنتاج المدعوم.'}
  ];
  if (/العد|الاعداد|العدد/.test(normalized)) return [
    {question:'اعرض مجموعة من الأشياء (حتى 10)، واطلب عدّها واحدًا واحدًا.',guide:'يعد كل عنصر مرة واحدة ويصل إلى العدد الصحيح.'},
    {question:'غيّر ترتيب الأشياء واطلب عدّها مرة أخرى.',guide:'يدرك أن تغيير الترتيب لا يغيّر العدد.'},
    {question:'اطلب من المتعلم تكوين مجموعة تحتوي على عدد تحدده.',guide:'ينشئ مجموعة مطابقة للعدد المطلوب.'}
  ];
  if (/جمع|الطرح|الضرب|القسم|الكسور|العدد النسبي|الحساب/.test(normalized)) return [
    {question:`قدّم مسألة قصيرة من الدرس تتطلب تطبيق مهارة «${name}».`,guide:'يتعرف العملية أو التمثيل المناسب قبل الحل.'},
    {question:'قدّم مثالًا ثانيًا بأعداد أو تمثيل مختلف، واطلب توضيح خطوات الحل.',guide:'يطبق الإجراء بصورة صحيحة ويشرح خطوة أساسية.'},
    {question:'اعرض حلًا يتضمن خطأ شائعًا، واطلب تحديد الخطأ وتصحيحه.',guide:'يحدد موضع الخطأ ويبرر التصحيح.'}
  ];
  return [
    {question:`قدّم مهمة قصيرة مباشرة تقيس أداء المتعلم في «${name}».`,guide:'حدّد معيار النجاح قبل تطبيق المهمة.'},
    {question:`قدّم مثالًا ثانيًا مختلفًا لقياس انتقال مهارة «${name}» إلى سياق جديد.`,guide:'تحقق من تطبيق المهارة لا مجرد تذكر المثال.'},
    {question:`اعرض إجابة تتضمن خطأ شائعًا في «${name}»، واطلب من المتعلم تصحيحها.`,guide:'سجّل نوع الخطأ الذي ظهر لتحديد الاحتياج.'}
  ];
}
function generateDiagnosticQuestions() {
  const skill = document.getElementById('assessName')?.value.trim() || '';
  if (!skill) return showToast('اكتب اسم المهارة أولًا أو اخترها من خريطة الجذور.');
  const questions = diagnosticQuestionSet(skill);
  const panel = document.getElementById('diagnosticQuestions');
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `<div class="note">أسئلة إرشادية أولية مرتبطة باسم المهارة. راجعها وعدّلها لتناسب الصف والدرس قبل التطبيق؛ ليست تشخيصًا آليًا ولا توليدًا بالذكاء الاصطناعي. قيّم أداء المتعلم في كل سؤال وفق المؤشرات التالية.</div>
    <div class="note">طريقة الاحتساب: متقن = 100%، متقن جزئيًا = 50%، يحتاج إلى دعم = 0%. التقدير بيد المعلم.</div>
    ${questions.map((item,index)=>`<div class="diagnostic-question">
      <label for="diagnosticQuestion${index}">السؤال ${index+1}</label>
      <textarea id="diagnosticQuestion${index}" data-diagnostic-question rows="2">${esc(item.question)}</textarea>
      <details><summary>مؤشر الإجابة / الملاحظة</summary><p>${esc(item.guide)}</p></details>
      <label for="diagnosticRating${index}">تقدير الأداء</label>
      <select id="diagnosticRating${index}" data-diagnostic-rating>
        <option value="">اختر مستوى الأداء</option>
        <option value="100">متقن</option>
        <option value="50">متقن جزئيًا</option>
        <option value="0">يحتاج إلى دعم</option>
      </select>
      <label for="diagnosticNote${index}">ملاحظة المعلم (اختياري)</label>
      <textarea id="diagnosticNote${index}" data-diagnostic-note="${index}" rows="2" placeholder="سجّل الخطأ أو الدليل الذي لاحظته..."></textarea>
    </div>`).join('')}`;
  const manual = document.getElementById('manualAssessmentScore');
  if (manual) manual.hidden = true;
  showToast('أُعدّت الأسئلة؛ قيّم أداء كل سؤال ثم احفظ التقويم.');
}
function prepareDiagnosticAssessment(skill) {
  const field = document.getElementById('assessName');
  if (field) field.value = skill;
  show('assessment');
  generateDiagnosticQuestions();
  field?.focus();
}
function renderAssess() {
  const el = document.getElementById('assessList');
  if (!el) return;
  el.innerHTML = assessments.slice(0, 50).map((a, index) => {
    const questions = Array.isArray(a.diagnostic_questions) ? a.diagnostic_questions : [];
    const questionDetails = questions.length
      ? `<div class="assessment-saved-questions"><h4>تفاصيل أداء الأسئلة</h4><ol>${questions.map(item => `<li style="margin:.65rem 0"><strong>${escapeLine(item.question || 'سؤال دون نص')}</strong><p class="note">التقدير: ${esc(item.rating || (item.score === 100 ? 'متقن' : item.score === 50 ? 'متقن جزئيًا' : item.score === 0 ? 'يحتاج إلى دعم' : 'غير مسجل'))}</p>${item.note ? `<p class="note">ملاحظة المعلم: ${escapeLine(item.note)}</p>` : ''}</li>`).join('')}</ol></div>`
      : '<p class="note">هذا تقويم محفوظ بالطريقة السابقة؛ لا توجد تفاصيل تقييم لكل سؤال.</p>';
    const total = Number(a.total || questions.length || 0);
    const correct = Number(a.correct || 0);
    const scoreDetails = `<p class="note">الإجمالي: ${total || 'غير مسجل'} • الإجابات الصحيحة بالكامل: ${correct} • طريقة الاحتساب: ${esc(a.scoring_method || 'الطريقة السابقة')}</p>`;
    return `<details class="card saved-assessment-card" style="margin-top:.6rem"><summary style="cursor:pointer"><strong>${esc(displaySkillName(a.skill || a.name))}</strong> — ${Number(a.pct)}%<small> • ${esc(a.student_name || 'تقويم صفي')} • ${esc(formatDate(a.date))} • فتح التفاصيل</small></summary><div class="secondary-tools-content">${scoreDetails}${questionDetails}</div></details>`;
  }).join('') || '<p class="note">لا توجد تقويمات محفوظة بعد.</p>';
  fillStudentSelects();
}
function formatDate(value) {
  if (!value) return 'دون تاريخ';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('ar-OM');
}
function escapeLine(value) { return esc(value).replace(/\n/g, '<br>'); }
function renderLearningRootMap(analysis, rootItems, observation, patternHint) {
  const map = document.getElementById('learningRootMap');
  if (!map) return;
  const statusFor = item => item.score === null || item.score === undefined
    ? { label:'يحتاج إلى تقويم', cls:'pending' }
    : Number(item.score) < 70 ? { label:'مؤشر فجوة يحتاج إلى مراجعة', cls:'review' } : { label:'لا تظهر فجوة في النتائج', cls:'ok' };
  const previous = (rootItems || []).map(item => {
    const state = statusFor(item);
    const sampleSize = Number(item.sampleSize || 0);
    const score = item.score === null || item.score === undefined
      ? 'لا توجد نتيجة مسجلة'
      : `متوسط الإتقان ${Number(item.score)}% • عينة: ${sampleSize || 'غير محددة'}`;
    const evidenceNote = item.score === null || item.score === undefined
      ? 'لا يمكن الحكم قبل توفر نتيجة تقويم.'
      : Number(item.score) < 70
        ? 'نتيجة دون 70%؛ مؤشر يحتاج إلى مراجعة عينة الإجابات.'
        : 'النتيجة لا تشير إلى فجوة وفق الحد الإرشادي الحالي.';
    return `<div class="root-map-node ${state.cls}"><strong>${esc(displaySkillName(item.skill))}</strong><span>${state.label}</span><small>${score}</small><small>${evidenceNote}</small><button type="button" class="btn small root-map-assess" data-root-skill="${esc(item.skill)}">${item.score === null || item.score === undefined ? 'إجراء تقويم تشخيصي' : Number(item.score) < 70 ? 'إعادة التحقق بالتقويم' : 'مراجعة التقويم'}</button></div>`;
  }).join('') || '<div class="root-map-node pending"><strong>لا توجد مهارات سابقة موثقة</strong><span>تحتاج الخريطة إلى بيانات منهجية</span></div>';
  const next = (analysis.nextSkills || []).map(skill => `<div class="root-map-node future"><strong>${esc(displaySkillName(skill))}</strong><span>مهارة لاحقة</span></div>`).join('') || '<div class="root-map-node future"><strong>لا توجد مهارات لاحقة مسجلة</strong><span>يمكن إضافتها عند توثيق التسلسل</span></div>';
  map.innerHTML = `<div class="root-map-legend"><span><i class="pending"></i> يحتاج إلى تقويم</span><span><i class="review"></i> مؤشر يحتاج إلى مراجعة</span><span><i class="ok"></i> لا تظهر فجوة</span></div>
    <div class="root-map-flow">
      <section class="root-map-column"><h4>المهارات السابقة</h4><div class="root-map-nodes">${previous}</div></section><div class="root-map-arrow" aria-hidden="true">←</div>
      <section class="root-map-column"><h4>المهارة المتأثرة</h4><div class="root-map-node focus"><strong>${esc(displaySkillName(analysis.skill))}</strong><span>${analysis.targetScore === null ? 'لا توجد نتيجة مرتبطة' : `الإتقان ${Number(analysis.targetScore)}%`}</span><small>${esc(observation || 'لم تسجل ملاحظة صفية')}</small><small>${esc(patternHint || 'راجع إجابات الطلبة لتحديد نمط الخطأ بدقة.')}</small></div></section><div class="root-map-arrow" aria-hidden="true">←</div>
      <section class="root-map-column"><h4>المهارات اللاحقة</h4><div class="root-map-nodes">${next}</div></section>
    </div><p class="note">الأسهم توضح التسلسل التعلمي ولا تثبت علاقة سببية. لا تُعد المهارة السابقة جذرًا للتعثر إلا بعد توفر دليل تقويمي.</p>`;
  map.querySelectorAll('[data-root-skill]').forEach(button => {
    button.addEventListener('click', () => {
      prepareDiagnosticAssessment(button.dataset.rootSkill || '');
    });
  });
}
function renderAnalysisHistory() {
  const host = document.getElementById('analysisHistory');
  if (!host) return;
  const saved = analyses.filter(item => item && (item.result || item.analysis));
  host.innerHTML = saved.length
    ? '<h3>التحليلات السابقة</h3><p class="note">اختاري أي مهارة لاستعادة تحليلها وخريطة جذورها.</p>' +
      saved.map((item, index) => {
        const result = item.result || item.analysis || {};
        const skill = displaySkillName(item.skill || result.skill || 'مهارة غير محددة');
        const student = item.student_name || item.studentName || '';
        const score = result.targetScore === null || result.targetScore === undefined ? 'لا توجد نتيجة مرتبطة' : 'الإتقان ' + Number(result.targetScore) + '%';
        return '<button class="btn secondary saved-analysis-button" type="button" data-analysis-index="' + index + '" style="display:block;width:100%;text-align:right;margin:.45rem 0">' +
          '<strong>' + esc(skill) + '</strong><br><small>' + esc(formatDate(item.date)) + ' • ' + esc(score) + (student ? ' • ' + esc(student) : item.student_id ? ' • تحليل فردي' : ' • تحليل صفي') + '</small></button>';
      }).join('')
    : '<div class="root-map-empty">لا توجد تحليلات سابقة محفوظة في نطاق صلاحيتك بعد.</div>';
  host.querySelectorAll('[data-analysis-index]').forEach(button => {
    button.addEventListener('click', () => {
      const item = saved[Number(button.dataset.analysisIndex)];
      if (!item) return;
      const result = item.result || item.analysis;
      window.atharLastAnalysisRecordId = item.recordId || null;
      window.atharLastAnalysisRequest = {
        skill: result.skill || item.skill || '',
        student_id: item.student_id || '',
        observedErrors: result.observedErrors || ''
      };
      renderAnalysis(result, 'analysisResult');
      const radar = document.getElementById('analysisSkill');
      const observation = document.getElementById('errorInput');
      const student = document.getElementById('analysisStudent');
      if (radar) radar.value = result.skill || item.skill || '';
      if (observation) observation.value = result.observedErrors || '';
      if (student) student.value = item.student_id || '';
      document.getElementById('analysisResult')?.scrollIntoView({ behavior:'smooth', block:'start' });
      showToast('تم استعادة التحليل وخريطة الجذور المحفوظة.');
    });
  });
}
function useAnalysisForIntervention(analysis) {
  const skill = displaySkillName(analysis.skill || 'المهارة المستهدفة');
  const score = analysis.targetScore === null || analysis.targetScore === undefined ? null : Number(analysis.targetScore);
  const roots = analysis.rootCandidates || analysis.likelyRoots || analysis.prerequisiteEvidence || [];
  const request = window.atharLastAnalysisRequest || {};
  const studentId = request.student_id || '';
  const goal = score === null
    ? 'تنفيذ تقويم تشخيصي قصير لتحديد مستوى إتقان المهارة، ثم اعتماد هدف قابل للقياس بناءً على النتيجة.'
    : `رفع إتقان مهارة ${skill} من ${score}% إلى 70% على الأقل خلال أسبوعين، مع متابعة التقدم بقياس قصير.`;
  const rootChecks = roots.map(root => {
    const name = displaySkillName(root.skill);
    return root.score === null || root.score === undefined
      ? `تحقق من مهارة ${name} بتقويم قصير؛ لا توجد نتيجة مسجلة لها، لذلك لا تُعد سببًا مؤكدًا للتعثر.`
      : Number(root.score) < 70
        ? `راجع مهارة ${name}؛ أظهرت النتائج مستوى ${Number(root.score)}%، ثم تحقق من عينة الإجابات قبل اعتمادها فجوة.`
        : `تحقق من استمرار إتقان مهارة ${name}؛ لا تظهر فجوة في النتائج المتاحة (${Number(root.score)}%).`;
  });
  const ai = analysis.aiAssist && analysis.aiAssist.status === 'ok' ? analysis.aiAssist : null;
  const steps = [
    ...rootChecks,
    ...(analysis.recommendations || []),
    ...(ai?.teacherChecks || []),
    ai?.nextCheck ? `تحقق لاحق مقترح: ${ai.nextCheck}` : '',
    'نفّذ مهمة تحقق قصيرة في نهاية التدخل، وسجّل النتيجة لمقارنتها بخط الأساس.'
  ].filter(Boolean);
  const enrichment = ai?.differentiated?.enrichment || (score !== null && score >= 70
    ? 'قدّم مهمة أعمق تتطلب التفسير أو الاستدلال أو نقل المهارة إلى سياق جديد، مع متابعة ثبات الإتقان.'
    : 'بعد تقدم المتعلم، انتقل تدريجيًا إلى مهمة أكثر تحديًا، مع إبقاء الدعم متاحًا عند الحاجة.');
  const support = ai?.differentiated?.support || '';
  const expected = ai?.differentiated?.expected || '';
  const setValue = (id, value) => {
    const field = document.getElementById(id);
    if (field) field.value = value;
  };
  setValue('intSkill', skill);
  setValue('intGoal', goal);
  setValue('intSteps', [...new Set(steps)].join('\n'));
  if (support || expected) setValue('intSteps', [...new Set(steps)].join('\n') + (support ? `\n\nمستوى الدعم: ${support}` : '') + (expected ? `\nمستوى المتوقع: ${expected}` : ''));
  setValue('intEnrich', enrichment);
  if (studentId) setValue('interventionStudent', studentId);
  window.atharSuggestedIntervention = {
    analysisId:window.atharLastAnalysisRecordId || null,
    skill,
    studentId:studentId || null
  };
  show('intervention');
  showToast('نُقل التحليل إلى مسودة التدخل. راجع الهدف والخطوات قبل الحفظ.');
}
function renderAnalysis(analysis, destinationId) {
  const el = document.getElementById(destinationId);
  if (!el) return;
  window.atharLastAnalysis = true;
  const score = analysis.targetScore === null ? 'لا توجد نتيجة مرتبطة بعد' : `أحدث إتقان: ${analysis.targetScore}%`;
  const trend = analysis.trend === null ? '' : ` • التغير عن السابق: ${analysis.trend > 0 ? '+' : ''}${analysis.trend} نقطة`;
  const roots = analysis.rootCandidates || (analysis.likelyRoots?.length ? analysis.likelyRoots : analysis.prerequisiteEvidence || []).map(item => ({
    ...item,
    status:item.score === null ? 'غير مقاس — يحتاج إلى تقويم تشخيصي' : item.score < 70 ? 'فجوة محتملة وفق النتائج' : 'لا تظهر فجوة في النتائج المتاحة',
    evidence:item.score === null ? 'لا توجد نتيجة مسجلة لهذه المهارة السابقة.' : `متوسط أحدث النتائج ${item.score}% من ${item.sampleSize || 0} سجل/سجلات.`
  }));
  const teacherObservation = analysis.observedErrors || (analysis.evidence || []).find(item => String(item).startsWith('ملاحظة المعلم:'))?.replace('ملاحظة المعلم:', '').trim() || 'لم تُسجل ملاحظة عن نمط الخطأ؛ افحص إجابات الطلبة لتحديده.';
  const normalizedObservation = teacherObservation.replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
  const patternHint = /استخراج|استخرج|يستخرج/.test(normalizedObservation) && /نص|مقروء|قراء/.test(normalizedObservation)
    ? 'مؤشر أولي محتمل: صعوبة تحديد موضع الإجابة أو الدليل في النص.'
    : /مفردات|معن[ىي] الكلم|كلمات/.test(normalizedObservation)
      ? 'مؤشر أولي محتمل: صعوبة فهم المفردات أو توظيفها في السياق.'
      : /فكر[ةه] رئيس|موضوع النص/.test(normalizedObservation)
        ? 'مؤشر أولي محتمل: صعوبة تحديد الفكرة الرئيسة وتمييزها عن التفاصيل.'
        : /استنت|لماذا|كيف/.test(normalizedObservation)
          ? 'مؤشر أولي محتمل: صعوبة الاستدلال وربط القرائن.'
          : '';
  const rootStatus = analysis.rootCauseStatus || (roots.length ? 'تحتاج المهارات السابقة إلى مراجعة الأدلة.' : 'لا تتوفر خريطة موثقة للمهارات السابقة.');
  const evidenceItems = analysis.evidence || [];
  window.atharLastAnalysisPrerequisites = roots.map(item => ({ skill:item.skill, score:item.score, sampleSize:item.sampleSize || 0 }));
  const rootItems = roots.map(item => {
    const status = item.score === null || item.score === undefined
      ? 'غير متحقق — لا توجد نتيجة مسجلة'
      : Number(item.score) < 70
        ? 'مؤشر فجوة مدعوم بنتائج'
        : 'لا تظهر فجوة في النتائج المتاحة';
    const proof = item.score === null || item.score === undefined
      ? 'لا يمكن اعتباره سببًا للتعثر قبل إجراء تقويم لهذه المهارة.'
      : `متوسط أحدث النتائج ${Number(item.score)}%؛ راجع عينة الطلبة قبل اعتماد الاستنتاج.`;
    return { ...item, displayStatus:status, displayEvidence:proof };
  });
  el.innerHTML = `<div class="card">
    <p><span class="badge ${analysis.targetScore !== null && analysis.targetScore < 50 ? 'danger' : 'info'}">${esc(analysis.level)}</span> <strong>${esc(displaySkillName(analysis.skill))}</strong></p>
    <p>${esc(score + trend)} ${analysis.sampleSize ? ` • عينة التحليل: ${Number(analysis.sampleSize)}` : ''}</p>
    <div class="card" style="margin:.6rem 0"><strong>1 | المهارة المتأثرة</strong><p>${esc(displaySkillName(analysis.skill))}</p></div>
    <div class="card" style="margin:.6rem 0"><strong>2 | نمط الخطأ الملحوظ</strong><p>${esc(teacherObservation)}</p>${patternHint ? `<p><strong>${esc(patternHint)}</strong></p>` : ''}<p class="note">الوصف من ملاحظة المعلم. والمؤشر المحتمل — إن ظهر — استنتاج مبدئي قائم على كلمات الملاحظة، وليس تشخيصًا آليًا أو نتيجة ذكاء اصطناعي.</p></div>
    <div class="card" style="margin:.6rem 0"><strong>3 | مهارات سابقة للتحقق من جذور التعثر</strong><p class="note">${esc(rootStatus)} لا يُعد غياب النتائج دليلًا على وجود فجوة أو سبب.</p><ul>${rootItems.map(item => `<li><strong>${esc(displaySkillName(item.skill))}</strong> — ${item.score === null || item.score === undefined ? 'لا توجد نتيجة مسجلة' : `متوسط الإتقان ${Number(item.score)}%`}<br><span class="note">${esc(item.displayStatus)} • ${esc(item.displayEvidence)}</span></li>`).join('') || '<li>لا توجد مهارات سابقة موثقة لهذه المهارة بعد.</li>'}</ul></div>
    <div class="card" style="margin:.6rem 0"><strong>4 | الدليل من السجلات</strong><ul>${evidenceItems.map(item => `<li>${esc(item)}</li>`).join('') || '<li>لا توجد نتائج تقويم مرتبطة بالمهارة بعد.</li>'}</ul></div>
    <div class="card" style="margin:.6rem 0"><strong>5 | التدخل المقترح من التحليل القائم على البيانات</strong><ol>${(analysis.recommendations || []).map(item => `<li>${esc(item)}</li>`).join('') || '<li>ابدأ بتقويم تشخيصي قصير قبل اختيار التدخل.</li>'}</ol></div>
    ${analysis.aiAssist?.status === 'ok' ? `<section class="card ai-assist-result" style="margin:.6rem 0;border-inline-start:4px solid var(--primary,#2878c8)"><h3>✨ المساعد التربوي الذكي</h3><p class="note">مقترحات مولّدة بالذكاء الاصطناعي، تُراجع وتُعتمد من المعلم ولا تُعد تشخيصًا نهائيًا.</p>${analysis.aiAssist.errorPattern ? `<p><strong>نمط الخطأ المحتمل:</strong> ${esc(analysis.aiAssist.errorPattern)}</p>` : ''}${analysis.aiAssist.possibleRoots?.length ? `<p><strong>جذور محتملة تحتاج إلى تحقق:</strong></p><ul>${analysis.aiAssist.possibleRoots.map(item => `<li>${esc(typeof item === 'string' ? item : item.description || item.root || JSON.stringify(item))}</li>`).join('')}</ul>` : ''}${analysis.aiAssist.teacherChecks?.length ? `<p><strong>ما الذي يراجعه المعلم؟</strong></p><ul>${analysis.aiAssist.teacherChecks.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}<div class="card"><strong>التمايز في التدخل</strong>${analysis.aiAssist.differentiated?.support ? `<p><strong>الدعم:</strong> ${esc(analysis.aiAssist.differentiated.support)}</p>` : ''}${analysis.aiAssist.differentiated?.expected ? `<p><strong>المستوى المتوقع:</strong> ${esc(analysis.aiAssist.differentiated.expected)}</p>` : ''}${analysis.aiAssist.differentiated?.enrichment ? `<p><strong>الإثراء:</strong> ${esc(analysis.aiAssist.differentiated.enrichment)}</p>` : ''}</div>${analysis.aiAssist.nextCheck ? `<p><strong>التحقق التالي:</strong> ${esc(analysis.aiAssist.nextCheck)}</p>` : ''}${analysis.aiAssist.cautions?.length ? `<p class="note"><strong>تنبيهات:</strong> ${analysis.aiAssist.cautions.map(esc).join(' • ')}</p>` : ''}</section>` : analysis.aiAssist?.status === 'not_configured' ? '<p class="note">المساعد الذكي غير مهيأ حاليًا؛ يعرض النظام التحليل القائم على البيانات.</p>' : analysis.aiAssist?.status === 'unavailable' ? '<p class="note">تعذر الوصول إلى المساعد الذكي في هذه المحاولة؛ التحليل القائم على البيانات متاح.</p>' : ''}
    ${analysis.nextSkills?.length ? `<p><strong>المهارات اللاحقة:</strong> ${analysis.nextSkills.map(skill => esc(displaySkillName(skill))).join('، ')}</p>` : ''}
    <p class="note">${esc(analysis.disclaimer || 'النتيجة مساندة، ويعتمد القرار النهائي على مراجعة المعلم.')}</p>
    <button class="btn small" type="button" data-use-analysis>نقل التحليل إلى مصمم التدخل</button>
  </div>`;
  renderLearningRootMap(analysis, rootItems, teacherObservation, patternHint);
  el.querySelector('[data-use-analysis]')?.addEventListener('click', () => useAnalysisForIntervention(analysis));
}
async function analyzeErrors() {
  const skill = document.getElementById('analysisSkill')?.value.trim() || document.getElementById('assessName')?.value.trim() || 'تمثيل الكسور';
  const studentId = document.getElementById('analysisStudent')?.value || '';
  const observedErrors = document.getElementById('errorInput')?.value.trim() || '';
  const analysisRequest = { skill, student_id:studentId, observedErrors };
  try {
    const result = await api('/api/analysis', { method:'POST', body:JSON.stringify(analysisRequest) });
    window.atharLastAnalysisRequest = analysisRequest;
    window.atharLastAnalysisRecordId = result.id || null;
    const analysisWithAI = { ...result.analysis, aiAssist:result.aiAssist || null };
    analyses.unshift({ student_id:studentId || null, skill:analysisWithAI.skill, result:analysisWithAI, date:new Date().toISOString(), recordId:result.id });
    renderAnalysisHistory();
    renderAnalysis(analysisWithAI, 'analysisResult'); updateCycle();
    showToast('اكتمل التحليل باستخدام نتائج التقويم وخريطة المهارات.');
  } catch (error) { showToast(error.message); }
}
async function askAssistant() {
  const question = document.getElementById('assistantInput')?.value.trim() || '';
  const studentId = document.getElementById('assistantStudent')?.value || '';
  if (!question) return showToast('اكتب سؤالك أو المهارة التي تريد تحليلها.');
  try {
    const result = await api('/api/analysis', { method:'POST', body:JSON.stringify({ skill:question, question, student_id:studentId }) });
    window.atharLastAnalysisRequest = { skill:question, student_id:studentId, observedErrors:question };
    window.atharLastAnalysisRecordId = result.id || null;
    const analysisWithAI = { ...result.analysis, aiAssist:result.aiAssist || null };
    analyses.unshift({ student_id:studentId || null, skill:analysisWithAI.skill, result:analysisWithAI, date:new Date().toISOString(), recordId:result.id });
    renderAnalysis(analysisWithAI, 'assistantReply'); updateCycle();
    showToast('أُعد الرد بالاستناد إلى بيانات المدرسة المتاحة.');
  } catch (error) { showToast(error.message); }
}
function buildSuggestedActivityOptions(analysis) {
  const skill = displaySkillName(analysis.skill || 'المهارة المستهدفة');
  const mode = document.getElementById('activityMode')?.value || 'offline';
  const duration = Number(document.getElementById('activityDuration')?.value || 15);
  const isReading = /الفهم المقروء|فهم المقروء|الفهم القرائي/.test(skill);
  let activities;
  if (isReading && mode === 'offline') {
    activities = [
      {title:'بطاقات الفكرة والدليل',steps:'نشاط: بطاقات الفكرة والدليل (دون أجهزة، 10–15 دقيقة). اكتب الفكرة الرئيسة وثلاثة تفاصيل على قصاصات ورقية. يطابق الطالب كل تفصيل بالفكرة، ثم يختار الدليل من النص. سجّل عدد المطابقات الصحيحة.'},
      {title:'اقرأ وضع خطًا',steps:'نشاط: اقرأ وضع خطًا (دون أجهزة، 10 دقائق). وزّع نصًا قصيرًا مطبوعًا أو اكتبه على السبورة. يضع الطالب خطًا تحت الفكرة الرئيسة ودائرة حول دليلين، ثم يشرح اختياره.'},
      {title:'فكر ثم اشرح',steps:'نشاط: فكر ثم اشرح (دون أجهزة، 10–15 دقيقة). اقرأ فقرة بصوت واضح، امنح الطالب دقيقة للتفكير، ثم اطلب منه تلخيصها في جملة وذكر دليل من النص.'}
    ];
  } else if (isReading && mode === 'shared') {
    activities = [
      {title:'النص التفاعلي على الشاشة',steps:'نشاط: النص التفاعلي على الشاشة (جهاز المعلم فقط، 10–15 دقيقة). اعرض النص على الشاشة، وأخفِ الأسئلة أولًا. أظهر سؤالًا واحدًا كل مرة، واطلب من الطلبة تحديد موضع الدليل شفهيًا أو على السبورة.'},
      {title:'تصويت بالإشارات',steps:'نشاط: تصويت بالإشارات (دون أجهزة للطلبة، 10 دقائق). اعرض ثلاثة اختيارات للفكرة الرئيسة على الشاشة. يجيب الطلبة ببطاقات A/B/C أو بإشارات الأصابع، ثم يبررون الاختيار بدليل من النص.'},
      {title:'تمييز الدليل جماعيًا',steps:'نشاط: تمييز الدليل جماعيًا (جهاز المعلم وشاشة مشتركة، 15 دقيقة). اعرض فقرة، واطلب من طالب تحديد الجملة الداعمة على الشاشة أو السبورة، ثم ناقش لماذا تعد دليلًا.'}
    ];
  } else if (isReading) {
    activities = [
      {title:'مسار قراءة قصير',steps:'نشاط: مسار قراءة قصير (أجهزة وإنترنت، 10–15 دقيقة). يقرأ الطالب نصًا قصيرًا على جهازه، ويجيب عن أسئلة الفكرة الرئيسة والتفاصيل والاستنتاج. احتفظ بدرجة كل مهارة على حدة.'},
      {title:'تسجيل القراءة والتفسير',steps:'نشاط: تسجيل القراءة والتفسير (جهاز طالب، 10 دقائق). يسجل الطالب قراءة فقرة ثم يجيب صوتيًا أو كتابيًا عن سؤال استنتاجي ويذكر الدليل. راجع التسجيل وفق معيار موحد.'},
      {title:'اختبار خروج رقمي',steps:'نشاط: اختبار خروج رقمي (أجهزة وإنترنت، 10 دقائق). قدّم أربعة أسئلة قصيرة تقيس المفردات والفكرة الرئيسة والتفاصيل والاستنتاج، ثم سجّل النتيجة ومواطن الخطأ.'}
    ];
  } else if (mode === 'offline') {
    activities = [
      {title:'بطاقات خطوات الحل',steps:`نشاط: بطاقات خطوات الحل لمهارة ${skill} (دون أجهزة، ${duration} دقائق). جهّز ثلاث بطاقات: مثال محلول، خطوة ناقصة، ومسألة مستقلة. يرتب الطالب الخطوات ويشرح سبب اختياره.`},
      {title:'فكر-حل-تحقق',steps:`نشاط: فكر-حل-تحقق لمهارة ${skill} (ورقة وسبورة، ${duration} دقائق). اعرض مثالًا، ثم مثالًا مشابهًا يحله الطالب مستقلًا، واطلب منه التحقق من الحل وشرح الخطوة التي أخطأ فيها.`},
      {title:'محطات تعلم ورقية',steps:`نشاط: محطات تعلم ورقية لمهارة ${skill} (دون أجهزة، ${duration} دقائق). أنشئ ثلاث مهام متدرجة على أوراق أو زوايا السبورة، وينفذ الطالب مهمة قصيرة في كل محطة.`}
    ];
  } else if (mode === 'shared') {
    activities = [
      {title:'نمذجة أمام الشاشة',steps:`نشاط: نمذجة أمام الشاشة لمهارة ${skill} (جهاز المعلم فقط، ${duration} دقائق). اعرض مثالًا واحدًا، وفكر بصوت مسموع، ثم أخفِ الحل واطلب من الطلبة اقتراح الخطوة التالية.`},
      {title:'حل جماعي متدرج',steps:`نشاط: حل جماعي متدرج لمهارة ${skill} (شاشة مشتركة دون أجهزة طلبة، ${duration} دقائق). اعرض ثلاثة أمثلة متدرجة، واجمع إجابات الطلبة شفهيًا أو ببطاقات ورقية.`},
      {title:'اكتشف الخطأ',steps:`نشاط: اكتشف الخطأ لمهارة ${skill} (شاشة أو سبورة، ${duration} دقائق). اعرض حلًا يتضمن خطأ شائعًا، واطلب من الطلبة تحديد الخطأ وتصحيحه وتفسير السبب.`}
    ];
  } else {
    activities = [
      {title:'تدريب رقمي متدرج',steps:`نشاط: تدريب رقمي متدرج لمهارة ${skill} (أجهزة وإنترنت، ${duration} دقائق). يقدم الطالب ثلاث مهام من السهل إلى الأصعب، مع تسجيل الدقة ونوع الخطأ.`},
      {title:'تفسير الحل',steps:`نشاط: تفسير الحل لمهارة ${skill} (أجهزة متاحة، ${duration} دقائق). يحل الطالب مهمة قصيرة ثم يكتب أو يسجل تفسير خطواته، ويقارن المعلم الأداء بمعيار واضح.`},
      {title:'تقويم خروج رقمي',steps:`نشاط: تقويم خروج رقمي لمهارة ${skill} (أجهزة وإنترنت، 5–10 دقائق). أرسل ثلاث مسائل قصيرة، وراجع الأخطاء قبل تحديد النشاط التالي.`}
    ];
  }
  const modeLabel = mode === 'offline' ? 'دون أجهزة أو إنترنت' : mode === 'shared' ? 'جهاز المعلم/شاشة مشتركة' : 'أجهزة وإنترنت';
  const classPlan = `<div class="card" style="margin:.7rem 0"><h4>كيف يُنفّذ النشاط مع صف يضم أكثر من 30 طالبًا؟</h4><p>ينفذ الصف النشاط في الوقت نفسه على المهمة أو النص المشترك، ولا ينتظر الطلبة دور طالب واحد. قسّمهم إلى مجموعات مرنة أو وزّع مهامًا متدرجة:</p><ul><li><strong>مجموعة الدعم:</strong> نص أقصر أو كلمات موضحة، واختيارات مساعدة وتلميحات.</li><li><strong>المستوى المتوقع:</strong> المهمة الأساسية نفسها مع إجابة مستقلة ودليل من النص.</li><li><strong>مجموعة الإثراء:</strong> سؤال استنتاج أو تبرير أعمق أو نقل الفكرة إلى موقف جديد.</li></ul><p>يتابع المعلم الطالب المستهدف ضمن مجموعته بصورة إضافية قصيرة، دون عزله أو إيقاف تعلم بقية الصف. يمكن تكوين المجموعات بحسب نتائج التقويم وتتغير مع التقدم؛ فالنشاط مفيد لجميع الطلبة وليس للمتعثرين فقط.</p></div>`;
  return `<div class="card" style="margin-top:.8rem"><h4>مجموعة أنشطة مقترحة — ${esc(modeLabel)}</h4><p class="note">اختر نشاطًا مناسبًا لوقت الحصة. لكل نشاط ورقة جاهزة للطباعة، ويمكن تنفيذه مع الصف كله بمستويات دعم وإثراء مختلفة.</p>${classPlan}${activities.map(activity => `<div class="card" style="margin:.5rem 0"><strong>${esc(activity.title)}</strong><p>${esc(activity.steps)}</p><button class="btn small outline" type="button" onclick='printSuggestedActivityWorksheet(${JSON.stringify(activity.title)},${JSON.stringify(skill)})'>عرض ورقة النشاط وطباعتها</button> <button class="btn small outline" type="button" onclick='useSuggestedActivity(${JSON.stringify(activity.steps)})'>إضافة إلى خطة التدخل</button></div>`).join('')}</div>`;
}
function printSuggestedActivityWorksheet(title, skill) {
  const reading = /الفهم المقروء|فهم المقروء|الفهم القرائي/.test(skill);
  const passage = 'خرجت مريم مع أسرتها إلى الشاطئ صباح يوم الجمعة. لاحظت أكياسًا بلاستيكية قرب الصخور، فجمعتها ووضعتها في سلة المهملات. قالت لها أمها إن نظافة الشاطئ تحمي الكائنات البحرية وتجعل المكان أجمل للزوار.';
  const header = `<div class="sheet-head"><div class="brand">أثَر <span>ATHAR AI</span></div><div class="tag">ورقة نشاط صفية متمايزة</div><h1>${esc(title)}</h1><p>المهارة: ${esc(skill)}　|　الزمن المقترح: 10–15 دقيقة</p><div class="student-line">اسم الطالب: ........................................　الصف/الشعبة: ................　التاريخ: ............</div></div>`;
  const sharedText = reading ? `<div class="passage"><h3>النص المشترك: شاطئنا نظيف</h3><p>${passage}</p></div>` : `<div class="passage"><h3>مهمة المهارة</h3><p>نفّذ المهمة الآتية وفق تعليمات مجموعتك. اطلب توضيحًا إذا احتجت، ثم اشرح كيف توصلت إلى إجابتك.</p></div>`;
  const sheets = reading ? [
    {id:'support',name:'مجموعة الدعم',level:'نبدأ معًا',color:'support',task:` ${sharedText}<h2>المهمة 1 | افهم واختر</h2><p>1. اختر الفكرة الرئيسة للنص:</p><div class="choice">□ زيارة الشاطئ والمحافظة على نظافته　 □ شراء الألعاب　 □ الذهاب إلى المدرسة</div><p>2. ضع خطًا تحت العمل الذي قامت به مريم:</p><div class="choice">□ جمعت الأكياس　 □ نامت　 □ لعبت</div><p>3. أكمل: المحافظة على نظافة الشاطئ تحمي ................................</p><div class="answer"></div><div class="hint">تلميح: ابحث عن الجملة التي تخبرنا عمّ يتحدث النص كله.</div>`},
    {id:'core',name:'المستوى المتوقع',level:'أعمل باستقلال',color:'core',task:` ${sharedText}<h2>المهمة 2 | اقرأ واستدل</h2><p>1. اكتب الفكرة الرئيسة للنص بأسلوبك:</p><div class="answer"></div><p>2. اذكر دليلين من النص يدعمان فكرتك:</p><div class="answer"></div><div class="answer"></div><p>3. ما التصرف الإيجابي الذي تعلمته من مريم؟</p><div class="answer"></div>`},
    {id:'enrich',name:'مجموعة الإثراء',level:'أتحدى تفكيري',color:'enrich',task:` ${sharedText}<h2>المهمة 3 | استنتج وفسّر</h2><p>1. ماذا يمكن أن يحدث للكائنات البحرية إذا بقيت الأكياس البلاستيكية على الشاطئ؟ فسّر إجابتك.</p><div class="answer"></div><div class="answer"></div><p>2. استنتج رسالة النص، واكتب دليلًا يدعم استنتاجك.</p><div class="answer"></div><div class="answer"></div><p>3. اقترح مبادرة بسيطة للمحافظة على شاطئ منطقتك.</p><div class="answer"></div>`}
  ] : [
    {id:'support',name:'مجموعة الدعم',level:'نبدأ معًا',color:'support',task:`<div class="passage"><h3>خطوات مساعدة</h3><p>اقرأ المثال أو استمع إلى شرح المعلم. استخدم التلميح أو بطاقة الخطوات، ثم أكمل المهمة.</p></div><h2>المهمة 1 | أتدرّب بمساعدة</h2><p>ما أول خطوة ستبدأ بها؟</p><div class="answer"></div><p>أكمل المثال بمساعدة التلميح:</p><div class="answer"></div><p>ما الجزء الذي احتجت فيه إلى مساعدة؟</p><div class="answer"></div>`},
    {id:'core',name:'المستوى المتوقع',level:'أعمل باستقلال',color:'core',task:`<div class="passage"><h3>مهمتي المستقلة</h3><p>أنجز المهمة التي تقيس المهارة المستهدفة، ثم وضّح طريقة تفكيرك.</p></div><h2>المهمة 2 | أطبّق</h2><p>الحل أو الإجابة:</p><div class="answer"></div><div class="answer"></div><p>اشرح خطوة من طريقة الحل:</p><div class="answer"></div>`},
    {id:'enrich',name:'مجموعة الإثراء',level:'أتحدى تفكيري',color:'enrich',task:`<div class="passage"><h3>تحدٍ إضافي</h3><p>طبّق المهارة في موقف جديد أو أنشئ مثالًا من عندك.</p></div><h2>المهمة 3 | أتحدى وأبرّر</h2><p>المهمة أو المثال الجديد:</p><div class="answer"></div><div class="answer"></div><p>برّر إجابتك أو اشرح لماذا اخترت هذه الطريقة:</p><div class="answer"></div><div class="answer"></div>`}
  ];
  const groupPages = sheets.map(sheet => `<section class="sheet ${sheet.color}" data-sheet="${sheet.id}">${header}<div class="group-label">${sheet.name}<span>${sheet.level}</span></div>${sheet.task}<div class="footer">منصة أثَر | تعلّم يناسب الجميع — ورقة مستقلة قابلة للتوزيع على المجموعة</div></section>`).join('');
  const exitPage = `<section class="sheet exit-sheet" data-sheet="exit">${header}<div class="group-label">بطاقة خروج — لجميع الطلبة<span>أتحقق من تعلمي</span></div>${reading ? '<p>1. اكتب الفكرة الرئيسة للنص:</p><div class="answer"></div><p>2. اذكر دليلًا واحدًا:</p><div class="answer"></div><p>3. اكتب استنتاجًا مما قرأت:</p><div class="answer"></div>' : '<p>ما المهارة التي استخدمتها اليوم؟</p><div class="answer"></div><p>ما الخطوة التي أتقنتها؟</p><div class="answer"></div><p>ما الذي تحتاج إلى مراجعته؟</p><div class="answer"></div>'}<div class="footer">يجيب عنها جميع الطلبة بصورة فردية</div></section>`;
  const teacherPage = `<section class="sheet teacher-sheet" data-sheet="teacher">${header}<div class="group-label">دليل المعلم ومفتاح الاستجابة<span>للاستخدام أثناء التنفيذ</span></div><h2>تنظيم التنفيذ في صف كبير</h2><ol><li>وزّع أوراق المجموعات الثلاث في الوقت نفسه، ولا تجعل المجموعات تنتظر دورًا.</li><li>حدّد المجموعة وفق بيانات التقويم والملاحظة الصفية، مع السماح بالانتقال بين المستويات.</li><li>تابع الطالب المستهدف ضمن مجموعته، وقدّم له تلميحًا أو سؤالًا إضافيًا عند الحاجة.</li><li>اجمع بطاقة الخروج من جميع الطلبة لتحديد الخطوة التعليمية التالية.</li></ol>${reading ? '<h2>مفتاح إرشادي — الفهم المقروء</h2><p><strong>الدعم:</strong> الفكرة الرئيسة: المحافظة على نظافة الشاطئ؛ التصرف: جمعت مريم الأكياس؛ النظافة تحمي الكائنات البحرية.</p><p><strong>المستوى المتوقع:</strong> تقبل صياغة صحيحة للفكرة الرئيسة، ودليلين مثل جمع الأكياس ووضعها في سلة المهملات، أو حماية الكائنات البحرية.</p><p><strong>الإثراء:</strong> تقبل استنتاجات منطقية عن ضرر البلاستيك على الكائنات البحرية إذا استندت إلى دليل أو تفسير مناسب.</p>' : '<h2>مفتاح مراجعة عام</h2><p>قيّم صحة تطبيق المهارة، ووضوح خطوات الحل، وقدرة الطالب على تبرير إجابته. اقبل الاستراتيجيات الصحيحة المختلفة.</p>'}<p class="note">المجموعات مرنة وليست تصنيفات ثابتة للطلبة. راجع توزيع الطلبة بناءً على أدائهم وتقدمهم، ولا تستخدم الورقة وحدها للحكم على مستوى الطالب.</p><div class="footer">دليل للمعلم — لا يوزّع مع أوراق الطلبة عند الرغبة</div></section>`;
  const win = window.open('', '_blank');
  if (!win) return showToast('اسمح بفتح نافذة جديدة لعرض أوراق النشاط.');
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>حزمة أوراق نشاط — أثَر</title><style>
    *{box-sizing:border-box}body{margin:0;background:#eef3f9;color:#20324a;font-family:Tahoma,Arial,sans-serif;line-height:1.75}.toolbar{position:sticky;top:0;z-index:5;background:#102f56;color:#fff;padding:14px 18px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;box-shadow:0 3px 14px #102f5633}.toolbar strong{margin-left:auto}.toolbar button{border:1px solid #c6d7ee;background:#fff;color:#173c68;border-radius:9px;padding:9px 13px;font-weight:bold;cursor:pointer}.toolbar button.primary{background:#73d5c0;border-color:#73d5c0;color:#103b43}.wrap{max-width:900px;margin:22px auto;padding:0 14px}.sheet{background:#fff;max-width:800px;min-height:980px;margin:0 auto 22px;padding:34px 42px;border-radius:18px;box-shadow:0 8px 28px #18365b18;position:relative;overflow:hidden}.sheet:before{content:"";position:absolute;inset:0 0 auto;height:8px;background:linear-gradient(90deg,#1e5b9b,#39b8ad)}.sheet-head{border-bottom:1px solid #dce6f0;padding-bottom:12px;margin-bottom:18px}.brand{font-size:24px;font-weight:900;color:#174c80}.brand span{font-size:11px;letter-spacing:2px;color:#37a99e;margin-right:8px}.tag{display:inline-block;background:#edf5ff;color:#22588d;border-radius:20px;padding:3px 12px;font-size:12px}.sheet h1{font-size:24px;margin:8px 0;color:#173d68}.sheet h2{font-size:19px;color:#174c80;margin:18px 0 8px}.sheet h3{font-size:16px;color:#1b6571;margin:4px 0}.sheet p{margin:9px 0}.student-line{font-size:12px;color:#52657b;margin-top:12px}.passage{background:#f1f7fc;border:1px solid #d9e7f3;border-right:4px solid #3c9f9b;border-radius:12px;padding:14px 17px;margin:14px 0}.group-label{display:flex;justify-content:space-between;align-items:center;gap:12px;background:#eaf2fb;color:#174c80;border-radius:12px;padding:12px 16px;font-size:19px;font-weight:bold;margin:14px 0}.group-label span{font-size:12px;font-weight:normal;color:#536c83}.support .group-label{background:#fff4e5;color:#8a5415}.core .group-label{background:#e8f5f2;color:#176b60}.enrich .group-label{background:#f0ebff;color:#5d4694}.choice{padding:10px;background:#fafcff;border:1px solid #e2eaf2;border-radius:8px}.answer{height:48px;border-bottom:1px dashed #9eafc1;margin:8px 0 14px}.hint{background:#fff8e9;border-radius:8px;padding:9px 12px;color:#80571b;margin-top:14px}.sheet li{margin:7px 0}.footer{position:absolute;bottom:18px;right:42px;left:42px;border-top:1px solid #e1e8ef;padding-top:8px;color:#8291a2;font-size:11px}.note{background:#f6f8fb;padding:10px;border-radius:8px;color:#596b80;font-size:13px}
    @page{size:A4;margin:12mm}@media print{body{background:#fff}.toolbar{display:none}.wrap{max-width:none;margin:0;padding:0}.sheet{display:none!important;max-width:none;min-height:0;margin:0;padding:8mm 7mm;border-radius:0;box-shadow:none;break-after:page;page-break-after:always}.sheet:last-child{break-after:auto;page-break-after:auto}body[data-print="all"] .sheet{display:block!important}body[data-print="support"] .sheet[data-sheet="support"],body[data-print="core"] .sheet[data-sheet="core"],body[data-print="enrich"] .sheet[data-sheet="enrich"],body[data-print="exit"] .sheet[data-sheet="exit"],body[data-print="teacher"] .sheet[data-sheet="teacher"]{display:block!important}.footer{position:absolute;bottom:5mm;right:7mm;left:7mm}}
  </style><body data-print="preview"><div class="toolbar"><strong>أثَر | حزمة أوراق النشاط</strong><button class="primary" onclick="printSet('all')">طباعة الحزمة كاملة</button><button onclick="printSet('support')">ورقة الدعم</button><button onclick="printSet('core')">ورقة المستوى المتوقع</button><button onclick="printSet('enrich')">ورقة الإثراء</button><button onclick="printSet('exit')">بطاقة الخروج</button><button onclick="printSet('teacher')">دليل المعلم</button></div><main class="wrap">${groupPages}${exitPage}${teacherPage}</main><script>function printSet(which){document.body.setAttribute('data-print',which);window.print()}window.onafterprint=function(){document.body.setAttribute('data-print','preview')}</script></body></html>`);
  win.document.close();
  showToast('جهزت حزمة أوراق منفصلة لكل مجموعة مع معاينة وخيارات طباعة مستقلة.');
}
function useSuggestedActivity(steps) {
  const field = document.getElementById('intSteps');
  if (!field) return;
  const existing = field.value.trim();
  if (!existing.includes(steps)) field.value = existing ? existing + '\\n' + steps : steps;
  showToast('أُضيف النشاط إلى خطة التدخل؛ راجعه قبل الحفظ.');
}
function getImpactEvidenceStatus(item) {
  if (item.evidence_status) return item.evidence_status;
  return 'تحسن مسجل — الأدلة غير مكتملة';
}

function buildInterventionGuide(analysis, observedErrors = '') {
  const skill = displaySkillName(analysis.skill || '');
  const isReading = /الفهم المقروء|فهم المقروء|الفهم القرائي/.test(skill);
  const score = analysis.targetScore;
  const focusText = observedErrors.trim()
    ? `ملاحظة المعلم: ${esc(observedErrors)}`
    : 'ابدأ بتحديد نوع الصعوبة من إجابات الطالب قبل اختيار الدعم.';
  const content = isReading ? `
    <h4>1) هدف الدليل وتركيز المعلم</h4>
    <p>النتيجة المسجلة الحالية: <strong>${score === null ? 'غير متاحة' : score + '%'}</strong>. ركّز في البداية على تحديد موضع التعثر: المفردات، أو الفكرة الرئيسة، أو التفاصيل، أو الاستنتاج.</p>
    <p>${focusText}</p>
    <h4>2) نشاط جاهز: اقرأ، حدّد، واستدل (12–15 دقيقة)</h4>
    <p><strong>الأدوات:</strong> النص التالي مطبوع أو مكتوب على السبورة، وقلم. لا يحتاج الطالب إلى جهاز.</p>
    <blockquote><p>خرجت مريم مع أسرتها إلى الشاطئ في صباح يوم الجمعة. لاحظت وجود أكياس بلاستيكية قرب الصخور، فجمعتها في كيس ووضعتها في سلة المهملات. قالت لها أمها إن المحافظة على نظافة الشاطئ تحمي الكائنات البحرية وتجعل المكان أجمل للزوار.</p></blockquote>
    <ol>
      <li><strong>دقيقتان:</strong> اقرأ النص قراءة هادئة، ثم اطلب من الطالب تحديد كلمة لم يفهم معناها.</li>
      <li><strong>4 دقائق:</strong> اطلب منه وضع خط تحت الجملة التي تعبّر عن الفكرة الرئيسة.</li>
      <li><strong>4 دقائق:</strong> اطلب منه ذكر تفصيلين من النص يدعمان الفكرة.</li>
      <li><strong>3–5 دقائق:</strong> ناقش سؤال استنتاج، واطلب منه ذكر الدليل من النص.</li>
    </ol>
    <h4>3) أسئلة تشخيصية سريعة</h4>
    <ul>
      <li>المفردات: ما معنى «الكائنات البحرية»؟ ما الكلمة أو العبارة التي ساعدتك على فهمها؟</li>
      <li>الفكرة الرئيسة: عمّ يتحدث النص في جملة واحدة؟</li>
      <li>التفاصيل: اذكر عملين قامت بهما مريم.</li>
      <li>الاستنتاج: لماذا شكرت الأم مريم؟ ما الدليل من النص؟</li>
    </ul>
    <h4>4) كيف يختار المعلم الدعم؟</h4>
    <ul>
      <li>إذا تعثر في معنى الكلمات: اشرح كلمة واحدة بالسياق والصورة أو المثال، ثم أعد السؤال.</li>
      <li>إذا ذكر تفصيلًا بدل الفكرة الرئيسة: استخدم سؤال «ما الشيء المشترك بين التفاصيل؟» ثم قدّم جملة بداية: «يتحدث النص عن…».</li>
      <li>إذا أجاب دون دليل: اطلب منه الإشارة إلى الجملة التي بنى عليها إجابته.</li>
      <li>إذا تعثر في الاستنتاج: استخدم «ماذا أعرف من النص؟ + ماذا أفهم من ذلك؟».</li>
    </ul>
    <h4>5) قياس التحسن</h4>
    <p>في نهاية النشاط استخدم بطاقة خروج من 4 بنود: معنى كلمة من السياق، الفكرة الرئيسة، تفصيل داعم، واستنتاج مع دليل. سجّل عدد الإجابات الصحيحة من 4 كنسبة مئوية. أعد تقويمًا قصيرًا بنص جديد مماثل في الصعوبة بعد أسبوعين، وقارن النتيجة بخط الأساس المسجل (${score === null ? 'حدّد خط الأساس أولًا' : score + '%'}). الهدف المقترح في المسودة هو 70% على الأقل، ويعدّله المعلم وفق مستوى الطالب.</p>
    <h4>6) تذكير للمعلم</h4>
    <p>هذه خطة مقترحة وليست تشخيصًا. راجع إجابات الطالب وسياق الصف، وعدّل النص أو الزمن أو مستوى الدعم بما يناسبه.</p>` : `
    <h4>دليل تنفيذ مختصر</h4>
    <p>المهارة المستهدفة: <strong>${esc(skill || 'المهارة المحددة')}</strong>. النتيجة المسجلة: <strong>${score === null ? 'لا توجد نتيجة كافية' : score + '%'}</strong>.</p>
    <p>${focusText}</p>
    <ol>
      <li><strong>قبل التنفيذ (3 دقائق):</strong> اختر سؤالًا قصيرًا يقيس المهارة نفسها، وجهّز مثالًا محلولًا وورقة أو سبورة.</li>
      <li><strong>التشخيص (3–5 دقائق):</strong> اطلب من الطالب حل مثال مستقل، واسأله أن يشرح كيف توصل إلى الإجابة. سجّل نوع الخطأ بدل الاكتفاء بالدرجة.</li>
      <li><strong>التدريس الموجّه (5–7 دقائق):</strong> نمذج خطوة واحدة بصوت مسموع، ثم حل مثالًا معه، ثم اطلب مثالًا مستقلًا.</li>
      <li><strong>التحقق (2–3 دقائق):</strong> قدّم سؤالًا جديدًا من المهارة نفسها دون مساعدة وسجّل النتيجة.</li>
    </ol>
    <h4>أسئلة المعلم التشخيصية</h4>
    <ul><li>ما الخطوة التي بدأت بها؟</li><li>ما الجزء الذي لم يكن واضحًا؟</li><li>كيف تتحقق من أن إجابتك صحيحة؟</li></ul>
    <h4>قياس التحسن</h4>
    <p>سجّل نتيجة التحقق القصير كنسبة مئوية، ثم أعد قياس المهارة بعد أسبوعين بمهمة مماثلة. قارنها بخط الأساس (${score === null ? 'حدّد خط الأساس أولًا' : score + '%'}). عدّل التدخل إذا لم يظهر تحسن، ولا تنسب التغير إلى التدخل وحده.</p>
    <p>الأدوات المقترحة: ورقة مطبوعة أو السبورة، بما يناسب المدارس محدودة الأجهزة.</p>`;
  const activityOptions = buildSuggestedActivityOptions(analysis);
  const html = `<div class="card" style="margin-top:.8rem;border-right:4px solid var(--primary)">
    <h3>دليل تنفيذ عملي للمعلم</h3>${content}${activityOptions}
    <button class="btn small outline" type="button" onclick="printInterventionGuide()">طباعة دليل التنفيذ</button>
  </div>`;
  window.atharInterventionGuideHtml = html;
  return html;
}

function printInterventionGuide() {
  const html = window.atharInterventionGuideHtml;
  if (!html) return showToast('أنشئ المقترح الذكي أولًا.');
  const win = window.open('', '_blank');
  if (!win) return showToast('اسمح بفتح نافذة الطباعة.');
  win.document.write(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>دليل تنفيذ — أثَر</title><style>body{font-family:Arial,sans-serif;line-height:1.8;padding:24px;color:#172b45}h3,h4{color:#174a83}li{margin:.35rem 0}blockquote{border-right:3px solid #8aa;padding:.4rem 1rem;background:#f5f8fc}button{display:none}@page{size:A4;margin:16mm}</style><body><h2>أثَر | دليل تنفيذ التدخل</h2>${html}</body></html>`);
  win.document.close(); win.focus(); win.print();
}

async function suggestIntervention() {
  const button = document.getElementById('suggestInterventionBtn');
  const resultEl = document.getElementById('intAiResult');
  const studentId = document.getElementById('interventionStudent')?.value || '';
  const student = students.find(item => item.student_id === studentId);
  const observedErrors = document.getElementById('intObservedErrors')?.value.trim() || '';
  let skill = document.getElementById('intSkill')?.value.trim() || '';

  if (studentId && !student) return showToast('تعذر العثور على الطالب المحدد.');
  if (!skill && studentId) {
    const latest = latestAssessmentRows(assessments.filter(item => item.student_id === studentId));
    latest.sort((a,b) => Number(a.pct || 0) - Number(b.pct || 0));
    skill = latest[0]?.skill || latest[0]?.name || '';
  }
  if (!skill) return showToast('اختر طالبًا لديه تقويمات أو اكتب المهارة المراد دعمها أولًا.');
  if (studentId && !assessments.some(item => item.student_id === studentId)) {
    return showToast('لا توجد نتيجة تقويم لهذا الطالب بعد. سجّل تقويمًا أولًا حتى يكون الاقتراح مبنيًا على بياناته.');
  }

  if (button) { button.disabled = true; button.textContent = 'جارٍ تحليل الحالة وإعداد التدخل...'; }
  if (resultEl) resultEl.innerHTML = '<div class="note">يجري فحص أحدث النتائج والمهارات السابقة المسجلة...</div>';
  try {
    const response = await api('/api/analysis', {
      method:'POST',
      body:JSON.stringify({ skill, student_id:studentId, observedErrors })
    });
    const analysis = response.analysis;
    const score = analysis.targetScore;
    const goal = score === null
      ? 'تنفيذ تقويم تشخيصي قصير لتحديد مستوى المهارة، ثم وضع هدف قابل للقياس بناءً على النتيجة.'
      : `رفع إتقان ${displaySkillName(analysis.skill)} من ${score}% إلى 70% على الأقل خلال أسبوعين، مع متابعة تقدم الطالب أسبوعيًا.`;
    const rootSteps = (analysis.likelyRoots || []).map(root =>
      `تحقق أولًا من مهارة ${displaySkillName(root.skill)}؛ أظهرت البيانات مستوى ${root.score}%، ثم قدم نشاطًا قصيرًا لمعالجة الفجوة.`
    );
    const steps = [
      ...rootSteps,
      ...(analysis.recommendations || []),
      'نفّذ سؤال تحقق قصيرًا في نهاية كل حصة، وسجّل النتيجة لمقارنة التقدم.'
    ];
    const enrichment = score !== null && score >= 70
      ? 'قدّم نصًا أو مهمة أكثر عمقًا تتضمن الاستنتاج وتبرير الإجابة بالدليل، مع استمرار التحقق من ثبات الإتقان.'
      : 'بعد تحسن الأداء، انتقل تدريجيًا إلى نصوص أطول وأسئلة استنتاجية، مع إبقاء الدعم متاحًا عند الحاجة.';

    document.getElementById('intSkill').value = displaySkillName(analysis.skill);
    document.getElementById('intGoal').value = goal;
    document.getElementById('intSteps').value = [...new Set(steps)].join('\n');
    document.getElementById('intEnrich').value = enrichment;
    window.atharSuggestedIntervention = {
      analysisId:response.id,
      skill:displaySkillName(analysis.skill),
      studentId:studentId || null
    };

    const roots = (analysis.likelyRoots?.length ? analysis.likelyRoots : analysis.prerequisiteEvidence || []);
    if (resultEl) resultEl.innerHTML = `<div class="card"><strong>ملخص الحالة المقترح</strong><p>${esc(analysis.level)} • ${score === null ? 'لا توجد نتيجة كافية' : `أحدث إتقان: ${score}%`}</p><h4>المهارات السابقة</h4><ul>${roots.map(root => `<li>${esc(displaySkillName(root.skill))}: ${root.score === null ? 'تحتاج إلى تقويم تشخيصي' : `${root.score}%`}</li>`).join('') || '<li>لا تتوفر بيانات كافية عن المهارات السابقة.</li>'}</ul><h4>الأدلة من السجلات</h4><ul>${(analysis.evidence || []).map(item => `<li>${esc(item)}</li>`).join('') || '<li>لا توجد أدلة مسجلة.</li>'}</ul><p class="note">${esc(analysis.disclaimer || 'راجع الاقتراح قبل اعتماده.')}</p><span class="badge success">تم تجهيز مسودة التدخل في الحقول أدناه</span></div>${buildInterventionGuide(analysis, observedErrors)}`;
    showToast('تم تحليل الحالة وتجهيز مسودة التدخل؛ راجعها قبل الحفظ.');
  } catch (error) {
    if (resultEl) resultEl.innerHTML = `<div class="note">${esc(error.message)}</div>`;
    showToast(error.message);
  } finally {
    if (button) { button.disabled = false; button.textContent = '✨ اقترح تدخلًا ذكيًا لهذه الحالة'; }
  }
}

function resetInterventionForm() {
  const fields = ['interventionStudent','intGrade','intSubject','intUnit','intLesson','intOutcome','intSemester','intObservedErrors','intSkill','intGoal','intSteps','intEnrich'];
  fields.forEach(id => {
    const field = document.getElementById(id);
    if (field) field.value = '';
  });
  const mode = document.getElementById('activityMode');
  if (mode) mode.value = 'offline';
  const duration = document.getElementById('activityDuration');
  if (duration) duration.value = '15';
  const status = document.getElementById('intStatus');
  if (status) status.value = 'active';
  ['curriculumUnitField','curriculumLessonField','curriculumOutcomeField','intStatusField'].forEach(id => {
    const field = document.getElementById(id);
    if (field) field.hidden = true;
  });
  ['intAiResult','curriculumCatalogStatus'].forEach(id => {
    const field = document.getElementById(id);
    if (field) field.innerHTML = '';
  });
  document.querySelectorAll('#intervention details').forEach(details => { details.open = false; });
  const saveButton = document.getElementById('saveInterventionBtn');
  if (saveButton) saveButton.textContent = 'حفظ التدخل';
  const cancelButton = document.getElementById('cancelInterventionEditBtn');
  if (cancelButton) cancelButton.hidden = true;
  editingInterventionId = null;
  updateCurriculumSubjects();
  fillStudentSelects();
}

async function saveIntervention() {
  const skill = document.getElementById('intSkill')?.value.trim() || '';
  const goal = document.getElementById('intGoal')?.value.trim() || '';
  const steps = document.getElementById('intSteps')?.value.trim() || '';
  const enrichment = document.getElementById('intEnrich')?.value.trim() || '';
  const studentId = document.getElementById('interventionStudent')?.value || null;
  const student = students.find(s => s.student_id === studentId);
  if (!skill || !goal || !steps) return showToast('أكمل المهارة والهدف وخطوات التدخل.');
  try {
    const suggestion = window.atharSuggestedIntervention;
    const existing = editingInterventionId
      ? interventions.find(item => String(item.recordId) === String(editingInterventionId))
      : null;
    if (editingInterventionId && !existing) return showToast('تعذر العثور على التدخل المراد تعديله. حدّث السجلات وحاول مجددًا.');
    const oldCurriculum = existing?.curriculum || {};
    const curriculum = {
      grade:document.getElementById('intGrade')?.value || oldCurriculum.grade || null,
      subject:document.getElementById('intSubject')?.value || oldCurriculum.subject || null,
      semester:document.getElementById('intSemester')?.value || oldCurriculum.semester || null,
      unit:document.getElementById('intUnit')?.value || oldCurriculum.unit || null,
      lesson:document.getElementById('intLesson')?.value || oldCurriculum.lesson || null,
      learning_outcome:document.getElementById('intOutcome')?.value.trim() || oldCurriculum.learning_outcome || null
    };
    const payload = {
      ...(existing || {}),
      student_id:existing ? existing.student_id : studentId,
      student_name:existing ? existing.student_name : (student?.name || null),
      skill, goal, steps, enrichment,
      observed_errors:document.getElementById('intObservedErrors')?.value.trim() || '',
      curriculum,
      status:editingInterventionId
        ? (document.getElementById('intStatus')?.value || existing.status || 'active')
        : 'active',
      activity_mode:document.getElementById('activityMode')?.value || existing?.activity_mode || 'offline',
      activity_duration:Number(document.getElementById('activityDuration')?.value || existing?.activity_duration || 15),
      date:existing?.date || new Date().toISOString(),
      suggestion_source:existing?.suggestion_source || (suggestion && suggestion.skill === displaySkillName(skill) && suggestion.studentId === studentId ? 'athar-analysis' : 'teacher'),
      analysis_record_id:existing?.analysis_record_id ?? (suggestion && suggestion.skill === displaySkillName(skill) && suggestion.studentId === studentId ? suggestion.analysisId : null)
    };
    let result;
    if (editingInterventionId) {
      result = await api(`/api/records/${encodeURIComponent(editingInterventionId)}`, { method:'PUT', body:JSON.stringify({ payload }) });
      interventions = interventions.map(item => String(item.recordId) === String(editingInterventionId)
        ? { ...result.payload, recordId:result.id } : item);
      editingInterventionId = null;
      const statusField = document.getElementById('intStatusField');
      if (statusField) statusField.hidden = true;
      const saveButton = document.getElementById('saveInterventionBtn');
      if (saveButton) saveButton.textContent = 'حفظ التدخل';
      const cancelButton = document.getElementById('cancelInterventionEditBtn');
      if (cancelButton) cancelButton.hidden = true;
      renderInt(); updateDashboard(); updateCycle(); updateAlerts();
      resetInterventionForm();
      showToast('تم تحديث التدخل المحفوظ مع الاحتفاظ برقم سجله وروابطه، وتم تفريغ النموذج.');
    } else {
      result = await syncRecord('intervention', payload);
      interventions.unshift({ ...result.payload, recordId:result.id });
      renderInt(); updateDashboard(); updateCycle(); updateAlerts();
      resetInterventionForm();
      showToast('تم حفظ التدخل على قاعدة بيانات المدرسة، وتم تفريغ النموذج.');
    }
  } catch (error) { showToast(error.message); }
}
function renderInt() {
  const el = document.getElementById('intList');
  if (!el) return;
  el.innerHTML = interventions.slice(0, 50).map(i => {
    const c = i.curriculum || {};
    const curriculumLine = [c.grade ? `الصف ${c.grade}` : '', c.subject || '', c.semester ? `الفصل ${c.semester}` : '', c.unit ? `الوحدة: ${c.unit}` : '', c.lesson ? `الدرس: ${c.lesson}` : ''].filter(Boolean).join(' • ');
    const studentName = i.student_name || students.find(student => student.student_id === i.student_id)?.name || 'تدخل صفي';
    const observedErrors = String(i.observed_errors ?? i.observedErrors ?? '').trim();
    const modeLabel = ({ offline:'دون أجهزة أو إنترنت', shared:'جهاز المعلم مع شاشة مشتركة', online:'أجهزة للطلبة وإنترنت' })[i.activity_mode] || 'غير محدد';
    const statusLabel = ({ active:'نشط', completed:'مكتمل', paused:'متوقف مؤقتًا' })[i.status] || i.status || 'غير محدد';
    const recordId = Number(i.recordId);
    const editButton = Number.isInteger(recordId) && recordId > 0
      ? `<button class="btn small secondary" type="button" onclick="editIntervention(${recordId})">تعديل واستكمال التدخل</button>`
      : '';
    return `<details class="card saved-intervention-card" data-intervention-id="${esc(i.recordId)}" style="margin-top:.6rem">
      <summary style="cursor:pointer;display:flex;justify-content:space-between;gap:.8rem;align-items:center;flex-wrap:wrap">
        <span><strong>${esc(displaySkillName(i.skill))}</strong><small style="display:block;color:var(--muted,#667085);margin-top:.25rem">${esc(studentName)} • ${esc(formatDate(i.date))}</small>${observedErrors ? `<small style="display:block;margin-top:.3rem;color:var(--text,#344054)">ملاحظة المعلم: ${esc(observedErrors)}</small>` : ''}</span>
        <span class="badge">${esc(statusLabel)}</span>
      </summary>
      <div style="margin-top:.8rem">
        ${curriculumLine ? `<p class="note">${esc(curriculumLine)}</p>` : ''}
        ${c.learning_outcome ? `<p><strong>ناتج التعلم:</strong> ${esc(c.learning_outcome)}</p>` : ''}
        <p><strong>الهدف:</strong><br>${esc(i.goal || 'غير مسجل')}</p>
        <p><strong>خطوات التدخل:</strong><br>${esc(i.steps || 'غير مسجلة')}</p>
        ${i.enrichment ? `<p><strong>مسار الإثراء:</strong><br>${esc(i.enrichment)}</p>` : ''}
        ${observedErrors ? `<p><strong>ملاحظة المعلم:</strong><br>${esc(observedErrors)}</p>` : ''}
        <p><strong>إمكانات التنفيذ:</strong> ${esc(modeLabel)} • <strong>الوقت:</strong> ${esc(i.activity_duration ?? 'غير محدد')} دقيقة</p>
        <p><strong>مصدر إعداد التدخل:</strong> ${i.suggestion_source === 'athar-analysis' ? 'من تحليل رادار التعثر' : 'إعداد المعلم'}</p>
        ${i.analysis_record_id ? `<p class="note">مرتبط بتحليل محفوظ في رادار التعثر (رقم السجل: ${esc(i.analysis_record_id)}).</p>` : ''}
        ${editButton}
      </div>
    </details>`;
  }).join('') || '<p class="note">لا توجد تدخلات مسجلة بعد.</p>';
  fillStudentSelects();
}
function editIntervention(recordId) {
  const item = interventions.find(row => String(row.recordId) === String(recordId));
  if (!item) return showToast('تعذر العثور على التدخل. حدّث السجلات وحاول مجددًا.');
  editingInterventionId = item.recordId;
  fillStudentSelects();
  const setValue = (id, value) => {
    const field = document.getElementById(id);
    if (field && value !== undefined && value !== null) field.value = String(value);
  };
  setValue('interventionStudent', item.student_id || '');
  setValue('intSkill', displaySkillName(item.skill || ''));
  setValue('intGoal', item.goal || '');
  setValue('intSteps', item.steps || '');
  setValue('intEnrich', item.enrichment || '');
  setValue('intObservedErrors', item.observed_errors || '');
  setValue('activityMode', item.activity_mode || 'offline');
  setValue('activityDuration', [10,15,20].includes(Number(item.activity_duration)) ? item.activity_duration : 15);
  const curriculum = item.curriculum || {};
  setValue('intGrade', curriculum.grade || '');
  updateCurriculumSubjects();
  const ensureOption = (id, value, label) => {
    if (!value) return;
    const select = document.getElementById(id);
    if (!select) return;
    if (![...select.options].some(option => option.value === String(value))) {
      const option = document.createElement('option');
      option.value = String(value); option.textContent = label || String(value);
      select.appendChild(option);
    }
    select.value = String(value);
  };
  ensureOption('intSubject', curriculum.subject, curriculum.subject);
  updateCurriculumUnits();
  ensureOption('intUnit', curriculum.unit, curriculum.unit);
  updateCurriculumLessons();
  ensureOption('intLesson', curriculum.lesson, curriculum.lesson);
  updateCurriculumOutcome();
  setValue('intOutcome', curriculum.learning_outcome || '');
  if (curriculum.learning_outcome) {
    const outcomeField = document.getElementById('curriculumOutcomeField');
    if (outcomeField) outcomeField.hidden = false;
  }
  setValue('intSemester', curriculum.semester || '');
  setValue('intStatus', item.status || 'active');
  const statusField = document.getElementById('intStatusField');
  if (statusField) statusField.hidden = false;
  const saveButton = document.getElementById('saveInterventionBtn');
  if (saveButton) saveButton.textContent = 'حفظ التعديلات';
  const cancelButton = document.getElementById('cancelInterventionEditBtn');
  if (cancelButton) cancelButton.hidden = false;
  show('intervention');
  showToast('عدّل البيانات الناقصة أو حدّث حالة التدخل، ثم احفظ التعديلات.');
}
function cancelInterventionEdit() {
  editingInterventionId = null;
  const statusField = document.getElementById('intStatusField');
  if (statusField) statusField.hidden = true;
  const saveButton = document.getElementById('saveInterventionBtn');
  if (saveButton) saveButton.textContent = 'حفظ التدخل';
  const cancelButton = document.getElementById('cancelInterventionEditBtn');
  if (cancelButton) cancelButton.hidden = true;
  ['intSkill','intGoal','intSteps','intEnrich','intObservedErrors','intOutcome'].forEach(id => {
    const field = document.getElementById(id); if (field) field.value = '';
  });
  showToast('تم إلغاء التعديل دون تغيير السجل المحفوظ.');
}
function printWorksheet() {
  const skill = document.getElementById('intSkill')?.value || '';
  const goal = document.getElementById('intGoal')?.value || '';
  const steps = document.getElementById('intSteps')?.value || '';
  const win = window.open('', '_blank');
  if (!win) return showToast('اسمح بفتح نافذة الطباعة.');
  win.document.write(`<html lang="ar" dir="rtl"><meta charset="utf-8"><title>ورقة تدخل — أثَر</title><body style="font-family:Arial,sans-serif;padding:2rem"><h2>ورقة تدخل تعليمية — منصة أثَر</h2><h3>${esc(displaySkillName(skill))}</h3><p><strong>الهدف:</strong> ${esc(goal)}</p><p><strong>الخطوات:</strong><br>${escapeLine(steps)}</p></body></html>`);
  win.document.close(); win.focus(); win.print();
}
async function calcImpact() {
  const before = Number(document.getElementById('before')?.value);
  const after = Number(document.getElementById('after')?.value);
  const studentId = document.getElementById('impactStudent')?.value || null;
  const interventionId = document.getElementById('impactIntervention')?.value || '';
  if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0 || before > 100 || after > 100) return showToast('أدخل نسبتين من 0 إلى 100.');
  if (!interventionId) return showToast('اختر التدخل الذي تريد قياس أثره أولًا.');
  const intervention = interventions.find(item => String(item.recordId) === interventionId);
  if (!intervention) return showToast('تعذر العثور على التدخل المحدد. حدّث قائمة التدخلات وحاول مجددًا.');
  if (studentId && intervention.student_id !== studentId) return showToast('التدخل المحدد لا يرتبط بالطالب المختار.');
  const student = students.find(s => s.student_id === studentId);
  const difference = Number((after-before).toFixed(1));
  const tool = document.getElementById('impactTool')?.value.trim() || '';
  const beforeDate = document.getElementById('impactBeforeDate')?.value || '';
  const afterDate = document.getElementById('impactAfterDate')?.value || '';
  const activityMode = document.getElementById('impactActivityMode')?.value || '';
  const sessionsPlanned = Number(document.getElementById('impactSessionsPlanned')?.value || 0);
  const sessionsDone = Number(document.getElementById('impactSessionsDone')?.value || 0);
  const evidenceNote = document.getElementById('impactEvidenceNote')?.value.trim() || '';
  const followupRaw = document.getElementById('impactFollowup')?.value;
  const followup = followupRaw === '' || followupRaw === undefined ? null : Number(followupRaw);
  if (followup !== null && (!Number.isFinite(followup) || followup < 0 || followup > 100)) return showToast('أدخل نتيجة متابعة من 0 إلى 100.');
  const hasCoreEvidence = Boolean(tool && beforeDate && afterDate && activityMode && sessionsPlanned > 0 && sessionsDone >= sessionsPlanned && evidenceNote);
  const evidenceStatus = hasCoreEvidence && followup !== null && followup >= after
    ? 'تحسن مستمر — قياس متابعة يؤكد بقاء النتيجة أو ارتفاعها'
    : hasCoreEvidence
      ? 'تحسن موثق — أداة وتواريخ وتنفيذ موثقة'
      : 'تحسن مسجل — الأدلة غير مكتملة';
  const payload = {
    student_id:studentId || intervention.student_id || null,
    student_name:student?.name || intervention.student_name || null,
    intervention_record_id:intervention.recordId,
    intervention_skill:displaySkillName(intervention.skill || ''),
    intervention_goal:intervention.goal || '',
    before, after, difference, date:new Date().toISOString(),
    evidence_tool:tool, before_date:beforeDate || null, after_date:afterDate || null,
    activity_mode:activityMode || null, sessions_planned:sessionsPlanned || null,
    sessions_done:sessionsDone || null, evidence_note:evidenceNote || null,
    followup_score:followup, evidence_status:evidenceStatus
  };
  try {
    const result = await syncRecord('impact', payload);
    impacts.unshift({ ...result.payload, recordId:result.id });
    renderImpactHistory();
    const el = document.getElementById('impactResult');
    if (el) el.innerHTML = `<div class="card"><strong>الفرق: ${payload.difference > 0 ? '+' : ''}${payload.difference} نقطة مئوية</strong><p>${esc(student?.name || intervention.student_name || 'تقويم صفي')}</p><p>التدخل المرتبط: ${esc(payload.intervention_skill)} — ${esc(payload.intervention_goal)}</p><p><strong>توثيق النتيجة:</strong> ${esc(evidenceStatus)}</p><p class="note">أداة القياس: ${esc(tool || 'غير محددة')} • الجلسات: ${sessionsDone || 0}/${sessionsPlanned || 'غير محدد'} • ${esc(evidenceNote || 'لا توجد ملاحظة مرفقة')}</p><span class="badge ${payload.difference > 0 ? 'success' : 'warning'}">${payload.difference > 0 ? 'تحسن مسجل' : payload.difference === 0 ? 'لا تغير' : 'انخفاض يحتاج مراجعة'}</span></div>`;
    updateDashboard(); updateCycle(); updateAlerts(); renderReports(); showToast('تم حفظ قياس الأثر وربطه بالتدخل المحدد.');
  } catch (error) { showToast(error.message); }
}
function renderImpactTrendCharts(filterItem = null) {
  const groups = new Map();
  const sourceImpacts = filterItem ? impacts.filter(item => {
    if (filterItem.intervention_record_id !== undefined && filterItem.intervention_record_id !== null) return String(item.intervention_record_id) === String(filterItem.intervention_record_id);
    return String(item.student_id || 'class') === String(filterItem.student_id || 'class') && String(item.intervention_skill || 'unknown') === String(filterItem.intervention_skill || 'unknown');
  }) : impacts;
  sourceImpacts.forEach(item => {
    const key = item.intervention_record_id !== undefined && item.intervention_record_id !== null
      ? String(item.intervention_record_id)
      : 'unlinked|' + String(item.student_id || 'class') + '|' + String(item.intervention_skill || 'unknown');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return [...groups.entries()].map(([key, rows]) => {
    const intervention = interventions.find(row => String(row.recordId) === key);
    const sorted = rows.slice().sort((a,b) => new Date(a.after_date || a.date || 0) - new Date(b.after_date || b.date || 0));
    const points = [];
    sorted.forEach((item,index) => {
      const before = Number(item.before);
      const after = Number(item.after);
      if (Number.isFinite(before)) points.push({ value:before, label:'قبل ' + (index+1), date:item.before_date || item.date || '' });
      if (Number.isFinite(after)) points.push({ value:after, label:'بعد ' + (index+1), date:item.after_date || item.date || '' });
      const followup = item.followup_score === null || item.followup_score === undefined || item.followup_score === '' ? NaN : Number(item.followup_score);
      if (Number.isFinite(followup)) points.push({ value:followup, label:'متابعة ' + (index+1), date:item.followup_date || '' });
    });
    if (points.length < 2) return '';
    const width = Math.max(520, points.length * 92);
    const height = 238;
    const left = 42, right = 18, top = 28, bottom = 62;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const x = index => left + (points.length === 1 ? plotWidth/2 : index * plotWidth/(points.length-1));
    const y = value => top + (100 - Math.max(0,Math.min(100,value))) / 100 * plotHeight;
    const path = points.map((point,index) => (index ? 'L' : 'M') + x(index).toFixed(1) + ',' + y(point.value).toFixed(1)).join(' ');
    const grid = [0,50,100].map(value => {
      const yy=y(value).toFixed(1);
      return '<line x1="' + left + '" y1="' + yy + '" x2="' + (width-right) + '" y2="' + yy + '" stroke="currentColor" opacity=".16" stroke-dasharray="4 4"/><text x="' + (left-9) + '" y="' + (Number(yy)+4) + '" text-anchor="end" font-size="11" fill="currentColor">' + value + '%</text>';
    }).join('');
    const marks = points.map((point,index) => {
      const xx=x(index).toFixed(1), yy=y(point.value).toFixed(1);
      const date = point.date ? formatDate(point.date) : 'دون تاريخ';
      return '<g><title>' + esc(point.label + ' • ' + point.value + '% • ' + date) + '</title><circle cx="' + xx + '" cy="' + yy + '" r="5" fill="currentColor"/><text x="' + xx + '" y="' + (Number(yy)-11) + '" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">' + point.value + '%</text><text x="' + xx + '" y="' + (height-34) + '" text-anchor="middle" font-size="11" fill="currentColor">' + esc(point.label) + '</text><text x="' + xx + '" y="' + (height-17) + '" text-anchor="middle" font-size="9" fill="currentColor">' + esc(point.date ? point.date.slice(0,10) : '') + '</text></g>';
    }).join('');
    const first = points[0].value, latest = points[points.length-1].value;
    const previous = points.length > 1 ? points[points.length-2].value : first;
    const delta = latest - first;
    const status = latest < previous
      ? 'تراجع في آخر قياس بمقدار ' + (previous-latest) + ' نقطة؛ يُنصح بمراجعة الأدلة وظروف التنفيذ'
      : delta > 0
        ? 'النتيجة الأخيرة أعلى من خط الأساس بمقدار ' + delta + ' نقطة'
        : delta === 0
          ? 'النتيجة الأخيرة مساوية لخط الأساس'
          : 'لا يظهر تحسن مقارنة بخط الأساس';
    const statusClass = latest < previous ? 'decline' : delta > 0 ? 'improve' : 'steady';
    const studentName = sorted[sorted.length-1].student_name || students.find(row => row.student_id === sorted[sorted.length-1].student_id)?.name || 'قياس صفي';
    const areaPath = path + ' L ' + x(points.length-1).toFixed(1) + ',' + (top+plotHeight) + ' L ' + x(0).toFixed(1) + ',' + (top+plotHeight) + ' Z';
    const latestValue = latest + '%';
    const trendIcon = latest < previous ? '↘' : delta > 0 ? '↗' : '→';
    return '<details class="impact-trend-disclosure" open>' +
      '<summary class="impact-trend-summary"><span class="impact-trend-summary-main"><strong>' + esc(displaySkillName(intervention?.skill || sorted[0].intervention_skill || 'مسار قياس')) + '</strong><small>' + esc(studentName) + ' • ' + sorted.length + ' قياس محفوظ</small></span><span class="impact-trend-summary-result"><strong>' + latestValue + '</strong><small>أحدث نتيجة</small></span><span class="impact-trend-icon">' + trendIcon + '</span></summary>' +
      '<section class="impact-trend-card">' +
      '<div class="impact-trend-head"><div><span class="impact-trend-eyebrow">مؤشر متابعة التدخل</span><h4>' + esc(displaySkillName(intervention?.skill || sorted[0].intervention_skill || 'مسار قياس')) + '</h4><p>' + esc(studentName) + ' <span>•</span> ' + sorted.length + ' قياس محفوظ</p></div><span class="impact-trend-icon">' + trendIcon + '</span></div>' +
      '<div class="impact-trend-stats"><div><span>أحدث نتيجة</span><strong>' + latestValue + '</strong></div><div><span>التغير عن البداية</span><strong class="' + (delta > 0 ? 'positive' : delta < 0 ? 'negative' : '') + '">' + (delta > 0 ? '+' : '') + delta + ' <small>نقطة</small></strong></div><div><span>عدد نقاط القياس</span><strong>' + points.length + '</strong></div></div>' +
      '<div class="impact-trend-status ' + statusClass + '"><span class="impact-status-dot"></span>' + esc(status) + '</div>' +
      '<div class="impact-trend-chart"><div class="impact-chart-legend"><span><i></i> نتائج القياس</span><small>مقياس الإتقان من 0 إلى 100%</small></div><div class="impact-chart-scroll"><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="منحنى نتائج القياس قبل التدخل وبعده والمتابعة" viewBox="0 0 ' + width + ' ' + height + '" style="display:block;width:100%;min-width:' + width + 'px;height:auto">' +
      '<defs><linearGradient id="impactLine' + esc(key.replace(/[^a-zA-Z0-9_-]/g,'_')) + '" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#3978c8"/><stop offset="100%" stop-color="#16a394"/></linearGradient><linearGradient id="impactArea' + esc(key.replace(/[^a-zA-Z0-9_-]/g,'_')) + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3978c8" stop-opacity=".2"/><stop offset="100%" stop-color="#3978c8" stop-opacity="0"/></linearGradient></defs>' +
      grid + '<path d="' + areaPath + '" fill="url(#impactArea' + esc(key.replace(/[^a-zA-Z0-9_-]/g,'_')) + ')"/><path d="' + path + '" fill="none" stroke="url(#impactLine' + esc(key.replace(/[^a-zA-Z0-9_-]/g,'_')) + ')" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>' + marks + '</svg></div></div>' +
      '<p class="impact-trend-footnote">تُعرض النتائج قبل التدخل وبعده والمتابعة عند توفرها. يوضح الرسم مسار التغير، ولا يثبت أن التدخل وحده سبب التحسن.</p></section></details>';
  }).join('');
}
function renderImpactHistory() {
  const host = document.getElementById('impactHistory');
  if (!host) return;
  const saved = impacts.slice().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  host.innerHTML = saved.length
    ? '<h3>سجل قياسات الأثر</h3><p class="note">افتح أي قياس لمراجعة نتائجه وأدلته ومسار التقدم الخاص بالتدخل المرتبط به.</p>' +
      saved.map(item => {
        const intervention = interventions.find(row => String(row.recordId) === String(item.intervention_record_id));
        const studentName = item.student_name || students.find(row => row.student_id === item.student_id)?.name || 'قياس صفي';
        const skill = item.intervention_skill || intervention?.skill || 'مهارة غير محددة';
        const difference = Number(item.difference ?? (Number(item.after) - Number(item.before)));
        const differenceLabel = (difference > 0 ? '+' : '') + difference + ' نقطة مئوية';
        const outcomeLabel = difference > 0 ? 'تحسن مسجل' : difference === 0 ? 'لا تغير' : 'انخفاض يحتاج مراجعة';
        return '<details class="card saved-impact-card" style="margin-top:.6rem">' +
          '<summary style="cursor:pointer;display:flex;justify-content:space-between;gap:.8rem;align-items:center;flex-wrap:wrap">' +
          '<span><strong>' + esc(displaySkillName(skill)) + '</strong><small style="display:block;color:var(--muted,#667085);margin-top:.25rem">' + esc(studentName) + ' • ' + esc(formatDate(item.date)) + '</small></span>' +
          '<span class="badge">' + esc(differenceLabel) + '</span></summary>' +
          '<div style="margin-top:.8rem">' +
          '<p><strong>النتيجة قبل التدخل:</strong> ' + esc(item.before) + '%</p>' +
          '<p><strong>النتيجة بعد التدخل:</strong> ' + esc(item.after) + '%</p>' +
          '<p><strong>الفرق:</strong> ' + esc(differenceLabel) + ' — ' + esc(outcomeLabel) + '</p>' +
          '<p><strong>التدخل المرتبط:</strong> ' + esc(intervention?.skill || item.intervention_skill || 'تعذر العثور على سجل التدخل') + '</p>' +
          (item.intervention_goal || intervention?.goal ? '<p><strong>هدف التدخل:</strong><br>' + esc(item.intervention_goal || intervention.goal) + '</p>' : '') +
          (item.evidence_tool ? '<p><strong>أداة القياس:</strong> ' + esc(item.evidence_tool) + '</p>' : '') +
          (item.before_date ? '<p><strong>تاريخ القياس القبلي:</strong> ' + esc(item.before_date) + '</p>' : '') +
          (item.after_date ? '<p><strong>تاريخ القياس البعدي:</strong> ' + esc(item.after_date) + '</p>' : '') +
          (item.activity_mode ? '<p><strong>طريقة التنفيذ:</strong> ' + esc(({offline:'ورقة وسبورة دون أجهزة أو إنترنت',shared:'جهاز المعلم وشاشة مشتركة',online:'أجهزة للطلبة وإنترنت'})[item.activity_mode] || item.activity_mode) + '</p>' : '') +
          (item.sessions_planned || item.sessions_done ? '<p><strong>الجلسات المنفذة:</strong> ' + esc(item.sessions_done ?? 0) + ' من ' + esc(item.sessions_planned ?? 'غير محدد') + '</p>' : '') +
          (item.evidence_note ? '<p><strong>دليل المعلم:</strong><br>' + esc(item.evidence_note) + '</p>' : '') +
          (item.followup_score !== null && item.followup_score !== undefined ? '<p><strong>قياس المتابعة:</strong> ' + esc(item.followup_score) + '%</p>' : '') +
          (item.evidence_status ? '<p class="note"><strong>حالة التوثيق:</strong> ' + esc(item.evidence_status) + '</p>' : '') +
          '<div class="impact-record-trend"><strong>مسار التقدم الخاص بهذا التدخل</strong>' + renderImpactTrendCharts(item) + '</div>' +
          (intervention ? '<button class="btn small secondary" type="button" onclick="viewInterventionRecord(' + Number(intervention.recordId) + ')">عرض التدخل المرتبط</button>' : '<p class="note">سجل التدخل المرتبط غير متاح حاليًا.</p>') +
          '</div></details>';
      }).join('')
    : '<div class="root-map-empty">لا توجد قياسات أثر محفوظة بعد.</div>';
}
function viewInterventionRecord(recordId) {
  const item = interventions.find(row => String(row.recordId) === String(recordId));
  if (!item) return showToast('تعذر العثور على التدخل المرتبط بهذا القياس.');
  show('intervention');
  const card = document.querySelector(`.saved-intervention-card[data-intervention-id="${CSS.escape(String(recordId))}"]`);
  if (!card) return showToast('لم يظهر سجل التدخل في القائمة الحالية.');
  card.open = true;
  card.scrollIntoView({ behavior:'smooth', block:'center' });
  showToast('تم فتح تفاصيل التدخل المرتبط بقياس الأثر.');
}
function applyAccess() {
  document.body.style.fontSize = document.getElementById('largeText')?.checked ? '1.15rem' : '';
  document.body.style.filter = document.getElementById('highContrast')?.checked ? 'contrast(1.3)' : '';
}
function toggleLowResource() {
  document.body.classList.toggle('low-resource');
  const active = document.body.classList.contains('low-resource');
  const el = document.getElementById('lowResInfo');
  if (el) el.innerHTML = active ? '<span class="badge success">مفعّل</span> وضع مبسط لتقليل المؤثرات.' : '<span class="badge info">متوقف</span>';
  showToast(active ? 'تم تفعيل الوضع المبسط.' : 'تم إيقاف الوضع المبسط.');
}
function suggestPath() {
  const el = document.getElementById('pathResult');
  if (el) el.innerHTML = `<div class="card"><strong>مسار تطوير مقترح</strong><p>تحليل نتائج التقويم ← تحديد المهارات السابقة ← اختيار تدخل قصير ← قياس أثره.</p></div>`;
}
function useActivity(skill, steps) {
  if (document.getElementById('intSkill')) document.getElementById('intSkill').value = skill;
  if (document.getElementById('intSteps')) document.getElementById('intSteps').value = steps;
  show('intervention'); showToast('تم نقل النشاط إلى مصمم التدخلات.');
}
function editTeam() {
  const name = prompt('اسم الفريق:');
  if (name) { document.getElementById('teamName').textContent = name; localStorage.setItem('athar_team', name); }
}
if (localStorage.getItem('athar_team') && document.getElementById('teamName')) document.getElementById('teamName').textContent = localStorage.getItem('athar_team');
function latestAssessmentRows(rows = assessments) {
  const latest = new Map();
  for (const assessment of rows) {
    const key = `${assessment.student_id || 'class'}|${displaySkillName(assessment.skill || assessment.name || 'skill')}`;
    if (!latest.has(key)) latest.set(key, assessment);
  }
  return [...latest.values()];
}
function updateDashboard() {
  const currentAssessments = latestAssessmentRows();
  const avg = currentAssessments.length ? Math.round(currentAssessments.reduce((sum, a) => sum + Number(a.pct || 0), 0) / currentAssessments.length) : null;
  const gaps = currentAssessments.filter(a => Number(a.pct) < 70).length;
  const stat = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  stat('avgMastery', avg === null ? '—' : `${avg}%`);
  stat('gapCount', String(gaps)); stat('interventionCount', String(interventions.length)); stat('activeStudentCount', String(students.length));
  const bar = document.getElementById('avgMasteryBar');
  if (bar) bar.style.width = `${avg ?? 0}%`;
  stat('dashboardScope', currentRole === 'parent' ? 'بيانات الأبناء المرتبطين بحسابك' : currentRole === 'student' ? 'بياناتك الفردية' : `مدرسة ${currentUser?.school_id || ''}`);
}
function updateCycle() {
  const hasAssessment = assessments.length > 0;
  const hasIntervention = interventions.length > 0;
  const hasImpact = impacts.length > 0;
  const hasAnalysis = analyses.length > 0 || Boolean(window.atharLastAnalysis);
  const steps = [hasAssessment, hasAnalysis, hasIntervention, hasImpact].filter(Boolean).length;
  const bar = document.getElementById('cycleBar');
  const text = document.getElementById('cycleText');
  if (bar) bar.style.width = `${Math.round(steps/4*100)}%`;
  if (text) text.textContent = `تقويم ${hasAssessment?'✓':'—'} | تحليل ${hasAnalysis?'✓':'—'} | تدخل ${hasIntervention?'✓':'—'} | قياس ${hasImpact?'✓':'—'}`;
}
function updateAlerts() {
  const el = document.getElementById('smartAlerts');
  if (!el) return;
  const messages = [];
  if (!students.length) messages.push('أضف سجلات الطلبة لبدء المتابعة.');
  if (!assessments.length) messages.push('لا توجد تقويمات؛ أضف تقويمًا تشخيصيًا.');
  if (assessments.length && !interventions.length) messages.push('توجد تقويمات دون تدخلات مسجلة.');
  if (interventions.length && !impacts.length) messages.push('توجد تدخلات لم يسجل لها قياس أثر بعد.');
  el.innerHTML = messages.length ? messages.map(message => `<div class="note" style="margin:.3rem 0">${esc(message)}</div>`).join('') : '<span class="badge success">اكتملت السجلات الحالية للدورة.</span>';
}
function updateStatus() {
  const el = document.getElementById('dataStatus');
  if (el) el.textContent = `سجلات الخادم — طلبة: ${students.length} | تقويمات: ${assessments.length} | تدخلات: ${interventions.length} | قياس أثر: ${impacts.length}`;
}
function renderStudentProgress() {
  const el = document.getElementById('studentProgressContent');
  if (!el) return;
  const select = document.getElementById('progressStudent');
  const allowedIds = currentRole === 'student' ? linkedStudentIds.slice(0,1) : linkedStudentIds;
  const selectedId = select?.value || allowedIds[0] || '';
  const student = students.find(s => s.student_id === selectedId && allowedIds.includes(s.student_id));
  if (!student) { el.innerHTML = '<p class="note">لا توجد بيانات مرتبطة بهذا الحساب. راجع إدارة المدرسة لربط الحساب بسجل الطالب الصحيح.</p>'; return; }
  const personal = assessments.filter(a => a.student_id === student.student_id);
  const latest = new Map();
  personal.forEach(a => { const key = a.skill || a.name; if (!latest.has(key)) latest.set(key, a); });
  const interventionRows = interventions.filter(i => i.student_id === student.student_id);
  const impactRows = impacts.filter(i => i.student_id === student.student_id);
  el.innerHTML = `<div class="card"><h3>${esc(student.name)}</h3><p>${esc(student.grade || '')} • شعبة ${esc(student.section || '')}</p></div>${[...latest.values()].map(a => `<div class="card" style="margin-top:.7rem"><strong>${esc(displaySkillName(a.skill || a.name))}</strong><div class="progress"><div class="progress-bar" style="width:${Math.max(0,Math.min(100,Number(a.pct)||0))}%"></div></div><p>نسبة الإتقان المسجلة: ${Number(a.pct)}%</p></div>`).join('') || '<p class="note">لا توجد تقويمات فردية مرتبطة بهذا الطالب بعد.</p>'}<div class="card" style="margin-top:.7rem"><h3>توصيات وتدخلات المعلم</h3>${interventionRows.map(i => `<p><strong>${esc(displaySkillName(i.skill))}</strong><br>${esc(i.goal || '')}<br><span class="note">${esc(i.steps || '')}</span></p>`).join('') || '<p>لا توجد تدخلات مسجلة لهذا الطالب.</p>'}</div><div class="card" style="margin-top:.7rem"><h3>قياس الأثر</h3>${impactRows.map(i => `<p>${Number(i.before)}% ← ${Number(i.after)}% (${Number(i.difference)>0?'+':''}${Number(i.difference)} نقطة)</p><p class="note">${esc(getImpactEvidenceStatus(i))} • ${esc(i.evidence_tool || 'أداة القياس غير محددة')} • الجلسات ${Number(i.sessions_done || 0)}/${Number(i.sessions_planned || 0)}</p>`).join('') || '<p>لا توجد قياسات أثر مسجلة لهذا الطالب.</p>'}</div>`;
}
function renderPrincipalView() {
  const el = document.getElementById('principalData');
  if (!el) return;
  if (!['principal','senior_teacher'].includes(currentRole)) { el.innerHTML = ''; return; }
  if (!students.length) { el.innerHTML = '<p class="note">لا توجد سجلات طلبة في قاعدة بيانات المدرسة بعد.</p>'; return; }
  const groups = new Map();
  for (const student of students) {
    const key = `${student.grade || 'غير محدد'} / ${student.section || '—'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(student);
  }
  el.innerHTML = [...groups.entries()].map(([name, group]) => {
    const ids = new Set(group.map(s => s.student_id));
    const groupAssessments = latestAssessmentRows(assessments.filter(a => ids.has(a.student_id)));
    const average = groupAssessments.length ? Math.round(groupAssessments.reduce((sum,a)=>sum+Number(a.pct||0),0)/groupAssessments.length) : null;
    const gaps = groupAssessments.filter(a => Number(a.pct) < 70).length;
    const groupInterventions = interventions.filter(i => ids.has(i.student_id)).length;
    return `<div class="card" style="margin-top:.7rem"><h3>${esc(name)}</h3><p>عدد الطلبة: ${group.length} • متوسط الإتقان: ${average === null ? 'لا توجد بيانات' : `${average}%`} • نتائج دون 70%: ${gaps} • التدخلات: ${groupInterventions}</p></div>`;
  }).join('');
}
function renderReports() {
  const el = document.getElementById('reportSummary');
  if (!el) return;
  const currentAssessments = latestAssessmentRows();
  const skillGroups = new Map();
  currentAssessments.forEach(assessment => {
    const skill = displaySkillName(assessment.skill || assessment.name || 'مهارة غير محددة');
    if (!skillGroups.has(skill)) skillGroups.set(skill, []);
    skillGroups.get(skill).push(Number(assessment.pct) || 0);
  });
  const skillRows = [...skillGroups.entries()].map(([skill, scores]) => {
    const average = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
    const lowCount = scores.filter(score => score < 70).length;
    return `<li><strong>${esc(skill)}</strong> — متوسط الإتقان ${average}% • نتائج دون 70%: ${lowCount} من ${scores.length}</li>`;
  }).join('');
  const linkedImpactRows = impacts.filter(item => item.intervention_record_id);
  const impactRowsHtml = linkedImpactRows.slice(0,10).map(item => {
    const intervention = interventions.find(row => String(row.recordId) === String(item.intervention_record_id));
    const skill = displaySkillName(item.intervention_skill || intervention?.skill || 'مهارة غير محددة');
    const studentName = item.student_name || intervention?.student_name || 'تقويم صفي';
    const delta = Number(item.difference ?? (Number(item.after)-Number(item.before)));
    return `<li><strong>${esc(skill)}</strong> — ${esc(studentName)}: ${Number(item.before)}% إلى ${Number(item.after)}% (${delta > 0 ? '+' : ''}${delta} نقطة) <span class="note">${esc(getImpactEvidenceStatus(item))}</span></li>`;
  }).join('');
  el.innerHTML = `<p>الطلبة: ${students.length} • التقويمات: ${assessments.length} • التدخلات: ${interventions.length} • قياسات الأثر: ${impacts.length}</p><p>متوسط أحدث نتائج المهارات المسجلة: ${currentAssessments.length ? `${Math.round(currentAssessments.reduce((sum,a)=>sum+Number(a.pct||0),0)/currentAssessments.length)}%` : 'لا توجد بيانات'}</p><h4>ملخص المهارات</h4><ul>${skillRows || '<li>لا توجد نتائج مهارية كافية لإعداد الملخص.</li>'}</ul><h4>أثر التدخلات المرتبطة</h4><ul>${impactRowsHtml || '<li>لم تُسجل قياسات أثر مرتبطة بتدخلات بعد.</li>'}</ul>`;
}
async function loadSchoolUsers() {
  const el = document.getElementById('usersList');
  if (!el) return;
  try {
    const result = await api('/api/users');
    el.innerHTML = (result.users || []).map(user => {
      const linked = user.linkedStudentIds || [];
      const assigned = user.assignedStudentIds || [];
      const relation = linked.length ? `الطلبة المرتبطون بالحساب: ${linked.map(esc).join('، ')}` : assigned.length ? `الطلبة المسندون للمعلم: ${assigned.map(esc).join('، ')}` : 'لا يوجد ربط فردي بطالب';
      const manageable = ['teacher','parent','student'].includes(user.role);
      const selectedIds = user.role === 'teacher' ? assigned : linked;
      const assignmentEditor = manageable ? `<label for="userLinks-${Number(user.id)}">تعديل ربط الطلبة</label><select id="userLinks-${Number(user.id)}" multiple size="4" style="min-height:85px">${students.map(student => `<option value="${esc(student.student_id)}" ${selectedIds.includes(student.student_id) ? 'selected' : ''}>${esc(student.name)} — ${esc(student.grade || '')} ${esc(student.section || '')}</option>`).join('')}</select><button class="btn small" onclick="saveUserLinks(${Number(user.id)},'${user.role}')">حفظ الربط</button>` : '';
      return `<div class="card" style="margin-top:.5rem"><strong>${esc(user.name)}</strong><p>${esc(user.email)} • ${esc(getRoleName(user.role))}</p><p class="note">${relation}</p>${assignmentEditor}</div>`;
    }).join('') || '<p class="note">لا توجد حسابات إضافية.</p>';
  } catch (error) { el.textContent = error.message; }
}
async function saveUserLinks(userId, role) {
  const select = document.getElementById(`userLinks-${userId}`);
  if (!select) return;
  const studentIds = [...select.selectedOptions].map(option => option.value);
  const endpoint = role === 'teacher' ? `/api/users/${userId}/assignments` : `/api/users/${userId}/student-links`;
  try {
    await api(endpoint, { method:'PUT', body:JSON.stringify({ studentIds }) });
    await loadSchoolUsers();
    showToast('تم تحديث ربط الطلبة بالحساب.');
  } catch (error) { showToast(error.message); }
}
async function createAccount() {
  if (currentUser?.school_id === 'DEMO-SCHOOL') return showToast('هذه بيئة اختبار معزولة؛ لا يمكن إنشاء حسابات رسمية منها.');
  const email = document.getElementById('accountEmail')?.value.trim() || '';
  const name = document.getElementById('accountName')?.value.trim() || '';
  const role = document.getElementById('accountRole')?.value || '';
  const select = document.getElementById('accountStudentIds');
  const studentIds = select ? [...select.selectedOptions].map(option => option.value) : [];
  try {
    await api('/api/users', { method:'POST', body:JSON.stringify({ email, name, role, studentIds }) });
    document.getElementById('accountEmail').value = '';
    document.getElementById('accountName').value = '';
    if (select) [...select.options].forEach(option => option.selected = false);
    await loadSchoolUsers(); showToast('تم إنشاء الحساب. يمكنه الدخول بعد إعداد البريد الرسمي.');
  } catch (error) { showToast(error.message); }
}
async function exportData() {
  try {
    const result = await api('/api/records');
    const blob = new Blob([JSON.stringify({ exportedAt:new Date().toISOString(), records:result.records }, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'athar-school-records.json'; anchor.click(); URL.revokeObjectURL(url);
  } catch (error) { showToast(error.message); }
}
async function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    let records = Array.isArray(parsed.records) ? parsed.records : [];
    if (!records.length && (Array.isArray(parsed.students) || Array.isArray(parsed.assessments) || Array.isArray(parsed.interventions))) {
      const ids = new Map();
      records = (parsed.students || []).map(s => { const student_id = String(s.student_id || s.id || makeId()); ids.set(String(s.id), student_id); return { kind:'student', payload:{ student_id, name:s.name, grade:s.grade || '', section:s.section || '' } }; });
      for (const a of parsed.assessments || []) records.push({ kind:'assessment', payload:{ ...a, skill:a.skill || a.name || 'تقويم مستورد', student_id:a.student_id || ids.get(String(a.studentId || a.student_id)) || null } });
      for (const i of parsed.interventions || []) records.push({ kind:'intervention', payload:{ ...i, student_id:i.student_id || ids.get(String(i.studentId || i.student_id)) || null } });
    }
    const cleanRecords = records.filter(record => ['student','assessment','intervention','impact'].includes(record.kind) && record.payload)
      .map(record => ({ kind:record.kind, payload:{ ...record.payload } }));
    let count = 0;
    for (let index = 0; index < cleanRecords.length; index += 100) {
      const batch = cleanRecords.slice(index, index + 100);
      const result = await api('/api/records/bulk', { method:'POST', body:JSON.stringify({ records:batch }) });
      count += Number(result.count || 0);
    }
    await loadRecords(); showToast(`تم استيراد ${count} سجلًا إلى الخادم.`);
  } catch (error) { showToast(`تعذر الاستيراد: ${error.message}`); }
  finally { event.target.value = ''; }
}
function showRole() { applyRoleUI(); }
function updateStatusAfterLogin() { updateStatus(); updateDashboard(); renderReports(); }
function toggleThemeOnLoad() { if (localStorage.getItem('athar_dark') === 'true') document.body.classList.add('dark'); }
toggleThemeOnLoad();

/* ATHAR AI v3 — centralized records, strict roles, and data-driven learning analysis. */
let students = [];
let assessments = [];
let interventions = [];
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
  renderStudentProgress(); renderPrincipalView(); updateDashboard(); updateCycle(); updateAlerts(); updateStatus(); renderReports();
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
  const total = Number(document.getElementById('total')?.value || 0);
  const correct = Number(document.getElementById('correct')?.value || 0);
  const studentId = document.getElementById('assessmentStudent')?.value || null;
  if (!skill || total <= 0 || correct < 0 || correct > total) return showToast('تحقق من المهارة وعدد الإجابات؛ يجب ألا تتجاوز الصحيحة الإجمالي.');
  const student = students.find(s => s.student_id === studentId);
  const payload = { student_id:studentId, student_name:student?.name || null, skill, name:skill, total, correct, pct:Math.round(correct / total * 100), date:new Date().toISOString() };
  try {
    const result = await syncRecord('assessment', payload);
    assessments.unshift({ ...result.payload, recordId:result.id });
    const el = document.getElementById('assessResult');
    if (el) el.innerHTML = `<strong>نسبة الإتقان: ${payload.pct}%</strong><p class="note">${student ? `الطالب: ${esc(student.name)}` : 'تقويم صفي غير مرتبط بطالب محدد'} — حُفظ على الخادم.</p>`;
    renderAssess(); updateDashboard(); updateCycle(); updateAlerts();
    showToast('تم حفظ التقويم مركزيًا.');
  } catch (error) { showToast(error.message); }
}
function renderAssess() {
  const el = document.getElementById('assessList');
  if (!el) return;
  el.innerHTML = assessments.slice(0, 20).map(a => `<div class="card" style="margin-top:.6rem"><strong>${esc(displaySkillName(a.skill || a.name))}</strong> — ${Number(a.pct)}%<small> • ${esc(a.student_name || 'تقويم صفي')} • ${esc(formatDate(a.date))}</small></div>`).join('') || '<p class="note">لا توجد تقويمات محفوظة بعد.</p>';
  fillStudentSelects();
}
function formatDate(value) {
  if (!value) return 'دون تاريخ';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('ar-OM');
}
function escapeLine(value) { return esc(value).replace(/\n/g, '<br>'); }
function renderAnalysis(analysis, destinationId) {
  const el = document.getElementById(destinationId);
  if (!el) return;
  window.atharLastAnalysis = true;
  const score = analysis.targetScore === null ? 'لا توجد نتيجة مرتبطة بعد' : `آخر إتقان: ${analysis.targetScore}%`;
  const trend = analysis.trend === null ? '' : ` • التغير: ${analysis.trend > 0 ? '+' : ''}${analysis.trend}`;
  const hasWeakRoots = analysis.likelyRoots.length > 0;
  const rootsToShow = hasWeakRoots ? analysis.likelyRoots : analysis.prerequisiteEvidence;
  const rootsTitle = hasWeakRoots ? 'جذور تعثر محتملة وفق النتائج' : 'المهارات السابقة التي يُنصح بالتحقق منها';
  el.innerHTML = `<div class="card"><p><span class="badge ${analysis.targetScore !== null && analysis.targetScore < 50 ? 'danger' : 'info'}">${esc(analysis.level)}</span> <strong>${esc(displaySkillName(analysis.skill))}</strong></p><p>${esc(score + trend)}</p><h4>${rootsTitle}</h4><ul>${rootsToShow.map(item => `<li>${esc(displaySkillName(item.skill))}${item.score === null ? ' — تحتاج إلى تقويم تشخيصي' : ` — متوسط الإتقان ${item.score}%`}</li>`).join('') || '<li>لا تتوفر خريطة مهارات كافية لهذه المهارة.</li>'}</ul><h4>الأدلة</h4><ul>${analysis.evidence.map(item => `<li>${esc(item)}</li>`).join('') || '<li>لا توجد بيانات تقويم مرتبطة بالمهارة بعد.</li>'}</ul><h4>التوصيات المقترحة</h4><ol>${analysis.recommendations.map(item => `<li>${esc(item)}</li>`).join('')}</ol>${analysis.nextSkills.length ? `<p><strong>المهارات اللاحقة:</strong> ${analysis.nextSkills.map(skill => esc(displaySkillName(skill))).join('، ')}</p>` : ''}<p class="note">${esc(analysis.disclaimer)}</p><button class="btn small" type="button" data-use-analysis>نقل التوصيات إلى التدخل</button></div>`;
  el.querySelector('[data-use-analysis]')?.addEventListener('click', () => useActivity(displaySkillName(analysis.skill), analysis.recommendations.join('\n')));
}
async function analyzeErrors() {
  const skill = document.getElementById('analysisSkill')?.value.trim() || document.getElementById('assessName')?.value.trim() || 'تمثيل الكسور';
  const studentId = document.getElementById('analysisStudent')?.value || '';
  const observedErrors = document.getElementById('errorInput')?.value.trim() || '';
  try {
    const result = await api('/api/analysis', { method:'POST', body:JSON.stringify({ skill, student_id:studentId, observedErrors }) });
    analyses.unshift({ student_id:studentId || null, skill:result.analysis.skill, result:result.analysis, date:new Date().toISOString(), recordId:result.id });
    renderAnalysis(result.analysis, 'analysisResult'); updateCycle();
    showToast('اكتمل التحليل باستخدام نتائج التقويم وخريطة المهارات.');
  } catch (error) { showToast(error.message); }
}
async function askAssistant() {
  const question = document.getElementById('assistantInput')?.value.trim() || '';
  const studentId = document.getElementById('assistantStudent')?.value || '';
  if (!question) return showToast('اكتب سؤالك أو المهارة التي تريد تحليلها.');
  try {
    const result = await api('/api/analysis', { method:'POST', body:JSON.stringify({ skill:question, question, student_id:studentId }) });
    analyses.unshift({ student_id:studentId || null, skill:result.analysis.skill, result:result.analysis, date:new Date().toISOString(), recordId:result.id });
    renderAnalysis(result.analysis, 'assistantReply'); updateCycle();
    showToast('أُعد الرد بالاستناد إلى بيانات المدرسة المتاحة.');
  } catch (error) { showToast(error.message); }
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
  const html = `<div class="card" style="margin-top:.8rem;border-right:4px solid var(--primary)">
    <h3>دليل تنفيذ عملي للمعلم</h3>${content}
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
    const payload = { student_id:studentId, student_name:student?.name || null, skill, goal, steps, enrichment, status:'active', date:new Date().toISOString(), suggestion_source:suggestion && suggestion.skill === displaySkillName(skill) && suggestion.studentId === studentId ? 'athar-analysis' : 'teacher', analysis_record_id:suggestion && suggestion.skill === displaySkillName(skill) && suggestion.studentId === studentId ? suggestion.analysisId : null };
    const result = await syncRecord('intervention', payload);
    interventions.unshift({ ...result.payload, recordId:result.id });
    renderInt(); updateDashboard(); updateCycle(); updateAlerts();
    showToast('تم حفظ التدخل على قاعدة بيانات المدرسة.');
  } catch (error) { showToast(error.message); }
}
function renderInt() {
  const el = document.getElementById('intList');
  if (!el) return;
  el.innerHTML = interventions.slice(0, 15).map(i => `<div class="card" style="margin-top:.6rem"><strong>${esc(displaySkillName(i.skill))}</strong><p>${esc(i.student_name || 'تدخل صفي')} • ${esc(formatDate(i.date))}</p><p>${esc(i.goal || '')}</p></div>`).join('') || '<p class="note">لا توجد تدخلات مسجلة بعد.</p>';
  fillStudentSelects();
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
  const payload = {
    student_id:studentId || intervention.student_id || null,
    student_name:student?.name || intervention.student_name || null,
    intervention_record_id:intervention.recordId,
    intervention_skill:displaySkillName(intervention.skill || ''),
    intervention_goal:intervention.goal || '',
    before, after, difference, date:new Date().toISOString()
  };
  try {
    const result = await syncRecord('impact', payload);
    impacts.unshift({ ...result.payload, recordId:result.id });
    const el = document.getElementById('impactResult');
    if (el) el.innerHTML = `<div class="card"><strong>الفرق: ${payload.difference > 0 ? '+' : ''}${payload.difference} نقطة مئوية</strong><p>${esc(student?.name || intervention.student_name || 'تقويم صفي')}</p><p>التدخل المرتبط: ${esc(payload.intervention_skill)} — ${esc(payload.intervention_goal)}</p><span class="badge ${payload.difference > 0 ? 'success' : 'warning'}">${payload.difference > 0 ? 'تحسن مسجل' : payload.difference === 0 ? 'لا تغير' : 'انخفاض يحتاج مراجعة'}</span></div>`;
    updateDashboard(); updateCycle(); updateAlerts(); renderReports(); showToast('تم حفظ قياس الأثر وربطه بالتدخل المحدد.');
  } catch (error) { showToast(error.message); }
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
  el.innerHTML = `<div class="card"><h3>${esc(student.name)}</h3><p>${esc(student.grade || '')} • شعبة ${esc(student.section || '')}</p></div>${[...latest.values()].map(a => `<div class="card" style="margin-top:.7rem"><strong>${esc(displaySkillName(a.skill || a.name))}</strong><div class="progress"><div class="progress-bar" style="width:${Math.max(0,Math.min(100,Number(a.pct)||0))}%"></div></div><p>نسبة الإتقان المسجلة: ${Number(a.pct)}%</p></div>`).join('') || '<p class="note">لا توجد تقويمات فردية مرتبطة بهذا الطالب بعد.</p>'}<div class="card" style="margin-top:.7rem"><h3>توصيات وتدخلات المعلم</h3>${interventionRows.map(i => `<p><strong>${esc(displaySkillName(i.skill))}</strong><br>${esc(i.goal || '')}<br><span class="note">${esc(i.steps || '')}</span></p>`).join('') || '<p>لا توجد تدخلات مسجلة لهذا الطالب.</p>'}</div><div class="card" style="margin-top:.7rem"><h3>قياس الأثر</h3>${impactRows.map(i => `<p>${Number(i.before)}% ← ${Number(i.after)}% (${Number(i.difference)>0?'+':''}${Number(i.difference)} نقطة)</p>`).join('') || '<p>لا توجد قياسات أثر مسجلة لهذا الطالب.</p>'}</div>`;
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
  el.innerHTML = `<p>الطلبة: ${students.length} • التقويمات: ${assessments.length} • التدخلات: ${interventions.length} • قياسات الأثر: ${impacts.length}</p><p>متوسط أحدث نتائج المهارات المسجلة: ${currentAssessments.length ? `${Math.round(currentAssessments.reduce((sum,a)=>sum+Number(a.pct||0),0)/currentAssessments.length)}%` : 'لا توجد بيانات'}</p><h4>ملخص المهارات</h4><ul>${skillRows || '<li>لا توجد نتائج مهارية كافية لإعداد الملخص.</li>'}</ul>`;
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

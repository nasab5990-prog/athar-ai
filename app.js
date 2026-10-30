const API = 'https://athar-ai-i7he.onrender.com';

async function requestCode() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const msg = document.getElementById('loginMsg');
  if (!email) { msg.textContent = 'أدخل البريد الإلكتروني'; return; }
  msg.textContent = 'جاري الإرسال...';
  try {
    const res = await fetch(`${API}/api/auth/request-code`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'include',
      body: JSON.stringify({email})
    });
    const data = await res.json();
    msg.textContent = data.message || 'تم الإرسال';
    if (res.ok) {
      document.getElementById('codeSection').style.display = 'block';
      document.getElementById('btnRequest').style.display = 'none';
    }
  } catch (e) {
    msg.textContent = 'تعذر الاتصال بالخادم';
  }
}

async function verifyCode() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const code = document.getElementById('loginCode').value.trim();
  const msg = document.getElementById('loginMsg');
  if (!code) { msg.textContent = 'أدخل رمز التحقق'; return; }
  msg.textContent = 'جاري التحقق...';
  try {
    const res = await fetch(`${API}/api/auth/verify-code`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'include',
      body: JSON.stringify({email, code})
    });
    const data = await res.json();
    if (res.ok && data.user) {
      currentRole = data.user.role === 'senior_teacher' ? 'senior' : data.user.role;
      localStorage.setItem('athar_user', data.user.name || email);
      localStorage.setItem('athar_role', currentRole);
      document.getElementById('loginScreen').classList.add('hidden');
      applyRoleUI();
      showToast('مرحبًا ' + (data.user.name || email));
      loadRecords();
    } else {
      msg.textContent = data.message || 'فشل التحقق';
    }
  } catch (e) {
    msg.textContent = 'تعذر الاتصال بالخادم';
  }
}

async function loadRecords() {
  try {
    const res = await fetch(`${API}/api/records`, {credentials:'include'});
    if (!res.ok) return;
    const data = await res.json();
    console.log('Records loaded', data.records?.length || 0);
  } catch (e) {}
}

async function saveRecord(kind, payload) {
  try {
    await fetch(`${API}/api/records`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      credentials: 'include',
      body: JSON.stringify({kind, payload})
    });
  } catch (e) {}
}

let students = JSON.parse(localStorage.getItem('athar_students') || '[]');
let assessments = JSON.parse(localStorage.getItem('athar_assessments') || '[]');
let interventions = JSON.parse(localStorage.getItem('athar_interventions') || '[]');
let currentRole = localStorage.getItem('athar_role') || 'teacher';

function doLogin() {
  const user = document.getElementById('loginUser').value.trim() || 'مستخدم';
  const pass = document.getElementById('loginPass').value;
  const role = document.getElementById('loginRole').value;
  const passwords = { teacher:'teacher123', senior:'senior123', supervisor:'supervisor123', principal:'principal123', parent:'parent123' };
  if (pass !== passwords[role]) {
    showToast('كلمة المرور غير صحيحة لهذا الدور');
    return;
  }
  currentRole = role;
  localStorage.setItem('athar_user', user);
  localStorage.setItem('athar_role', role);
  document.getElementById('loginScreen').classList.add('hidden');
  applyRoleUI();
  showToast('مرحبًا ' + user + ' (' + getRoleName(role) + ')');
}
if (localStorage.getItem('athar_user')) {
  currentRole = localStorage.getItem('athar_role') || 'teacher';
  document.getElementById('loginScreen').classList.add('hidden');
  applyRoleUI();
}

function toggleGroup(el) {
  const group = el.parentElement;
  group.classList.toggle('open');
}
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (window.innerWidth <= 900) {
    sb.classList.toggle('open');
    document.body.classList.toggle('sidebar-open', sb.classList.contains('open'));
  } else {
    sb.classList.toggle('closed');
    document.body.classList.toggle('sidebar-closed', sb.classList.contains('closed'));
  }
}
function show(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const sec = document.getElementById(id);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('.sidebar a').forEach(a => a.classList.remove('active'));
  const link = document.querySelector(`.sidebar a[data-section="${id}"]`);
  if (link) link.classList.add('active');
  window.scrollTo({top:0, behavior:'smooth'});
  if (window.innerWidth <= 900) {
    document.getElementById('sidebar').classList.remove('open');
    document.body.classList.remove('sidebar-open');
  }
  if (id === 'students') renderStudents();
  if (id === 'assessment') renderAssess();
  if (id === 'intervention') renderInt();
}
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.sidebar a[data-section]').forEach(a => {
    a.addEventListener('click', e => { e.preventDefault(); show(a.dataset.section); });
  });
  renderStudents();
  renderGradeCards();
});
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2500);
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
function renderGradeCards() {
  const el = document.getElementById('gradeCards');
  if (!el) return;

  const setup = JSON.parse(localStorage.getItem('athar_teacher_setup') || '{}');
  const grades = setup.grades && setup.grades.length ? setup.grades : [...new Set(students.map(s => s.grade))];

  if (!grades.length) {
    el.innerHTML = '<p style="color:var(--text-light);">لم يتم تحديد صفوف بعد.</p>';
    return;
  }

  el.innerHTML = grades.map(g => {
    const count = students.filter(s => s.grade === g).length;
    return `<div class="card" style="padding:0.8rem; cursor:pointer;" onclick="filterByGrade('${g}')">
      <strong>${g}</strong>
      <div style="font-size:0.85rem; color:var(--text-light); margin-top:0.3rem;">${count} طالب</div>
      <div style="font-size:0.75rem; color:var(--primary); margin-top:0.4rem;">اضغط للعرض</div>
    </div>`;
  }).join('');
}

function filterByGrade(grade) {
  const sel = document.getElementById('filterGrade');
  if (sel) {
    sel.value = grade;
    renderStudents();
    showToast('عرض صف ' + grade);
  }
}
function renderStudents() {
  const el = document.getElementById('studentsList');
  const countEl = document.getElementById('studentCount');
  if (!el) return;

  const setup = JSON.parse(localStorage.getItem('athar_teacher_setup') || '{}');
  const teacherGrades = setup.grades || [];

  const gradeFilter = document.getElementById('filterGrade')?.value || '';
  const sectionFilter = (document.getElementById('filterSection')?.value || '').trim();

  let filtered = students;
  if (teacherGrades.length && !gradeFilter) {
    filtered = filtered.filter(s => teacherGrades.includes(s.grade));
  }
  if (gradeFilter) filtered = filtered.filter(s => s.grade === gradeFilter);
  if (sectionFilter) filtered = filtered.filter(s => s.section === sectionFilter);

  if (countEl) countEl.textContent = filtered.length;
  el.innerHTML = filtered.length
    ? filtered.map(s => `<div style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;"><div><strong>${s.name}</strong><div style="font-size:0.82rem; color:var(--text-light);">${s.grade} - شعبة ${s.section}${s.classGender ? ' • ' + (s.classGender==='mixed'?'مختلط':s.classGender==='boys'?'بنين':'بنات') : ''}</div></div><button class="btn small outline" onclick="removeStudent(${s.id})">حذف</button></div>`).join('')
    : '<p style="color:var(--text-light);">لا يوجد طلبة مطابقون.</p>';

  renderGradeCards();
}
function saveTeacherSetup() {
  const subjects = [];

  if (document.getElementById('subjArabic')?.checked) {
    subjects.push('أحب لغتي / اللغة العربية');
  }

  if (document.getElementById('subjIslamic')?.checked) {
    subjects.push('ديني حياتي / التربية الإسلامية');
  }

  if (document.getElementById('subjMath')?.checked) {
    subjects.push('الرياضيات');
  }

  if (document.getElementById('subjScience')?.checked) {
    subjects.push('العلوم');
  }

  if (document.getElementById('subjOther')?.checked) {
    subjects.push('مادة أخرى');
  }

  const grades = Array.from(
    document.querySelectorAll('.gradeCheck:checked')
  ).map(el => el.value);

  const setup = {
    subjects,
    grades
  };

  localStorage.setItem(
    'athar_teacher_setup',
    JSON.stringify(setup)
  );

  const el = document.getElementById('teacherSetupResult');

  if (el) {
    const subjectsText = subjects.length
      ? subjects.join('، ')
      : 'لم تُحدد';

    const gradesText = grades.length
      ? grades.join('، ')
      : 'لم تُحدد';

    el.innerHTML = `
      <div class="card">
        <strong>تم الحفظ</strong><br>
        المواد: ${subjectsText}<br>
        الصفوف: ${gradesText}<br>
        <small>
          سيتم عرض الطلبة حسب الصفوف المحددة في قائمة الطلبة.
        </small>
      </div>
    `;
  }

  renderGradeCards();
  showToast('تم حفظ إعدادات المعلم');
}

function addStudent() {
  const name = document.getElementById('newName').value.trim();
  const grade = document.getElementById('newGrade').value;
  const section =
    document.getElementById('newSection').value.trim() || 'أ';

  const schoolType =
    document.getElementById('schoolType')?.value || '';

  const classGender =
    document.getElementById('classGender')?.value || '';

  if (!name) {
    showToast('أدخل اسم الطالب');
    return;
  }

  const student = {
    id: Date.now(),
    name,
    grade,
    section,
    schoolType,
    classGender
  };

  students.push(student);

  localStorage.setItem(
    'athar_students',
    JSON.stringify(students)
  );

  saveRecord('student', {
    name,
    grade,
    section,
    schoolType,
    classGender
  });

  document.getElementById('newName').value = '';

  renderStudents();

  showToast('تمت إضافة ' + name);
}
function removeStudent(id) {
  students = students.filter(s => s.id !== id);
  localStorage.setItem('athar_students', JSON.stringify(students));
  renderStudents();
  showToast('تم الحذف');
}
function saveAssessment() {
  const name = document.getElementById('assessName').value;
  const total = +document.getElementById('total').value || 0;
  const correct = +document.getElementById('correct').value || 0;
  if (!name || total <= 0) return showToast('أكمل البيانات');
  const pct = Math.round(correct / total * 100);
  assessments.unshift({name, total, correct, pct, date: new Date().toLocaleDateString('ar')});
  localStorage.setItem('athar_assessments', JSON.stringify(assessments));
  document.getElementById('assessResult').innerHTML = `<strong>نسبة الإتقان: ${pct}%</strong>`;
  renderAssess();
  updateCycle();
  updateAlerts();
  showToast('تم الحفظ');
}
function renderAssess() {
  const el = document.getElementById('assessList');
  if (el) el.innerHTML = assessments.slice(0,5).map(a => `<div class="card" style="margin-top:.6rem;"><strong>${a.name}</strong> — ${a.pct}% <small>(${a.date})</small></div>`).join('');
}
function analyzeErrors() {
  const t = (document.getElementById('errorInput').value || '').toLowerCase();
  let html = '<div class="card">';
  if (t.includes('بسط') || t.includes('مقام') || t.includes('كسر')) {
    html += '<p><span class="badge danger">فجوة</span> تمثيل الكسور</p><p>اقتراح: نشاط ورقي بأشكال بصرية.</p>';
  } else if (t.includes('فهم') || t.includes('قراءة')) {
    html += '<p><span class="badge warning">فجوة</span> الفهم القرائي</p><p>اقتراح: نصوص قصيرة + اقرأ-فكر-شارك.</p>';
  } else {
    html += '<p><span class="badge info">عام</span> يُنصح بتقويم إضافي.</p>';
  }
  html += '<button class="btn small" onclick="show(\'intervention\')">إنشاء تدخل</button></div>';
  document.getElementById('analysisResult').innerHTML = html;
  showToast('تم التحليل');
}
function askAssistant() {
  const q = (document.getElementById('assistantInput').value || '').toLowerCase();
  let reply = 'يمكنني مساعدتك في تحليل الفجوات. صف المشكلة بمزيد من التفاصيل.';
  if (q.includes('كسر') || q.includes('بسط')) reply = '<strong>اقتراح:</strong> نشاط ورقي بأشكال مقسمة وتسمية البسط والمقام.';
  else if (q.includes('قراءة') || q.includes('فهم')) reply = '<strong>اقتراح:</strong> نصوص قصيرة واستراتيجية اقرأ-فكر-شارك.';
  document.getElementById('assistantReply').innerHTML = `<div class="card">${reply}</div>`;
  showToast('تم الرد');
}
function saveIntervention() {
  const data = { skill: document.getElementById('intSkill').value, goal: document.getElementById('intGoal').value, steps: document.getElementById('intSteps').value, date: new Date().toLocaleDateString('ar') };
  interventions.unshift(data);
  localStorage.setItem('athar_interventions', JSON.stringify(interventions));
  renderInt();
  updateCycle();
  updateAlerts();
  showToast('تم حفظ التدخل');
}
function renderInt() {
  const el = document.getElementById('intList');
  if (el) el.innerHTML = interventions.slice(0,4).map(i => `<div class="card" style="margin-top:.6rem;"><strong>${i.skill}</strong><br><small>${i.date}</small></div>`).join('');
}
function printWorksheet() {
  const w = window.open('', '_blank');
  w.document.write(`<html dir="rtl"><body style="font-family:Tajawal,sans-serif;padding:2rem;"><h2>ورقة عمل — ${document.getElementById('intSkill').value}</h2><p>${document.getElementById('intSteps').value.replace(/\n/g,'<br>')}</p></body></html>`);
  w.document.close();
  w.print();
}
function calcImpact() {
  const b = +document.getElementById('before').value;
  const a = +document.getElementById('after').value;
  const diff = a - b;
  document.getElementById('impactResult').innerHTML = `<div class="card"><strong>الفرق: ${diff>0?'+':''}${diff}%</strong></div>`;
  updateCycle();
  updateAlerts();
}
function getRoleName(role) {
  const names = {teacher:'معلم', supervisor:'مشرف / معلم أول', principal:'مدير', parent:'ولي أمر / طالب'};
  return names[role] || role;
}
function applyRoleUI() {
  const isParent = currentRole === 'parent';
  const isPrincipal = currentRole === 'principal';
  const isSupervisor = currentRole === 'supervisor';
  const isTeacher = currentRole === 'teacher';

  document.querySelectorAll('.sidebar a[data-section]').forEach(a => {
    const sec = a.dataset.section;
    let showLink = true;
    if (isParent) showLink = ['dashboard','studentProgress','guide','about'].includes(sec);
    else if (isPrincipal) showLink = ['dashboard','principalView','reports','roles','about'].includes(sec);
    else if (isSupervisor) showLink = !['students','assessment'].includes(sec);
    else if (isTeacher || currentRole === 'senior') showLink = true; // teachers see everything including setup
    a.style.display = showLink ? '' : 'none';
  });

  const guideTitle = document.getElementById('guideTitle');
  const guideContent = document.getElementById('guideContent');
  if (guideTitle && guideContent) {
    if (isParent) {
      guideTitle.textContent = 'دليل ولي الأمر / الطالب';
      guideContent.innerHTML = `
        <div class="card"><h3>كيف تتابع تقدم الطالب</h3><p>يمكنك الاطلاع على نتائج الطالب حسب كل مادة، وقراءة تعليقات المعلمين والتوصيات.</p></div>
        <div class="card" style="margin-top:0.8rem;"><h3>ما الذي يظهر لك</h3><p>بيانات الطالب فقط. لا تظهر أي معلومات عن بقية طلبة المدرسة.</p></div>`;
    } else if (isPrincipal) {
      guideTitle.textContent = 'دليل المدير';
      guideContent.innerHTML = `<div class="card"><h3>متابعة الصفوف</h3><p>راجع مؤشرات كل صف وشعبة، وتابع تقييم استخدام المعلمين للمنصة.</p></div>`;
    } else {
      guideTitle.textContent = 'دليل المعلم';
      guideContent.innerHTML = `
        <div class="card"><h3>1. إدخال التقويم</h3><p>أدخل نتائج تقويم قصير.</p></div>
        <div class="card" style="margin-top:0.8rem;"><h3>2. تحليل التعثر</h3><p>صف الأخطاء في رادار التعثر.</p></div>
        <div class="card" style="margin-top:0.8rem;"><h3>3. تصميم التدخل</h3><p>استخدم المصمم أو بنك الأنشطة.</p></div>
        <div class="card" style="margin-top:0.8rem;"><h3>4. قياس الأثر</h3><p>سجّل النتيجة بعد التدخل.</p></div>`;
    }
  }

  const info = document.getElementById('roleInfo');
  if (info) {
    const texts = {
      teacher: 'واجهة المعلم: إدخال التقويمات، تحليل التعثر، تصميم التدخلات، وقياس الأثر.',
      supervisor: 'واجهة المشرف: مراجعة الخطط والتدخلات والتقارير.',
      principal: 'واجهة المدير: متابعة الصفوف والمؤشرات وتقييم استخدام المعلمين.',
      parent: 'واجهة ولي الأمر/الطالب: الاطلاع على تقدم الطالب فقط حسب المواد وتعليقات المعلمين.'
    };
    info.innerHTML = `<div class="card"><strong>${getRoleName(currentRole)}</strong><br>${texts[currentRole]||''}</div>`;
  }
}
  const isParent = currentRole === 'parent';
  const isPrincipal = currentRole === 'principal';
  const isSupervisor = currentRole === 'supervisor';
  document.querySelectorAll('.sidebar a[data-section]').forEach(a => {
    const sec = a.dataset.section;
    let showLink = true;
    if (isParent) showLink = ['dashboard','about','guide'].includes(sec);
    else if (isPrincipal) showLink = ['dashboard','reports','about','roles'].includes(sec);
    else if (isSupervisor) showLink = !['students','assessment'].includes(sec);
    a.style.display = showLink ? '' : 'none';
  });
  const info = document.getElementById('roleInfo');
  if (info) {
    const texts = {
      teacher: 'واجهة المعلم: إدخال التقويمات، تحليل التعثر، تصميم التدخلات، وقياس الأثر.',
      supervisor: 'واجهة المشرف: مراجعة الخطط والتدخلات والتقارير.',
      principal: 'واجهة المدير: متابعة المؤشرات العامة والتقارير.',
      parent: 'واجهة ولي الأمر/الطالب: اطلاع محدود على التقدم والأنشطة المسموح بها.'
    };
    info.innerHTML = `<div class="card"><strong>${getRoleName(currentRole)}</strong><br>${texts[currentRole]||''}</div>`;
  }
}
function applyAccess() {
  document.body.style.fontSize = document.getElementById('largeText')?.checked ? '1.15rem' : '';
  document.body.style.filter = document.getElementById('highContrast')?.checked ? 'contrast(1.3)' : '';
}
function toggleLowResource() {
  document.body.classList.toggle('low-resource');
  const on = document.body.classList.contains('low-resource');
  document.getElementById('lowResInfo').innerHTML = on ? '<span class="badge success">مفعّل</span>' : '<span class="badge info">متوقف</span>';
  showToast(on ? 'تم تفعيل الوضع' : 'تم إيقاف الوضع');
}
function suggestPath() {
  document.getElementById('pathResult').innerHTML = `<div class="card"><strong>مسار مقترح:</strong> استراتيجيات تدريس الكسور والفهم القرائي</div>`;
}
function useActivity(skill, steps) {
  document.getElementById('intSkill').value = skill;
  document.getElementById('intSteps').value = steps;
  show('intervention');
  showToast('تم نقل النشاط');
}
function editTeam() {
  const n = prompt('اسم الفريق:');
  if (n) { document.getElementById('teamName').textContent = n; localStorage.setItem('athar_team', n); }
}
if (localStorage.getItem('athar_team')) document.getElementById('teamName').textContent = localStorage.getItem('athar_team');
function exportData() {
  const blob = new Blob([JSON.stringify({students, assessments, interventions}, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'athar-data.json';
  a.click();
  showToast('تم التصدير');
}
function importData(e) {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => {
    try {
      const d = JSON.parse(ev.target.result);
      if (d.students) students = d.students;
      if (d.assessments) assessments = d.assessments;
      if (d.interventions) interventions = d.interventions;
      localStorage.setItem('athar_students', JSON.stringify(students));
      localStorage.setItem('athar_assessments', JSON.stringify(assessments));
      localStorage.setItem('athar_interventions', JSON.stringify(interventions));
      showToast('تم الاستيراد');
      renderStudents(); renderAssess(); renderInt();
    } catch { showToast('خطأ في الملف'); }
  };
  r.readAsText(f);
}
function updateCycle() {
  let steps = 0;
  if (assessments.length) steps++;
  if (document.getElementById('analysisResult')?.innerHTML) steps++;
  if (interventions.length) steps++;
  if (document.getElementById('impactResult')?.innerHTML) steps++;
  const pct = Math.round(steps / 4 * 100);
  const bar = document.getElementById('cycleBar');
  const txt = document.getElementById('cycleText');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = `تقويم ${assessments.length?'✓':'—'} | تحليل ${steps>1?'✓':'—'} | تدخل ${interventions.length?'✓':'—'} | قياس ${steps>3?'✓':'—'}`;
}
function updateAlerts() {
  const el = document.getElementById('smartAlerts');
  if (!el) return;
  let alerts = [];
  if (assessments.length && !interventions.length) alerts.push('لديك تقويم ولم يُسجل تدخل بعد.');
  if (interventions.length && !document.getElementById('impactResult')?.innerHTML) alerts.push('يوجد تدخل لم يُقاس أثره بعد.');
  el.innerHTML = alerts.length ? alerts.map(a => `<div class="note" style="margin:.3rem 0;">${a}</div>`).join('') : '<span class="badge success">لا توجد تنبيهات</span>';
}
updateCycle();
updateAlerts();
applyRoleUI();

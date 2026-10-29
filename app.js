let students = JSON.parse(localStorage.getItem('athar_students') || '[]');
let assessments = JSON.parse(localStorage.getItem('athar_assessments') || '[]');
let interventions = JSON.parse(localStorage.getItem('athar_interventions') || '[]');
let currentRole = null;
let currentUser = null;
const API_BASE = (window.ATHAR_CONFIG && window.ATHAR_CONFIG.apiBase || '').replace(/\/$/, '');
const apiUrl = path => `${API_BASE}${path}`;
async function api(path, options={}) {
  const response = await fetch(apiUrl(path), { credentials:'include', ...options,
    headers: { 'Content-Type':'application/json', ...(options.headers||{}) } });
  const data = await response.json().catch(()=>({message:'استجابة غير مفهومة من الخادم'}));
  if (!response.ok) throw new Error(data.message || 'تعذر تنفيذ الطلب');
  return data;
}
function setAuthMessage(message, error=false) {
  const el=document.getElementById('authMessage');
  if(el){el.textContent=message;el.style.color=error?'#C62828':'#00796B';}
}
async function requestLoginCode() {
  const email=document.getElementById('loginEmail').value.trim().toLowerCase();
  if(!email) return setAuthMessage('أدخل بريدك الإلكتروني الرسمي.',true);
  const btn=document.getElementById('requestCodeBtn'); btn.disabled=true;
  try {
    const result=await api('/api/auth/request-code',{method:'POST',body:JSON.stringify({email})});
    document.getElementById('otpArea').hidden=false;
    setAuthMessage(result.message || 'إذا كان الحساب مسجلًا، فسيصل رمز التحقق إلى بريدك.');
  } catch(e) { setAuthMessage(e.message + ' — تأكد من إعداد الخادم والبريد الإلكتروني.',true); }
  finally {btn.disabled=false;}
}
async function verifyLoginCode() {
  const email=document.getElementById('loginEmail').value.trim().toLowerCase();
  const code=document.getElementById('loginCode').value.trim();
  if(!/^\d{6}$/.test(code)) return setAuthMessage('أدخل رمز التحقق المكون من 6 أرقام.',true);
  const btn=document.getElementById('verifyCodeBtn'); btn.disabled=true;
  try {
    const result=await api('/api/auth/verify-code',{method:'POST',body:JSON.stringify({email,code})});
    currentUser=result.user; currentRole=result.user.role;
    document.getElementById('loginScreen').classList.add('hidden');
    applyRoleUI(); showToast('مرحبًا ' + (result.user.name || result.user.email) + ' — ' + getRoleName(currentRole));
  } catch(e) {setAuthMessage(e.message,true);}
  finally {btn.disabled=false;}
}
async function restoreSession() {
  try {
    const result=await api('/api/auth/me');
    currentUser=result.user; currentRole=result.user.role;
    document.getElementById('loginScreen').classList.add('hidden'); applyRoleUI();
  } catch { document.getElementById('loginScreen').classList.remove('hidden'); }
}
function logout() {
  api('/api/auth/logout',{method:'POST'}).catch(()=>{});
  currentUser=null; currentRole=null;
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginCode').value='';
}
document.addEventListener('DOMContentLoaded',restoreSession);


function syncRecord(kind,payload) {
  if (!currentUser) return;
  api('/api/records',{method:'POST',body:JSON.stringify({kind,payload})})
    .catch(err=>showToast('حُفظ محليًا فقط؛ تعذرت المزامنة مع الخادم: '+err.message));
}
function toggleGroup(el) {
  const group=el.parentElement;
  const wasOpen=group.classList.contains('open');
  document.querySelectorAll('.menu-group.open').forEach(g=>g.classList.remove('open'));
  if(!wasOpen) group.classList.add('open');
}
function toggleSidebar() {
  const sb=document.getElementById('sidebar');
  if(window.innerWidth<=900){
    sb.classList.toggle('open');
    document.body.classList.toggle('sidebar-open',sb.classList.contains('open'));
  } else {
    sb.classList.toggle('closed');
    document.body.classList.toggle('sidebar-closed',sb.classList.contains('closed'));
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
function renderStudents() {
  const el = document.getElementById('studentsList');
  const countEl = document.getElementById('studentCount');
  if (!el) return;
  const gradeFilter = document.getElementById('filterGrade')?.value || '';
  const sectionFilter = (document.getElementById('filterSection')?.value || '').trim();
  let filtered = students;
  if (gradeFilter) filtered = filtered.filter(s => s.grade === gradeFilter);
  if (sectionFilter) filtered = filtered.filter(s => s.section === sectionFilter);
  if (countEl) countEl.textContent = filtered.length;
  el.innerHTML = filtered.length
    ? filtered.map(s => `<div style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;"><div><strong>${s.name}</strong><div style="font-size:0.82rem; color:var(--text-light);">${s.grade} - شعبة ${s.section}</div></div><button class="btn small outline" onclick="removeStudent(${s.id})">حذف</button></div>`).join('')
    : '<p style="color:var(--text-light);">لا يوجد طلبة مطابقون للتصفية.</p>';
}
function addStudent() {
  const name = document.getElementById('newName').value.trim();
  const grade = document.getElementById('newGrade').value;
  const section = document.getElementById('newSection').value.trim() || 'أ';
  if (!name) return showToast('أدخل اسم الطالب');
  students.push({id: Date.now(), name, grade, section});
  localStorage.setItem('athar_students', JSON.stringify(students));
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
  const names = {teacher:'معلم', senior_teacher:'المعلم الأول', supervisor:'المعلم الأول', principal:'مدير', parent:'ولي أمر'};
  return names[role] || role;
}
function applyRoleUI() {
  const allowed = {
    teacher: ['dashboard','students','assessment','radar','assistant','intervention','activities','impact','reports','inclusive','lowresource','privacy','teacherdev','guide','about'],
    senior_teacher: ['dashboard','students','assessment','radar','assistant','intervention','activities','impact','reports','inclusive','lowresource','curriculum','privacy','teacherdev','guide','about'],
    supervisor: ['dashboard','students','assessment','radar','assistant','intervention','activities','impact','reports','inclusive','lowresource','curriculum','privacy','teacherdev','guide','about'],
    principal: ['dashboard','principalView','reports','roles','privacy','curriculum','guide','about'],
    parent: ['dashboard','studentProgress','guide','about']
  };
  const role=currentRole || 'teacher';
  document.querySelectorAll('.sidebar a[data-section]').forEach(a=>{
    a.style.display=(allowed[role]||allowed.teacher).includes(a.dataset.section)?'':'none';
  });
  document.querySelectorAll('.menu-group').forEach(g=>{
    const visible=[...g.querySelectorAll('a[data-section]')].some(a=>a.style.display!=='none');
    g.style.display=visible?'':'none';
  });
  const info=document.getElementById('roleInfo');
  if(info) info.innerHTML=`<div class="card"><strong>${getRoleName(role)}</strong><br>${role==='parent'?'عرض بيانات الطالب المرتبط بالحساب فقط.':role==='principal'?'متابعة مؤشرات المدرسة والتقارير.':role==='senior_teacher'||role==='supervisor'?'مراجعة الخطط والتقارير والإشراف التربوي.':'إدخال التقويمات وتحليل التعثر وتصميم التدخلات وقياس الأثر.'}</div>`;
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

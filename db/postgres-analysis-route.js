import * as records from './records.js';
import { findStudentAccessibleTo } from './authorization.js';
import { canRunLearningAnalysis } from './role-policy.js';

const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);
const normalize = value => clean(value, 160).toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '');

const skillMap = [
  { keys:['تمثيل الكسور','الكسور','كسر','البسط','المقام'], title:'تمثيل الكسور', prerequisites:['الجزء والكل','معرفة البسط والمقام'], next:['مقارنة الكسور','العمليات على الكسور'], strategies:['استخدم شرائط الكسور والأشكال المقسمة لربط الجزء بالكل.','اطلب من الطالب تسمية البسط والمقام قبل تمثيل الكسر.','قدّم سؤال تحقق قصيرًا بعد كل مثال.'] },
  { keys:['العمليات على الكسور','جمع الكسور','طرح الكسور'], title:'العمليات على الكسور', prerequisites:['تمثيل الكسور','الكسور المتكافئة'], next:['حل المسائل اللفظية على الكسور'], strategies:['راجع تمثيل الكسر بصريًا قبل الانتقال إلى الخوارزمية.','استخدم نماذج متكافئة للمقامات.','درّب الطالب على تفسير سبب اختيار العملية.'] },
  { keys:['الفهم القرائي','القراءة','فهم المقروء'], title:'الفهم القرائي', prerequisites:['الطلاقة القرائية','المفردات والسياق'], next:['الفكرة الرئيسة','الاستدلال من النص'], strategies:['استخدم نصوصًا قصيرة متعددة المستويات.','درّب الطلبة على تحديد الدليل النصي.','اطلب إعادة صياغة الفكرة بكلمات الطالب.'] },
  { keys:['الفكرة الرئيسة','الفكرة الرئيسية'], title:'الفكرة الرئيسة', prerequisites:['المفردات والسياق','الفهم القرائي'], next:['التلخيص','الاستدلال من النص'], strategies:['استخدم عناوين وصورًا متوقعة قبل القراءة.','ميّز بين الفكرة الرئيسة والتفاصيل الداعمة.','اطلب اختيار عنوان مناسب مع ذكر الدليل.'] },
  { keys:['الاستدلال','الاستنتاج'], title:'الاستدلال من النص', prerequisites:['الفهم القرائي','المفردات والسياق'], next:['التفسير النقدي'], strategies:['استخدم أسئلة لماذا وكيف مع مطالبة الطالب بالدليل.','اعرض قرائن متفرقة واطلب ربطها.','ناقش أكثر من احتمال قبل اختيار الاستنتاج.'] }
];

function mappedSkill(skill) {
  const key = normalize(skill);
  return skillMap.flatMap(item => item.keys
    .filter(candidate => key.includes(normalize(candidate)) || normalize(candidate).includes(key))
    .map(candidate => ({ item, length: normalize(candidate).length })))
    .sort((a,b) => b.length-a.length)[0]?.item || null;
}

function calculate(assessments, skill, studentId, observedErrors) {
  const mapped = mappedSkill(skill);
  const title = mapped?.title || skill;
  const target = normalize(title);
  const matches = row => {
    const candidate = normalize(row.skill || row.name || '');
    return candidate && target && (candidate.includes(target) || target.includes(candidate));
  };
  let selected = assessments.filter(row => (!studentId || String(row.student_id) === String(studentId)) && matches(row));
  selected.sort((a,b) => String(b.date || b.created_at || '').localeCompare(String(a.date || a.created_at || '')));
  const latest = new Map();
  for (const row of selected) {
    const key = row.student_id || `class:${row.grade || ''}:${row.section || ''}`;
    if (!latest.has(key)) latest.set(key, []);
    if (latest.get(key).length < 2) latest.get(key).push(row);
  }
  const histories = [...latest.values()];
  const scores = histories.map(items => Number(items[0]?.pct)).filter(Number.isFinite);
  const targetScore = scores.length ? Number((scores.reduce((a,b)=>a+b,0)/scores.length).toFixed(1)) : null;
  const changes = histories.filter(items => items.length>1 && Number.isFinite(Number(items[0].pct)) && Number.isFinite(Number(items[1].pct)))
    .map(items => Number(items[0].pct)-Number(items[1].pct));
  const trend = changes.length ? Number((changes.reduce((a,b)=>a+b,0)/changes.length).toFixed(1)) : null;
  const prerequisites = mapped?.prerequisites || [];
  const prerequisiteEvidence = prerequisites.map(name => {
    const needle = normalize(name);
    const rows = assessments.filter(row => {
      if (studentId && String(row.student_id)!==String(studentId)) return false;
      const value = normalize(row.skill || row.name || '');
      return value && (value.includes(needle) || needle.includes(value));
    }).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
    const perStudent = new Map();
    for (const row of rows) {
      const key = row.student_id || `class:${row.grade||''}:${row.section||''}`;
      if (!perStudent.has(key)) perStudent.set(key, Number(row.pct));
    }
    const values = [...perStudent.values()].filter(Number.isFinite);
    return { skill:name, score:values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(1)):null, sampleSize:values.length };
  });
  const likelyRoots = prerequisiteEvidence.filter(item=>item.score!==null && item.score<70);
  const level = targetScore===null?'لا تتوفر نتائج كافية':targetScore<50?'تعثر مرتفع':targetScore<70?'يحتاج إلى دعم':targetScore<85?'قريب من الإتقان':'متقن';
  const recommendations = targetScore===null
    ? ['أدخل نتيجة تقويم لهذه المهارة أولًا.','نفّذ تقويمًا قصيرًا للمهارات السابقة لتحديد جذر الفجوة.']
    : targetScore<70 ? (mapped?.strategies || ['ابدأ بتقويم تشخيصي قصير يحدد نوع الخطأ.','قسّم المهارة إلى خطوات أصغر، ثم قدّم نموذجًا محلولًا.','استخدم سؤال تحقق مستقلًا بعد النشاط.'])
    : ['قدّم نشاطًا تطبيقيًا للتحقق من ثبات الإتقان.','انتقل تدريجيًا إلى المهارات اللاحقة دون إلغاء المراجعة.'];
  const evidence = [];
  if(targetScore!==null) evidence.push(`متوسط أحدث النتائج الممثلة للمهارة ${targetScore}%.`);
  if(trend!==null) evidence.push(`التغير عن التقويم السابق ${trend>0?'+':''}${trend} نقطة مئوية.`);
  if(likelyRoots.length) evidence.push(`ظهرت فجوة في مهارات سابقة: ${likelyRoots.map(x=>`${x.skill} (${x.score}%)`).join('، ')}.`);
  if(observedErrors) evidence.push(`ملاحظة المعلم: ${observedErrors}`);
  return {skill:title,level,targetScore,trend,sampleSize:scores.length,likelyRoots,prerequisiteEvidence,nextSkills:mapped?.next||[],evidence,recommendations,
    disclaimer:'تحليل مساند مبني على السجلات المتاحة وخريطة مهارات أولية؛ لا يمثل تشخيصًا نهائيًا، ويعتمد القرار على مراجعة المعلم.'};
}

export function registerPostgresAnalysisRoute(app,{requireAuth,requireRole}) {
  app.post('/api/analysis',requireAuth,requireRole('teacher','senior_teacher','principal'),async(req,res,next)=>{
    try {
      if(!canRunLearningAnalysis(req.user)) return res.status(403).json({message:'ليس لديك صلاحية لتحليل البيانات.'});
      const skill=clean(req.body?.skill||req.body?.question,160)||'مهارة غير محددة';
      const studentId=clean(req.body?.student_id,80);
      if(studentId && !(await findStudentAccessibleTo(req.user,studentId)))
        return res.status(403).json({message:'الطالب غير تابع لنطاق صلاحياتك أو غير موجود في المدرسة.'});
      const assessments=await records.listAssessmentsForAnalysis(req.user);
      const result=calculate(assessments,skill,studentId,clean(req.body?.observedErrors,1000));
      const saved=await records.insertRecord({schoolId:req.user.school_id,ownerId:req.user.id,kind:'analysis',
        payload:{student_id:studentId||null,skill:result.skill,result,date:new Date().toISOString()}});
      await (await import('./auth.js')).writeAudit(req.user.id,'learning.analysis',result.skill);
      res.json({analysis:result,id:saved.id});
    } catch(error){next(error);}
  });
}

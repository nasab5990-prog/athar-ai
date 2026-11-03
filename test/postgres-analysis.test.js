import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLearningAnalysis } from '../db/postgres-analysis-route.js';

test('learning analysis identifies a prerequisite gap and gives grounded recommendations', () => {
  const assessments = [
    { student_id:'S-1', skill:'تمثيل الكسور', pct:45, date:'2026-10-20' },
    { student_id:'S-1', skill:'تمثيل الكسور', pct:60, date:'2026-10-10' },
    { student_id:'S-1', skill:'الجزء والكل', pct:40, date:'2026-10-19' },
    { student_id:'S-1', skill:'معرفة البسط والمقام', pct:85, date:'2026-10-18' },
    { student_id:'S-2', skill:'تمثيل الكسور', pct:75, date:'2026-10-21' }
  ];
  const result = calculateLearningAnalysis(assessments,'الكسور','S-1','يخلط بين البسط والمقام');
  assert.equal(result.skill,'تمثيل الكسور');
  assert.equal(result.targetScore,45);
  assert.equal(result.trend,-15);
  assert.equal(result.sampleSize,1);
  assert.ok(result.likelyRoots.some(item=>item.skill==='الجزء والكل'&&item.score===40));
  assert.ok(result.recommendations.length>=2);
  assert.ok(result.evidence.some(item=>item.includes('يخلط بين البسط والمقام')));
  assert.match(result.disclaimer,/لا يمثل تشخيصًا نهائيًا/);
});

test('learning analysis isolates a requested student and handles missing evidence', () => {
  const result = calculateLearningAnalysis([
    { student_id:'S-1', skill:'الفهم القرائي', pct:30, date:'2026-10-20' },
    { student_id:'S-2', skill:'الفهم القرائي', pct:95, date:'2026-10-21' }
  ],'الفهم القرائي','S-1','');
  assert.equal(result.targetScore,30);
  assert.equal(result.sampleSize,1);

  const empty = calculateLearningAnalysis([], 'مهارة غير مدرجة', '', '');
  assert.equal(empty.targetScore,null);
  assert.equal(empty.level,'لا تتوفر نتائج كافية');
  assert.ok(empty.recommendations.length>0);
});

test('learning analysis handles improvement and avoids inventing trend without two assessments', () => {
  const improved = calculateLearningAnalysis([
    { student_id:'S-1', skill:'الفكرة الرئيسة', pct:80, date:'2026-10-22' },
    { student_id:'S-1', skill:'الفكرة الرئيسة', pct:55, date:'2026-10-12' }
  ],'الفكرة الرئيسة','S-1','');
  assert.equal(improved.trend,25);
  assert.equal(improved.level,'قريب من الإتقان');

  const single = calculateLearningAnalysis([
    { student_id:'S-1', skill:'الفكرة الرئيسة', pct:80, date:'2026-10-22' }
  ],'الفكرة الرئيسة','S-1','');
  assert.equal(single.trend,null);
});


test('learning analysis follows repository order rather than user-entered assessment dates', () => {
  const result = calculateLearningAnalysis([
    { student_id:'S-1', skill:'الفكرة الرئيسة', pct:82, date:'2026-10-01' },
    { student_id:'S-1', skill:'الفكرة الرئيسة', pct:60, date:'2026-10-25' },
    { student_id:'S-1', skill:'المفردات والسياق', pct:80, date:'2026-10-02' }
  ],'الفكرة الرئيسة','S-1','');
  assert.equal(result.targetScore,82);
  assert.equal(result.trend,22);
  assert.ok(result.evidence.some(item=>item.includes('لا توجد نتائج منخفضة')));
});

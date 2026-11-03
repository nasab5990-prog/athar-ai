import * as records from './records.js';
import { canCreateEducationalRecords, canManageSchoolUsers } from './role-policy.js';

const allowedKinds = new Set(['student', 'assessment', 'intervention', 'impact']);
const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);

export function registerPostgresDataRoutes(app, { requireAuth, requireRole }) {
  app.get('/api/records', requireAuth, async (req, res, next) => {
    try {
      res.json({ records: await records.listRecordsForUser(req.user) });
    } catch (error) { next(error); }
  });

  app.post('/api/records', requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), async (req, res, next) => {
    try {
      if (!canCreateEducationalRecords(req.user) || req.user.school_id === 'DEMO-SCHOOL')
        return res.status(403).json({ message: 'لا يمكن إضافة سجلات في هذه البيئة أو بهذا الدور.' });
      const kind = clean(req.body?.kind, 40);
      const payload = req.body?.payload;
      if (!allowedKinds.has(kind) || !payload || typeof payload !== 'object' || Array.isArray(payload))
        return res.status(400).json({ message: 'نوع السجل أو بياناته غير صالحة.' });
      if (kind !== 'student') {
        const studentId = clean(payload.student_id, 80);
        if (!studentId) return res.status(400).json({ message: 'يجب تحديد الطالب.' });
        const student = await records.findStudentRecord(req.user.school_id, studentId);
        if (!student) return res.status(404).json({ message: 'الطالب غير موجود في المدرسة.' });
        if (req.user.role === 'teacher' && String(student.owner_id) !== String(req.user.id)) {
          const assigned = await (await import('./authorization.js')).findStudentAccessibleTo(req.user, studentId);
          if (!assigned) return res.status(403).json({ message: 'الطالب غير ضمن نطاق صلاحياتك.' });
        }
      }
      const created = await records.insertRecord({
        schoolId: req.user.school_id, ownerId: req.user.id, kind, payload
      });
      res.status(201).json({ record: created });
    } catch (error) { next(error); }
  });

  app.post('/api/records/bulk', requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), async (req, res, next) => {
    try {
      if (!canCreateEducationalRecords(req.user) || req.user.school_id === 'DEMO-SCHOOL')
        return res.status(403).json({ message: 'لا يمكن إضافة سجلات في هذه البيئة أو بهذا الدور.' });
      const items = req.body?.records;
      if (!Array.isArray(items) || items.length < 1 || items.length > 100 ||
          items.some(item => !allowedKinds.has(clean(item?.kind, 40)) ||
            !item?.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)))
        return res.status(400).json({ message: 'قائمة السجلات غير صالحة (1 إلى 100 سجل).' });
      for (const item of items.filter(item => item.kind !== 'student')) {
        const studentId = clean(item.payload.student_id, 80);
        const student = studentId ? await records.findStudentRecord(req.user.school_id, studentId) : null;
        if (!student)
          return res.status(400).json({ message: 'تأكد من إضافة الطلبة قبل سجلاتهم المرتبطة.' });
        if (req.user.role === 'teacher' && String(student.owner_id) !== String(req.user.id)) {
          const assigned = await (await import('./authorization.js')).findStudentAccessibleTo(req.user, studentId);
          if (!assigned) return res.status(403).json({ message: 'أحد الطلبة غير ضمن نطاق صلاحياتك.' });
        }
      }
      const created = await records.insertRecordsBatch({
        schoolId: req.user.school_id, ownerId: req.user.id, records: items
      });
      res.status(201).json({ records: created, count: created.length });
    } catch (error) { next(error); }
  });

  app.delete('/api/records/:id', requireAuth, requireRole('teacher', 'senior_teacher', 'principal'), async (req, res, next) => {
    try {
      if (req.user.school_id === 'DEMO-SCHOOL')
        return res.status(403).json({ message: 'الحذف غير متاح في بيئة الاختبار.' });
      const result = await records.deleteRecord({
        id: clean(req.params.id, 30), schoolId: req.user.school_id,
        requesterId: req.user.id, requesterRole: req.user.role
      });
      if (result.status === 'not_found') return res.status(404).json({ message: 'السجل غير موجود.' });
      if (result.status === 'forbidden') return res.status(403).json({ message: 'لا يمكنك حذف سجل لا تملكه.' });
      if (result.status === 'linked') return res.status(409).json({ message: 'لا يمكن حذف طالب مرتبط بحساب ولي أمر أو طالب.' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/api/users', requireAuth, requireRole('principal'), async (req, res, next) => {
    try {
      res.json({ users: await records.listSchoolUsers(req.user.school_id) });
    } catch (error) { next(error); }
  });

  app.post('/api/users', requireAuth, requireRole('principal'), async (req, res, next) => {
    try {
      if (!canManageSchoolUsers(req.user) || req.user.school_id === 'DEMO-SCHOOL')
        return res.status(403).json({ message: 'إدارة الحسابات غير متاحة في بيئة الاختبار.' });
      const email = clean(req.body?.email, 254).toLowerCase();
      const domain = email.split('@')[1];
      if (!['moe.om', 'edu.moe.om'].includes(domain))
        return res.status(400).json({ message: 'يُسمح بالبريد الرسمي للوزارة فقط.' });
      const result = await records.createSchoolUser({
        email, name: clean(req.body?.name, 120), role: clean(req.body?.role, 30),
        schoolId: req.user.school_id,
        studentIds: Array.isArray(req.body?.studentIds) ? req.body.studentIds.map(id => clean(id, 80)) : []
      });
      if (result.status === 'created') return res.status(201).json({ user: result.user });
      const status = result.status === 'student_not_found' ? 404 : 400;
      res.status(status).json({ message: 'تعذر إنشاء الحساب؛ تحقق من الدور والطلبة المرتبطين.' });
    } catch (error) { next(error); }
  });

  app.put('/api/users/:id/assignments', requireAuth, requireRole('principal'), async (req, res, next) => {
    try {
      if (req.user.school_id === 'DEMO-SCHOOL') return res.status(403).json({ message: 'غير متاح في بيئة الاختبار.' });
      const studentIds = req.body?.studentIds;
      if (!Array.isArray(studentIds) || studentIds.length > 500) return res.status(400).json({ message: 'قائمة الطلبة غير صالحة.' });
      const result = await records.replaceTeacherAssignments({
        userId: clean(req.params.id, 30), schoolId: req.user.school_id,
        studentIds: studentIds.map(id => clean(id, 80))
      });
      if (result.status === 'not_found') return res.status(404).json({ message: 'المعلم غير موجود.' });
      if (result.status === 'student_not_found') return res.status(400).json({ message: 'يوجد طالب غير مسجل في المدرسة.' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.put('/api/users/:id/student-links', requireAuth, requireRole('principal'), async (req, res, next) => {
    try {
      if (req.user.school_id === 'DEMO-SCHOOL') return res.status(403).json({ message: 'غير متاح في بيئة الاختبار.' });
      const studentIds = req.body?.studentIds;
      if (!Array.isArray(studentIds) || studentIds.length > 500) return res.status(400).json({ message: 'قائمة الطلبة غير صالحة.' });
      const result = await records.replaceAccountStudentLinks({
        userId: clean(req.params.id, 30), schoolId: req.user.school_id,
        role: clean(req.body?.role, 30), studentIds: studentIds.map(id => clean(id, 80))
      });
      if (result.status === 'not_found') return res.status(404).json({ message: 'الحساب غير موجود أو دوره غير مطابق.' });
      if (result.status === 'student_not_found') return res.status(400).json({ message: 'يوجد طالب غير مسجل في المدرسة.' });
      if (result.status === 'invalid_links') return res.status(400).json({ message: 'عدد روابط الطلبة غير صالح لهذا الدور.' });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
}

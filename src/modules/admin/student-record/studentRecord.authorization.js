// This deployment has one school database (no tenant/school discriminator).
// JWT userId is qed_authentication.id, not a teacher_table/parent_table ID.
function requireStudentIdentity(req, res, next) {
  const { userId, role, purpose } = req.user ?? {};
  if (purpose !== undefined || typeof role !== 'string' ||
      !['ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT'].includes(role.toUpperCase()) ||
      !['string', 'number'].includes(typeof userId) || !/^[1-9]\d*$/.test(String(userId)) ||
      !Number.isSafeInteger(Number(userId))) {
    return res.status(403).json({ success: false, message: 'Student record access is not authorized.' });
  }
  req.studentIdentity = { role: role.toUpperCase(), userId };
  next();
}

function studentReadScope(req, alias) {
  const identity = req.studentIdentity;
  if (!identity) throw new Error('Student authorization middleware required.');
  if (identity.role === 'ADMIN' || identity.role === 'PRINCIPAL') return { sql: '1 = 1', params: [] };
  if (identity.role === 'PARENT') return {
    sql: `EXISTS (SELECT 1 FROM parent_student ps
      INNER JOIN parent_table pt ON pt.id = ps.parent_id
      WHERE pt.user_id = ? AND pt.is_deleted = 0 AND ps.student_id = ${alias}.id)`,
    params: [identity.userId],
  };
  return {
    sql: `(${alias}.current_school_year_id = (SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)
      AND (EXISTS (SELECT 1 FROM \`subject-section\` ss
        INNER JOIN teacher_table tt ON tt.id = ss.teacher_id
        INNER JOIN elem_subjects assigned_subject ON assigned_subject.id = ss.subject_id
        WHERE tt.user_id = ? AND tt.is_deleted = 0
          AND ss.school_year_id = ${alias}.current_school_year_id
          AND (ss.section_id = ${alias}.section_id OR
            (ss.section_id IS NULL AND assigned_subject.grade_level_id = ${alias}.grade_level_id)))
      OR EXISTS (SELECT 1 FROM classes c
        INNER JOIN teacher_table tt ON tt.id = c.class_adviser_id
        WHERE tt.user_id = ? AND tt.is_deleted = 0 AND c.status = 'Active'
          AND c.school_year_id = ${alias}.current_school_year_id
          AND (c.section_id = ${alias}.section_id OR
            (c.section_id IS NULL AND ${alias}.section_id IS NULL AND c.grade_level_id = ${alias}.grade_level_id)))))`,
    params: [identity.userId, identity.userId],
  };
}
function requireTeacherStudentIdentity(req, res, next) {
  requireStudentIdentity(req, res, () => {
    if (req.studentIdentity.role !== 'TEACHER') return res.status(403).json({ success: false, message: 'Teacher access is required.' });
    next();
  });
}
module.exports = { requireStudentIdentity, requireTeacherStudentIdentity, studentReadScope };

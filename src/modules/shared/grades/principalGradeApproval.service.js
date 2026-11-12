const { createHash } = require('node:crypto');
const pool = require('../../../../config/db');
const { eligibleForPeriodSql } = require('./dropoutAcademicPolicy');
const { getSubjectComponentGrades } = require('./gradeCache.service');

async function withGradeSnapshot(action) {
  const db = await pool.getConnection();
  let reusable = false;
  try {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.beginTransaction();
    const result = await action(db);
    await db.commit();
    reusable = true;
    return result;
  } catch (error) {
    try {
      await db.rollback();
    } catch {
      // The connection is discarded below if its state is uncertain.
    }
    throw error;
  } finally {
    if (reusable) db.release();
    else db.destroy();
  }
}

async function loadApprovalRecords(db, periodId, scope) {
  const forStudent = scope.studentId != null;
  const studentFilter = forStudent ? 's.id = ?' : `s.grade_level_id = ? AND s.section_id <=> ?
    AND EXISTS (SELECT 1 FROM classes c WHERE c.school_year_id = sy.id
      AND c.grade_level_id = s.grade_level_id AND c.section_id <=> s.section_id AND c.status = 'Active')`;
  const [rows] = await db.execute(
    `SELECT s.id AS studentId, s.first_name AS firstName, s.last_name AS lastName,
            s.section_id AS sectionId, s.grade_level_id AS gradeLevelId,
            (gp.end_date < CURDATE()) AS termEnded, gp.term_label AS termLabel,
            ${eligibleForPeriodSql('s.id', 'gp.id')} AS eligible,
            EXISTS (SELECT 1 FROM grade_submissions gs
              WHERE gs.grading_period_id = gp.id AND gs.section_id <=> s.section_id
                AND (s.section_id IS NOT NULL OR gs.grade_level_id = s.grade_level_id)) AS submitted,
            ss.id AS subjectSectionId, es.subject_name AS subject,
            gc.average, gc.is_complete AS isComplete, og.overall_average AS overallAverage,
            pa.grade_fingerprint AS approvedFingerprint
       FROM grading_periods gp
       JOIN school_year sy ON sy.id = gp.school_year_id AND sy.is_active = 1
       JOIN elem_students s ON s.current_school_year_id = gp.school_year_id
       LEFT JOIN \`subject-section\` ss ON ss.school_year_id = sy.id AND ss.status = 'Active'
         AND (ss.section_id = s.section_id OR (ss.section_id IS NULL AND EXISTS (
           SELECT 1 FROM elem_subjects shared_subject
           WHERE shared_subject.id = ss.subject_id AND shared_subject.grade_level_id = s.grade_level_id)))
         AND EXISTS (SELECT 1 FROM elem_subjects graded WHERE graded.id = ss.subject_id AND graded.is_graded = 1)
       LEFT JOIN elem_subjects es ON es.id = ss.subject_id
       LEFT JOIN subject_grade_cache gc ON gc.student_id = s.id AND gc.grading_period_id = gp.id
         AND gc.subject_section_id = ss.id
       LEFT JOIN advisory_overall_grades og ON og.student_id = s.id AND og.grading_period_id = gp.id
       LEFT JOIN principal_grade_approvals pa ON pa.student_id = s.id AND pa.grading_period_id = gp.id
       WHERE gp.id = ? AND s.is_deleted = 0 AND s.status <> 'graduated' AND ${studentFilter}
       ORDER BY s.last_name, s.first_name, s.id, es.subject_name, ss.id`,
    [periodId, ...(forStudent ? [scope.studentId] : [scope.gradeLevelId, scope.sectionId])]
  );

  const grouped = new Map();
  for (const row of rows) {
    const key = String(row.studentId);
    if (!grouped.has(key)) grouped.set(key, { row, subjects: [] });
    if (row.subjectSectionId != null) grouped.get(key).subjects.push({
      subjectSectionId: String(row.subjectSectionId),
      subject: row.subject,
      grade: Number(row.submitted) === 1 && Number(row.isComplete) === 1 && row.average != null && Number.isFinite(Number(row.average))
        ? Number(row.average) : null,
    });
  }

  // Classmates share template and item reads within the same database snapshot.
  const componentReads = new Map();
  const componentDb = {
    execute(sql, params) {
      const key = JSON.stringify([sql, params]);
      if (!componentReads.has(key)) componentReads.set(key, db.execute(sql, params));
      return componentReads.get(key);
    },
  };
  const records = [];
  for (const { row, subjects } of grouped.values()) {
    const termEnded = Number(row.termEnded) === 1;
    const submitted = Number(row.submitted) === 1;
    const eligible = Number(row.eligible) === 1;
    let ready = termEnded && submitted && eligible &&
      subjects.length > 0 && subjects.every(subject => subject.grade !== null);
    const overallAverage = submitted && row.overallAverage != null ? Number(row.overallAverage) : null;
    if (ready && (!forStudent || row.approvedFingerprint)) {
      for (const subject of subjects) {
        if (!/\bMAPEH\b/i.test(subject.subject)) continue;
        try {
          subject.components = await getSubjectComponentGrades(row.studentId, subject.subjectSectionId, periodId, componentDb);
        } catch (error) {
          if (error.statusCode !== 409) throw error;
          ready = false;
          break;
        }
        if (subject.components.some(component => component.grade == null)) ready = false;
      }
    }
    const fingerprint = ready ? createHash('sha256').update(JSON.stringify([
      String(row.gradeLevelId), row.sectionId == null ? null : String(row.sectionId), overallAverage, subjects,
    ])).digest('hex') : null;
    const approved = fingerprint !== null && fingerprint === row.approvedFingerprint;
    records.push({
      studentId: String(row.studentId), name: `${row.lastName}, ${row.firstName}`,
      termLabel: row.termLabel, sectionId: row.sectionId, gradeLevelId: row.gradeLevelId,
      termEnded, submitted, eligible, ready, approved,
      needsReview: Boolean(row.approvedFingerprint) && !approved,
      fingerprint, subjects, overallAverage,
    });
  }
  return records;
}

async function isGradeApproved(db, studentId, periodId, scope) {
  const [record] = await loadApprovalRecords(db, periodId, { studentId });
  return record?.approved === true && (!scope || (
    String(record.sectionId) === String(scope.sectionId) && String(record.gradeLevelId) === String(scope.gradeLevelId)
  ));
}

module.exports = { withGradeSnapshot, loadApprovalRecords, isGradeApproved };

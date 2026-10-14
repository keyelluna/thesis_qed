const connection = require('../../../../../config/db');

/**
 * Access-control middleware: verifies the logged-in parent actually has
 * this student as a linked child (via `parent_student`) before returning
 * any grade data.
 */
async function loadParentStudent(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [parentRows] = await connection.execute(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
      [authId]
    );
    if (parentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Parent record not found." });
    }
    const parentId = parentRows[0].id;

    const { studentId } = req.params;

    const [linkRows] = await connection.execute(
      `SELECT es.id, es.section_id, es.grade_level_id
       FROM elem_students es
       INNER JOIN parent_student ps ON ps.student_id = es.id
       WHERE es.id = ? AND ps.parent_id = ? AND es.is_deleted = 0`,
      [studentId, parentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({ success: false, message: "You don't have access to this student's records." });
    }

    req.parentId = parentId;
    req.studentSectionId = linkRows[0].section_id;
    req.studentGradeLevelId = linkRows[0].grade_level_id;
    next();
  } catch (error) {
    console.error("Error verifying parent-student access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/**
 * Returns per-term, per-subject grade history for one student, shaped to
 * match the parent-side `Term[]` type:
 *   { key, label, released, releaseDate?, average?, subjects: SubjectGrade[] }
 *
 * Parents receive grades only after advisory submission, the term end date,
 * and the adviser's visibility release for this student and grading period.
 */
async function getStudentTermPerformance(req, res) {
  try {
    const { studentId } = req.params;
    const sectionId = req.studentSectionId;
    const gradeLevelId = req.studentGradeLevelId;

    const [periods] = await connection.execute(
      `SELECT gp.id, gp.term_number AS termNumber, gp.term_label AS termLabel,
              gp.school_year_id AS schoolYearId,
              COALESCE(gv.is_visible, 0) AS isVisible,
              (CURDATE() >= gp.end_date) AS termEnded
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       LEFT JOIN grade_visibility gv ON gv.grading_period_id = gp.id AND gv.student_id = ?
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`,
      [studentId]
    );

    if (periods.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [subjectSections] = await connection.execute(
      `SELECT ss.id AS subjectSectionId, es.subject_name AS subjectName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       WHERE ${sectionId !== null
         ? '(ss.section_id = ? OR (ss.section_id IS NULL AND es.grade_level_id = ?))'
         : 'ss.section_id IS NULL AND es.grade_level_id = ?'}
         AND ss.status = 'Active' AND ss.school_year_id = ?
       ORDER BY es.subject_name ASC`,
      sectionId !== null ? [sectionId, gradeLevelId, periods[0].schoolYearId] : [gradeLevelId, periods[0].schoolYearId]
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const subjectSectionIds = subjectSections.map((s) => s.subjectSectionId);
    const ssPlaceholders = subjectSectionIds.map(() => "?").join(",");
    const periodIds = periods.map((p) => p.id);
    const periodPlaceholders = periodIds.map(() => "?").join(",");

    // Use the authoritative, template-aware cache. Recomputing from fixed
    // ST1/ST2/TE items here would disagree with no-exam and variable-exam
    // templates, and could publish a partial grade.
    const [cacheRows] = await connection.execute(
      `SELECT subject_section_id AS subjectSectionId,
              grading_period_id AS gradingPeriodId,
              average,
              is_complete AS isComplete
       FROM subject_grade_cache
       WHERE student_id = ?
         AND subject_section_id IN (${ssPlaceholders})
         AND grading_period_id IN (${periodPlaceholders})`,
      [studentId, ...subjectSectionIds, ...periodIds]
    );
    const gradeBySubjectAndPeriod = new Map(
      cacheRows.map((row) => [
        `${row.subjectSectionId}_${row.gradingPeriodId}`,
        row.isComplete && row.average !== null ? Number(row.average) : null,
      ])
    );

    // Which (section, term) pairs has the advisory teacher submitted?
    const [submissions] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId
       FROM grade_submissions
       WHERE ${sectionId !== null ? 'section_id = ?' : 'section_id IS NULL AND grade_level_id = ?'}
         AND grading_period_id IN (${periodPlaceholders})`,
      [sectionId ?? gradeLevelId, ...periodIds]
    );
    const submittedPeriodIds = new Set(submissions.map((s) => s.gradingPeriodId));

    const terms = periods.map((period) => {
      const isSubmitted = submittedPeriodIds.has(period.id) &&
        Number(period.isVisible) === 1 && Number(period.termEnded) === 1;

      const subjects = subjectSections.map((ss) => ({
        subject: ss.subjectName,
        grade: gradeBySubjectAndPeriod.get(`${ss.subjectSectionId}_${period.id}`) ?? null,
      }));

      const validAverages = subjects.map((s) => s.grade).filter((grade) => grade !== null);
      const overallAverage =
        validAverages.length > 0
          ? Math.round((validAverages.reduce((a, b) => a + b, 0) / validAverages.length) * 100) / 100
          : null;

      return {
        key: String(period.id),
        label: period.termLabel,
        released: isSubmitted && overallAverage !== null,
        average: isSubmitted ? overallAverage ?? undefined : undefined,
        subjects: isSubmitted ? subjects : [],
      };
    });

    return res.status(200).json({ success: true, data: terms });
  } catch (error) {
    console.error("Error fetching student term performance:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

module.exports = {
  loadParentStudent,
  getStudentTermPerformance,
};

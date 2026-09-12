const connection = require('../../../../../config/db');

const TERM_LABEL_FALLBACK = (termNumber) => `Term ${termNumber}`;

/**
 * Confirms the requesting user may view this student's term performance,
 * then attaches { id, sectionId } to req.student for the handler.
 *
 * Access rules:
 *  - admin / principal: any student
 *  - teacher: only students in a section they advise, or in a section
 *    they hold a subject in
 *  - parent: only their own linked children (parent_student)
 */
async function verifyStudentAccess(req, res, next) {
  try {
    const authId = req.user?.userId;
    const role = req.user?.role;
    if (!authId || !role) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { studentId } = req.params;

    const [studentRows] = await connection.execute(
      `SELECT id, section_id AS sectionId
       FROM elem_students
       WHERE id = ? AND is_deleted = 0`,
      [studentId]
    );
    if (studentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }
    const student = studentRows[0];

    if (role === "admin" || role === "principal") {
      req.student = student;
      return next();
    }

    if (role === "teacher") {
      const [teacherRows] = await connection.execute(
        `SELECT id FROM teacher_table WHERE user_id = ?`,
        [authId]
      );
      if (teacherRows.length === 0) {
        return res.status(404).json({ success: false, message: "Teacher record not found." });
      }
      const teacherId = teacherRows[0].id;

      if (student.sectionId !== null) {
        const [access] = await connection.execute(
          `SELECT 1 FROM classes WHERE section_id = ? AND class_adviser_id = ?
           UNION
           SELECT 1 FROM \`subject-section\` WHERE section_id = ? AND teacher_id = ? AND status = 'Active'
           LIMIT 1`,
          [student.sectionId, teacherId, student.sectionId, teacherId]
        );
        if (access.length > 0) {
          req.student = student;
          return next();
        }
      }
      return res.status(403).json({ success: false, message: "You don't have access to this student." });
    }

    if (role === "parent") {
      const [parentRows] = await connection.execute(
        `SELECT id FROM parent_table WHERE user_id = ?`,
        [authId]
      );
      if (parentRows.length === 0) {
        return res.status(404).json({ success: false, message: "Parent record not found." });
      }
      const parentId = parentRows[0].id;

      const [link] = await connection.execute(
        `SELECT 1 FROM parent_student WHERE parent_id = ? AND student_id = ? LIMIT 1`,
        [parentId, studentId]
      );
      if (link.length === 0) {
        return res.status(403).json({ success: false, message: "You don't have access to this student." });
      }

      req.student = student;
      return next();
    }

    return res.status(403).json({ success: false, message: "Role not permitted." });
  } catch (error) {
    console.error("Error verifying student access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/**
 * Fetches learner meta info (name, grade & section, class adviser,
 * school year) for the progress report header.
 *
 * - Grade & section come straight off elem_students (grade_level_id /
 *   section_id), joined to their label tables.
 * - Class adviser is resolved via classes.section_id -> class_adviser_id
 *   -> teacher_table, since that's the same place the adviser is set for
 *   the section (not grade_level_sections.adviser_id, which isn't kept
 *   in sync).
 * - School year is whichever row in school_year has is_active = 1.
 * - Any piece can come back null (e.g. student has no section yet, or
 *   the section has no adviser assigned) -- callers should treat missing
 *   pieces as "not set yet" rather than an error.
 */
async function getStudentMeta(studentId) {
  const [rows] = await connection.execute(
    `SELECT
       es.first_name AS firstName,
       es.last_name AS lastName,
       es.middle_name AS middleName,
       gl.grade_level AS gradeLevel,
       gls.section_name AS sectionName,
       sy.school_year AS schoolYear,
       t.first_name AS adviserFirstName,
       t.last_name AS adviserLastName
     FROM elem_students es
     LEFT JOIN grade_level gl ON es.grade_level_id = gl.id
     LEFT JOIN grade_level_sections gls ON es.section_id = gls.id
     LEFT JOIN classes c ON c.section_id = es.section_id
     LEFT JOIN teacher_table t ON c.class_adviser_id = t.id
     LEFT JOIN school_year sy ON sy.is_active = 1
     WHERE es.id = ?
     LIMIT 1`,
    [studentId]
  );

  const m = rows[0] || {};

  return {
    learner: [m.firstName, m.middleName, m.lastName].filter(Boolean).join(" "),
    gradeSection: [m.gradeLevel, m.sectionName].filter(Boolean).join(" - "),
    classAdviser: [m.adviserFirstName, m.adviserLastName].filter(Boolean).join(" "),
    schoolYear: m.schoolYear || "",
  };
}

/**
 * GET /api/termPerformanceProgress/:studentId/term-performance
 *
 * One entry per grading period of the active school year. A term is only
 * "released" once the adviser submitted grades for the student's section
 * for that period (grade_submissions) — unreleased terms come back with
 * an empty subject list and no average, so the frontend can show a
 * "not yet released" state instead of leaking unfinished grades.
 *
 * Subject grades = subject_grade_cache (kept accurate by
 * gradeCache.service.js on every score write). Overall/GWA per term =
 * advisory_overall_grades. Both are the same source the teacher's grade
 * sheet reads, so results match exactly.
 *
 * Response shape: { success, meta, data }. `meta` carries the learner's
 * name/grade-section/adviser/school-year for the report header and is
 * always populated regardless of which early-return path `data` takes.
 */
const getTermPerformance = async (req, res) => {
  try {
    const { id: studentId, sectionId } = req.student;

    const meta = await getStudentMeta(studentId);

    const [gradingPeriods] = await connection.execute(
      `SELECT gp.id, gp.term_number AS termNumber, gp.term_label AS termLabel
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`
    );

    const shell = (released) =>
      gradingPeriods.map((gp) => ({
        key: `term_${gp.id}`,
        label: gp.termLabel || TERM_LABEL_FALLBACK(gp.termNumber),
        termNumber: gp.termNumber,
        released: typeof released === "function" ? released(gp.id) : released,
        subjects: [],
      }));

    if (gradingPeriods.length === 0 || sectionId === null) {
      return res.status(200).json({ success: true, meta, data: shell(false) });
    }

    const periodIds = gradingPeriods.map((gp) => gp.id);
    const periodPlaceholders = periodIds.map(() => "?").join(",");

    const [submissionRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId
       FROM grade_submissions
       WHERE section_id = ? AND grading_period_id IN (${periodPlaceholders})`,
      [sectionId, ...periodIds]
    );
    const releasedPeriodIds = new Set(submissionRows.map((r) => r.gradingPeriodId));

    const [subjectSections] = await connection.execute(
      `SELECT ss.id, es.subject_name AS subjectName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       WHERE ss.section_id = ? AND ss.status = 'Active'`,
      [sectionId]
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({
        success: true,
        meta,
        data: shell((id) => releasedPeriodIds.has(id)),
      });
    }

    const subjectSectionIds = subjectSections.map((s) => s.id);
    const ssPlaceholders = subjectSectionIds.map(() => "?").join(",");

    const [cacheRows] = await connection.execute(
      `SELECT subject_section_id AS subjectSectionId, grading_period_id AS gradingPeriodId, average
       FROM subject_grade_cache
       WHERE student_id = ?
         AND subject_section_id IN (${ssPlaceholders})
         AND grading_period_id IN (${periodPlaceholders})
         AND average IS NOT NULL
         AND is_complete = 1`,
      [studentId, ...subjectSectionIds, ...periodIds]
    );

    const [overallRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId, overall_average AS overallAverage
       FROM advisory_overall_grades
       WHERE student_id = ? AND grading_period_id IN (${periodPlaceholders})`,
      [studentId, ...periodIds]
    );
    const overallByPeriodId = new Map(
      overallRows
        .filter((r) => r.overallAverage !== null)
        .map((r) => [r.gradingPeriodId, Number(r.overallAverage)])
    );

    const gradeBySubjectAndPeriod = new Map();
    for (const row of cacheRows) {
      gradeBySubjectAndPeriod.set(
        `${row.subjectSectionId}_${row.gradingPeriodId}`,
        Number(row.average)
      );
    }

    const subjectsByPeriodId = new Map();
    for (const gp of gradingPeriods) {
      const list = subjectSections.map((ss) => ({
        subject: ss.subjectName,
        grade: gradeBySubjectAndPeriod.get(`${ss.id}_${gp.id}`) ?? null,
      }));
      subjectsByPeriodId.set(gp.id, list);
    }

    const data = gradingPeriods.map((gp) => {
      const released = releasedPeriodIds.has(gp.id);
      return {
        key: `term_${gp.id}`,
        label: gp.termLabel || TERM_LABEL_FALLBACK(gp.termNumber),
        termNumber: gp.termNumber,
        released,
        average: released ? overallByPeriodId.get(gp.id) ?? undefined : undefined,
        subjects: released ? (subjectsByPeriodId.get(gp.id) || []) : [],
      };
    });

    return res.status(200).json({ success: true, meta, data });
  } catch (error) {
    console.error("Error fetching term performance progress:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  verifyStudentAccess,
  getTermPerformance,
};
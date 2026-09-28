const connection = require('../../../../../config/db');

const TERM_LABEL_FALLBACK = (termNumber) => `Term ${termNumber}`;

async function getActiveSchoolYearId() {
  const [rows] = await connection.execute(
    `SELECT id FROM school_year WHERE is_active = 1 ORDER BY id DESC LIMIT 1`
  );
  return rows.length ? rows[0].id : null;
}

async function verifyStudentAccess(req, res, next) {
  try {
    const authId = req.user?.userId;
    const role = req.user?.role;
    if (!authId || !role) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { studentId } = req.params;
    const activeSchoolYearId = await getActiveSchoolYearId();

    const [studentRows] = await connection.execute(
      `SELECT id, section_id AS sectionId, current_school_year_id AS schoolYearId, status
       FROM elem_students
       WHERE id = ? AND is_deleted = 0`,
      [studentId]
    );
    if (studentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }
    const student = studentRows[0];

    const attach = () => {
      req.student = student;
      req.activeSchoolYearId = activeSchoolYearId;
    };

    if (role === "admin" || role === "principal") {
      attach();
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
          `SELECT 1 FROM classes
             WHERE section_id = ? AND class_adviser_id = ? AND school_year_id = ?
           UNION
           SELECT 1 FROM \`subject-section\`
             WHERE section_id = ? AND teacher_id = ? AND status = 'Active' AND school_year_id = ?
           LIMIT 1`,
          [
            student.sectionId, teacherId, activeSchoolYearId,
            student.sectionId, teacherId, activeSchoolYearId,
          ]
        );
        if (access.length > 0) {
          attach();
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

      attach();
      return next();
    }

    return res.status(403).json({ success: false, message: "Role not permitted." });
  } catch (error) {
    console.error("Error verifying student access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

async function getStudentMeta(studentId, schoolYearId) {
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
     LEFT JOIN classes c
            ON c.section_id = es.section_id AND c.school_year_id = ?
     LEFT JOIN teacher_table t ON c.class_adviser_id = t.id
     LEFT JOIN school_year sy ON sy.id = ?
     WHERE es.id = ?
     LIMIT 1`,
    [schoolYearId, schoolYearId, studentId]
  );

  const m = rows[0] || {};

  return {
    learner: [m.firstName, m.middleName, m.lastName].filter(Boolean).join(" "),
    gradeSection: [m.gradeLevel, m.sectionName].filter(Boolean).join(" - "),
    classAdviser: [m.adviserFirstName, m.adviserLastName].filter(Boolean).join(" "),
    schoolYear: m.schoolYear || "",
  };
}

const getTermPerformance = async (req, res) => {
  try {
    const { id: studentId, sectionId, schoolYearId: studentSchoolYearId } = req.student;
    const activeSchoolYearId = req.activeSchoolYearId;

    const meta = await getStudentMeta(studentId, activeSchoolYearId);

    const [gradingPeriods] = await connection.execute(
      `SELECT id, term_number AS termNumber, term_label AS termLabel
       FROM grading_periods
       WHERE school_year_id = ?
       ORDER BY term_number ASC`,
      [activeSchoolYearId]
    );

    const shell = (released) =>
      gradingPeriods.map((gp) => ({
        key: `term_${gp.id}`,
        label: gp.termLabel || TERM_LABEL_FALLBACK(gp.termNumber),
        termNumber: gp.termNumber,
        released: typeof released === "function" ? released(gp.id) : released,
        subjects: [],
      }));

    const notInActiveYear =
      !activeSchoolYearId ||
      studentSchoolYearId !== activeSchoolYearId;

    if (gradingPeriods.length === 0 || sectionId === null || notInActiveYear) {
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
       WHERE ss.section_id = ? AND ss.status = 'Active' AND ss.school_year_id = ?`,
      [sectionId, activeSchoolYearId]
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
      subjectsByPeriodId.set(
        gp.id,
        subjectSections.map((ss) => ({
          subject: ss.subjectName,
          grade: gradeBySubjectAndPeriod.get(`${ss.id}_${gp.id}`) ?? null,
        }))
      );
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
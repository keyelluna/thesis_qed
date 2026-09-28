const connection = require("../../../../config/db");

const getActiveSchoolYearId = async () => {
  const [[row]] = await connection.query(
    `SELECT id FROM school_year WHERE is_active = 1 ORDER BY id DESC LIMIT 1`,
  );
  return row ? row.id : null;
};

const getActiveGradingPeriodId = async () => {
  const [[row]] = await connection.query(
    `SELECT gp.id
     FROM grading_periods gp
     JOIN school_year sy ON sy.id = gp.school_year_id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     ORDER BY gp.term_number
     LIMIT 1`,
  );
  return row ? row.id : null;
};

const getGradingPeriods = async (req, res) => {
  try {
    const { gradeLevelId, sectionId } = req.query;

    const [periods] = await connection.query(
      `SELECT gp.id, gp.term_number, gp.term_label, gp.is_active
       FROM grading_periods gp
       JOIN school_year sy ON sy.id = gp.school_year_id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number`,
    );
    const periodIds = periods.map((p) => p.id);

    let submittedRows = [];
    if (periodIds.length > 0) {
      if (sectionId) {
        [submittedRows] = await connection.query(
          `SELECT DISTINCT grading_period_id
           FROM grade_submissions
           WHERE section_id = ? AND grading_period_id IN (?)`,
          [sectionId, periodIds],
        );
      } else if (gradeLevelId) {
        [submittedRows] = await connection.query(
          `SELECT DISTINCT grading_period_id
           FROM grade_submissions
           WHERE grade_level_id = ? AND section_id IS NULL
             AND grading_period_id IN (?)`,
          [gradeLevelId, periodIds],
        );
      }
    }
    const submittedIds = new Set(submittedRows.map((r) => r.grading_period_id));

    const periodsWithStatus = periods.map((p) => ({
      ...p,
      is_submitted: submittedIds.has(p.id),
    }));

    let defaultGradingPeriodId = null;

    if (periodIds.length > 0 && sectionId) {
      const [[latest]] = await connection.query(
        `SELECT grading_period_id
         FROM grade_submissions
         WHERE section_id = ? AND grading_period_id IN (?)
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [sectionId, periodIds],
      );
      if (latest) defaultGradingPeriodId = latest.grading_period_id;
    } else if (periodIds.length > 0 && gradeLevelId) {
      const [[latest]] = await connection.query(
        `SELECT grading_period_id
         FROM grade_submissions
         WHERE grade_level_id = ? AND section_id IS NULL
           AND grading_period_id IN (?)
         ORDER BY submitted_at DESC
         LIMIT 1`,
        [gradeLevelId, periodIds],
      );
      if (latest) defaultGradingPeriodId = latest.grading_period_id;
    }

    if (!defaultGradingPeriodId) {
      const activePeriod = periods.find((p) => p.is_active);
      defaultGradingPeriodId = activePeriod
        ? activePeriod.id
        : (periods[0]?.id ?? null);
    }

    return res.status(200).json({
      success: true,
      data: periodsWithStatus,
      defaultGradingPeriodId,
    });
  } catch (error) {
    console.error("Error fetching grading periods:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch grading periods." });
  }
};

const getSectionsForGrade = async (gradeLevelId, schoolYearId) => {
  const [sections] = await connection.query(
    `SELECT
        gls.id AS section_id,
        gls.section_name,
        (SELECT COUNT(*) FROM elem_students es
          WHERE es.section_id = gls.id
            AND es.is_deleted = 0
            AND es.status <> 'graduated'
            AND es.current_school_year_id = ?) AS student_count,
        latest_gs.id IS NOT NULL AS is_submitted,
        latest_gs.grading_period_id AS grading_period_id,
        CONCAT(t.first_name, ' ', t.last_name) AS adviser_name
     FROM grade_level_sections gls
     LEFT JOIN (
        SELECT gs1.*
        FROM grade_submissions gs1
        INNER JOIN grading_periods gp1
          ON gp1.id = gs1.grading_period_id AND gp1.school_year_id = ?
        INNER JOIN (
          SELECT gs2.section_id, MAX(gs2.submitted_at) AS max_submitted_at
          FROM grade_submissions gs2
          INNER JOIN grading_periods gp2
            ON gp2.id = gs2.grading_period_id AND gp2.school_year_id = ?
          GROUP BY gs2.section_id
        ) latest
          ON latest.section_id = gs1.section_id
         AND latest.max_submitted_at = gs1.submitted_at
     ) latest_gs ON latest_gs.section_id = gls.id
     LEFT JOIN classes c
       ON c.section_id = gls.id
      AND c.school_year_id = ?
      AND c.status = 'Active'
     LEFT JOIN teacher_table t
       ON t.id = c.class_adviser_id AND t.is_deleted = 0
     WHERE gls.grade_level_id = ?
       AND gls.school_year_id = ?
     ORDER BY gls.section_name`,
    [
      schoolYearId,
      schoolYearId,
      schoolYearId,
      schoolYearId,
      gradeLevelId,
      schoolYearId,
    ],
  );
  return sections;
};

const mapSection = (s) => ({
  sectionId: s.section_id,
  section: s.section_name,
  studentCount: s.student_count,
  adviserName: s.adviser_name ?? null,
  isSubmitted: Boolean(s.is_submitted),
  gradingPeriodId: s.grading_period_id ?? null,
});

const getGradeLevelAdviser = async (gradeLevelId, schoolYearId) => {
  const [[row]] = await connection.query(
    `SELECT CONCAT(t.first_name, ' ', t.last_name) AS adviser_name
     FROM classes c
     JOIN teacher_table t ON t.id = c.class_adviser_id AND t.is_deleted = 0
     WHERE c.grade_level_id = ?
       AND c.section_id IS NULL
       AND c.school_year_id = ?
       AND c.status = 'Active'
     LIMIT 1`,
    [gradeLevelId, schoolYearId],
  );
  return row ? row.adviser_name : null;
};

const getGradeLevelStudentCount = async (gradeLevelId, schoolYearId) => {
  const [[countRow]] = await connection.query(
    `SELECT COUNT(*) AS student_count
     FROM elem_students
     WHERE grade_level_id = ?
       AND section_id IS NULL
       AND is_deleted = 0
       AND status <> 'graduated'
       AND current_school_year_id = ?`,
    [gradeLevelId, schoolYearId],
  );
  return countRow.student_count;
};

const getGradeLevelSubmission = async (gradeLevelId, schoolYearId) => {
  const [[row]] = await connection.query(
    `SELECT gs.grading_period_id
     FROM grade_submissions gs
     JOIN grading_periods gp
       ON gp.id = gs.grading_period_id AND gp.school_year_id = ?
     WHERE gs.grade_level_id = ? AND gs.section_id IS NULL
     ORDER BY gs.submitted_at DESC
     LIMIT 1`,
    [schoolYearId, gradeLevelId],
  );
  return row ? row.grading_period_id : null;
};

const getSectionGrade = async (req, res) => {
  try {
    const { sectionId, gradeLevelId } = req.query;

    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(404).json({ message: "No active school year." });
    }

    const gradingPeriodId = req.query.gradingPeriodId
      ? Number(req.query.gradingPeriodId)
      : await getActiveGradingPeriodId();

    if (sectionId) {
      const [rows] = await connection.query(
        `SELECT
            gls.id AS section_id,
            gls.section_name,
            gl.id AS grade_level_id,
            gl.grade_level,
            (SELECT COUNT(*) FROM elem_students es
              WHERE es.section_id = gls.id
                AND es.is_deleted = 0
                AND es.status <> 'graduated'
                AND es.current_school_year_id = ?) AS student_count,
            CONCAT(t.first_name, ' ', t.last_name) AS adviser_name
         FROM grade_level_sections gls
         JOIN grade_level gl ON gl.id = gls.grade_level_id
         LEFT JOIN classes c
           ON c.section_id = gls.id
          AND c.school_year_id = ?
          AND c.status = 'Active'
         LEFT JOIN teacher_table t ON t.id = c.class_adviser_id AND t.is_deleted = 0
         WHERE gls.id = ? AND gls.school_year_id = ?`,
        [schoolYearId, schoolYearId, sectionId, schoolYearId],
      );

      if (rows.length === 0) {
        return res.status(404).json({ message: "Section not found." });
      }

      const row = rows[0];
      return res.json({
        gradeLevelId: row.grade_level_id,
        gradeLevel: row.grade_level,
        sectionId: row.section_id,
        section: row.section_name,
        studentCount: row.student_count,
        adviserName: row.adviser_name ?? null,
      });
    }

    if (gradeLevelId) {
      const [[gradeRow]] = await connection.query(
        `SELECT id, grade_level FROM grade_level WHERE id = ?`,
        [gradeLevelId],
      );

      if (!gradeRow) {
        return res.status(404).json({ message: "Grade level not found." });
      }

      const sections = await getSectionsForGrade(gradeLevelId, schoolYearId);

      if (sections.length > 0) {
        return res.json({
          gradeLevelId: gradeRow.id,
          gradeLevel: gradeRow.grade_level,
          sections: sections.map((s) => ({
            sectionId: s.section_id,
            section: s.section_name,
            studentCount: s.student_count,
            adviserName: s.adviser_name ?? null,
          })),
        });
      }

      const studentCount = await getGradeLevelStudentCount(
        gradeLevelId,
        schoolYearId,
      );

      return res.json({
        gradeLevelId: gradeRow.id,
        gradeLevel: gradeRow.grade_level,
        section: null,
        studentCount,
      });
    }

    const [gradeLevels] = await connection.query(
      `SELECT id, grade_level FROM grade_level ORDER BY id`,
    );

    const report = [];

    for (const grade of gradeLevels) {
      const sections = await getSectionsForGrade(grade.id, schoolYearId);

      if (sections.length > 0) {
        report.push({
          gradeLevelId: grade.id,
          gradeLevel: grade.grade_level,
          sections: sections.map((s) => mapSection(s)),
        });
      } else {
        const latestPeriodId = await getGradeLevelSubmission(
          grade.id,
          schoolYearId,
        );
        report.push({
          gradeLevelId: grade.id,
          gradeLevel: grade.grade_level,
          section: null,
          studentCount: await getGradeLevelStudentCount(grade.id, schoolYearId),
          adviserName: await getGradeLevelAdviser(grade.id, schoolYearId),
          isSubmitted: latestPeriodId !== null,
          gradingPeriodId: latestPeriodId ?? gradingPeriodId,
        });
      }
    }

    return res.json(report);
  } catch (error) {
    console.error("Error fetching enrollment report:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch enrollment report." });
  }
};

const getPrincipalSectionGradebook = async (req, res) => {
  try {
    const { sectionId, gradeLevelId, gradingPeriodId } = req.query;

    if (!gradeLevelId) {
      return res
        .status(400)
        .json({ success: false, message: "gradeLevelId is required." });
    }
    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res
        .status(404)
        .json({ success: false, message: "No active school year." });
    }

    // Dapat nasa active school year ang grading period
    const [periodRows] = await connection.execute(
      `SELECT id FROM grading_periods WHERE id = ? AND school_year_id = ?`,
      [gradingPeriodId, schoolYearId],
    );
    if (periodRows.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Grading period is not part of the active school year.",
      });
    }

    const [gradeLevelRows] = await connection.execute(
      `SELECT grade_level FROM grade_level WHERE id = ?`,
      [gradeLevelId],
    );
    const gradeLevel = gradeLevelRows[0]?.grade_level || null;

    let sectionName = null;
    if (sectionId) {
      const [sectionRows] = await connection.execute(
        `SELECT section_name FROM grade_level_sections
         WHERE id = ? AND school_year_id = ?`,
        [sectionId, schoolYearId],
      );
      sectionName = sectionRows[0]?.section_name || null;
    }

    const [subjectSections] = await connection.execute(
      sectionId
        ? `SELECT ss.id AS subjectSectionId, ss.subject_id AS subjectId, ss.teacher_id AS teacherId,
                  es.subject_name AS subjectName,
                  CONCAT(t.first_name, ' ', t.last_name) AS teacherName
           FROM \`subject-section\` ss
           INNER JOIN elem_subjects es ON ss.subject_id = es.id
           INNER JOIN teacher_table t ON ss.teacher_id = t.id
           WHERE ss.status = 'Active'
             AND ss.school_year_id = ?
             AND (
               ss.section_id = ?
               OR (ss.section_id IS NULL AND es.grade_level_id = ?)
             )
           ORDER BY es.subject_name ASC`
        : `SELECT ss.id AS subjectSectionId, ss.subject_id AS subjectId, ss.teacher_id AS teacherId,
                  es.subject_name AS subjectName,
                  CONCAT(t.first_name, ' ', t.last_name) AS teacherName
           FROM \`subject-section\` ss
           INNER JOIN elem_subjects es ON ss.subject_id = es.id
           INNER JOIN teacher_table t ON ss.teacher_id = t.id
           WHERE ss.status = 'Active'
             AND ss.school_year_id = ?
             AND ss.section_id IS NULL
             AND es.grade_level_id = ?
           ORDER BY es.subject_name ASC`,
      sectionId
        ? [schoolYearId, sectionId, gradeLevelId]
        : [schoolYearId, gradeLevelId],
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({
        success: true,
        data: { sectionName, gradeLevel, subjects: [], students: [] },
      });
    }

    const subjectSectionIds = subjectSections.map((s) => s.subjectSectionId);
    const ssPlaceholders = subjectSectionIds.map(() => "?").join(",");

    const [students] = await connection.execute(
      sectionId
        ? `SELECT id, gender, first_name AS firstName, middle_name AS middleName, last_name AS lastName
           FROM elem_students
           WHERE section_id = ?
             AND is_deleted = 0
             AND status <> 'graduated'
             AND current_school_year_id = ?
           ORDER BY last_name ASC, first_name ASC`
        : `SELECT id, gender, first_name AS firstName, middle_name AS middleName, last_name AS lastName
           FROM elem_students
           WHERE grade_level_id = ? AND section_id IS NULL
             AND is_deleted = 0
             AND status <> 'graduated'
             AND current_school_year_id = ?
           ORDER BY last_name ASC, first_name ASC`,
      [sectionId || gradeLevelId, schoolYearId],
    );

    // Same cache-first approach gaya ng teacher version — hindi na kailangan i-recompute.
    const [cacheRows] = await connection.execute(
      `SELECT student_id AS studentId, subject_section_id AS subjectSectionId, average, is_complete AS isComplete
       FROM subject_grade_cache
       WHERE subject_section_id IN (${ssPlaceholders}) AND grading_period_id = ?`,
      [...subjectSectionIds, gradingPeriodId],
    );
    const cacheByKey = new Map(
      cacheRows.map((r) => [
        `${r.studentId}:${r.subjectSectionId}`,
        { average: r.average, isComplete: !!r.isComplete },
      ]),
    );

    const [submissionRows] = await connection.execute(
      `SELECT sgs.subject_section_id AS subjectSectionId,
              DATE_FORMAT(sgs.submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt,
              CONCAT(t.first_name, ' ', t.last_name) AS submittedByName
       FROM subject_grade_submissions sgs
       INNER JOIN teacher_table t ON sgs.submitted_by = t.id
       WHERE sgs.subject_section_id IN (${ssPlaceholders}) AND sgs.grading_period_id = ?`,
      [...subjectSectionIds, gradingPeriodId],
    );
    const submissionByKey = new Map(
      submissionRows.map((r) => [
        r.subjectSectionId,
        { submittedAt: r.submittedAt, submittedByName: r.submittedByName },
      ]),
    );

    let adviserTeacherId = null;
    let adviserSubmitted = false;

    const [classRows] = await connection.execute(
      sectionId
        ? `SELECT class_adviser_id FROM classes
           WHERE section_id = ? AND school_year_id = ? AND status = 'Active' LIMIT 1`
        : `SELECT class_adviser_id FROM classes
           WHERE grade_level_id = ? AND section_id IS NULL
             AND school_year_id = ? AND status = 'Active' LIMIT 1`,
      [sectionId || gradeLevelId, schoolYearId],
    );
    adviserTeacherId = classRows[0]?.class_adviser_id ?? null;

    if (sectionId) {
      const [gsRows] = await connection.execute(
        `SELECT 1 FROM grade_submissions
         WHERE section_id = ? AND grading_period_id = ? LIMIT 1`,
        [sectionId, gradingPeriodId],
      );
      adviserSubmitted = gsRows.length > 0;
    } else {
      const [gsRows] = await connection.execute(
        `SELECT 1 FROM grade_submissions
         WHERE grade_level_id = ? AND section_id IS NULL AND grading_period_id = ? LIMIT 1`,
        [gradeLevelId, gradingPeriodId],
      );
      adviserSubmitted = gsRows.length > 0;
    }

    const subjectSubmitted = new Map();
    for (const ss of subjectSections) {
      const isOwnAdvisory =
        adviserTeacherId !== null && ss.teacherId === adviserTeacherId;
      subjectSubmitted.set(
        ss.subjectSectionId,
        isOwnAdvisory
          ? adviserSubmitted
          : submissionByKey.has(ss.subjectSectionId),
      );
    }
    const allSubjectsSubmitted = subjectSections.every((ss) =>
      subjectSubmitted.get(ss.subjectSectionId),
    );

    const overallByStudent = new Map();
    if (allSubjectsSubmitted) {
      const [overallRows] = sectionId
        ? await connection.execute(
            `SELECT student_id AS studentId, overall_average AS overallAverage
             FROM advisory_overall_grades
             WHERE section_id = ? AND grading_period_id = ?`,
            [sectionId, gradingPeriodId],
          )
        : await connection.execute(
            `SELECT student_id AS studentId, overall_average AS overallAverage
             FROM advisory_overall_grades
             WHERE grade_level_id = ? AND section_id IS NULL AND grading_period_id = ?`,
            [gradeLevelId, gradingPeriodId],
          );
      overallRows.forEach((r) =>
        overallByStudent.set(r.studentId, r.overallAverage),
      );
    }

    const studentsOut = students.map((student) => {
      const grades = {};
      for (const ss of subjectSections) {
        const cell = cacheByKey.get(`${student.id}:${ss.subjectSectionId}`) || {
          average: null,
          isComplete: false,
        };
        const isOwnAdvisory =
          adviserTeacherId !== null && ss.teacherId === adviserTeacherId;
        const submission = isOwnAdvisory
          ? null
          : submissionByKey.get(ss.subjectSectionId) || null;

        let status;
        if (subjectSubmitted.get(ss.subjectSectionId)) {
          status = "submitted";
        } else if (cell.isComplete) {
          status = "pending";
        } else {
          status = "not_submitted";
        }

        grades[String(ss.subjectSectionId)] = {
          status,
          termGrade:
            status === "submitted" && cell.average !== null
              ? Number(cell.average)
              : null,
          average:
            status === "submitted" && cell.average !== null
              ? Number(cell.average)
              : null,
          submittedByName: submission ? submission.submittedByName : null,
          submittedAt: submission ? submission.submittedAt : null,
        };
      }

      const overall = overallByStudent.get(student.id);
      return {
        studentId: String(student.id),
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName,
        gender: student.gender === "Female" ? "F" : "M",
        grades,
        overallAverage:
          allSubjectsSubmitted && overall !== undefined && overall !== null
            ? Number(overall)
            : null,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        sectionName,
        gradeLevel,
        subjects: subjectSections.map((s) => {
          const isOwnAdvisory =
            adviserTeacherId !== null && s.teacherId === adviserTeacherId;
          const submission = isOwnAdvisory
            ? null
            : submissionByKey.get(s.subjectSectionId) || null;
          return {
            subjectSectionId: String(s.subjectSectionId),
            subjectId: s.subjectId,
            subjectName: s.subjectName,
            teacherName: s.teacherName,
            submitted: subjectSubmitted.get(s.subjectSectionId),
            submittedByName: submission ? submission.submittedByName : null,
            submittedAt: submission ? submission.submittedAt : null,
          };
        }),
        students: studentsOut,
      },
    });
  } catch (error) {
    console.error("Error building principal section gradebook:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  getSectionGrade,
  getPrincipalSectionGradebook,
  getGradingPeriods,
};
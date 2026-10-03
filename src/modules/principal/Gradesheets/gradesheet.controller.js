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
        gls.grade_level_id,
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
     WHERE (? IS NULL OR gls.grade_level_id = ?)
       AND gls.school_year_id = ?
     ORDER BY gls.section_name`,
    [
      schoolYearId,
      schoolYearId,
      schoolYearId,
      schoolYearId,
      gradeLevelId,
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

    // Fetch section summaries once for the school year, preserving each grade's section order.
    const allSections = await getSectionsForGrade(null, schoolYearId);
    const sectionsByGrade = new Map();
    for (const section of allSections) {
      if (!sectionsByGrade.has(section.grade_level_id)) sectionsByGrade.set(section.grade_level_id, []);
      sectionsByGrade.get(section.grade_level_id).push(section);
    }
    const report = await Promise.all(gradeLevels.map(async (grade) => {
      const sections = sectionsByGrade.get(grade.id) || [];
      if (sections.length > 0) {
        return {
          gradeLevelId: grade.id,
          gradeLevel: grade.grade_level,
          sections: sections.map(mapSection),
        };
      }
      // These lookups are independent; retain their exact filters and LIMIT behavior.
      const [latestPeriodId, studentCount, adviserName] = await Promise.all([
        getGradeLevelSubmission(grade.id, schoolYearId),
        getGradeLevelStudentCount(grade.id, schoolYearId),
        getGradeLevelAdviser(grade.id, schoolYearId),
      ]);
      return {
        gradeLevelId: grade.id,
        gradeLevel: grade.grade_level,
        section: null,
        studentCount,
        adviserName,
        isSubmitted: latestPeriodId !== null,
        gradingPeriodId: latestPeriodId ?? gradingPeriodId,
      };
    }));

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
    const sectionId = req.query.sectionId
      ? Number(req.query.sectionId)
      : null;

    const gradeLevelId = Number(req.query.gradeLevelId);
    const gradingPeriodId = Number(req.query.gradingPeriodId);

    if (!gradeLevelId || Number.isNaN(gradeLevelId)) {
      return res.status(400).json({
        success: false,
        message: "gradeLevelId is required.",
      });
    }

    if (!gradingPeriodId || Number.isNaN(gradingPeriodId)) {
      return res.status(400).json({
        success: false,
        message: "gradingPeriodId is required.",
      });
    }

    // ============================================================
    // 1. ACTIVE SCHOOL YEAR
    // ============================================================
    const schoolYearId = await getActiveSchoolYearId();

    if (!schoolYearId) {
      return res.status(404).json({
        success: false,
        message: "No active school year.",
      });
    }

    // ============================================================
    // 2. VALIDATE GRADING PERIOD
    //
    // Important:
    // Hindi puwedeng gumamit ang principal ng grading period
    // na kabilang sa previous / future school year.
    // ============================================================
    const [[period]] = await connection.execute(
      `
      SELECT
        gp.id,
        gp.term_number,
        gp.term_label,
        gp.is_active,
        gp.school_year_id
      FROM grading_periods gp
      WHERE gp.id = ?
        AND gp.school_year_id = ?
      LIMIT 1
      `,
      [gradingPeriodId, schoolYearId]
    );

    if (!period) {
      return res.status(400).json({
        success: false,
        message:
          "The selected grading period is not part of the active school year.",
      });
    }

    // ============================================================
    // 3. VALIDATE CLASS / SECTION
    //
    // Kunin mismo ang active advisory class.
    // Ito rin ang magiging source ng adviserTeacherId.
    // ============================================================
    let classRow;

    if (sectionId) {
      const [[row]] = await connection.execute(
        `
        SELECT
          c.id AS classId,
          c.class_adviser_id AS adviserTeacherId,
          c.grade_level_id AS gradeLevelId,
          c.section_id AS sectionId,
          gl.grade_level AS gradeLevel,
          gls.section_name AS sectionName
        FROM classes c
        INNER JOIN grade_level gl
          ON gl.id = c.grade_level_id
        INNER JOIN grade_level_sections gls
          ON gls.id = c.section_id
         AND gls.school_year_id = ?
        WHERE c.section_id = ?
          AND c.grade_level_id = ?
          AND c.school_year_id = ?
          AND c.status = 'Active'
        LIMIT 1
        `,
        [
          schoolYearId,
          sectionId,
          gradeLevelId,
          schoolYearId,
        ]
      );

      classRow = row;
    } else {
      const [[row]] = await connection.execute(
        `
        SELECT
          c.id AS classId,
          c.class_adviser_id AS adviserTeacherId,
          c.grade_level_id AS gradeLevelId,
          NULL AS sectionId,
          gl.grade_level AS gradeLevel,
          NULL AS sectionName
        FROM classes c
        INNER JOIN grade_level gl
          ON gl.id = c.grade_level_id
        WHERE c.grade_level_id = ?
          AND c.section_id IS NULL
          AND c.school_year_id = ?
          AND c.status = 'Active'
        LIMIT 1
        `,
        [gradeLevelId, schoolYearId]
      );

      classRow = row;
    }

    if (!classRow) {
      return res.status(404).json({
        success: false,
        message:
          "Active advisory class not found for the current school year.",
      });
    }

    const adviserTeacherId = classRow.adviserTeacherId;
    const gradeLevel = classRow.gradeLevel;
    const sectionName = classRow.sectionName;

    // ============================================================
    // 4. CHECK ADVISORY GRADESHEET SUBMISSION
    //
    // Ito ang pinaka-importanteng gate.
    //
    // Kahit kompleto na ang subject_grade_cache,
    // HINDI pa iyon dapat makita ng principal hangga't hindi
    // officially submitted ng class adviser ang advisory gradesheet.
    //
    // grade_submissions = final submission ng advisory class.
    // ============================================================
    let advisorySubmission;

    if (sectionId) {
      const [[row]] = await connection.execute(
        `
        SELECT
          gs.id,
          gs.submitted_by AS submittedBy,
          DATE_FORMAT(
            gs.submitted_at,
            '%Y-%m-%dT%H:%i:%sZ'
          ) AS submittedAt,
          CONCAT(t.first_name, ' ', t.last_name) AS submittedByName
        FROM grade_submissions gs
        INNER JOIN grading_periods gp
          ON gp.id = gs.grading_period_id
         AND gp.school_year_id = ?
        LEFT JOIN teacher_table t
          ON t.id = gs.submitted_by
        WHERE gs.section_id = ?
          AND gs.grading_period_id = ?
        LIMIT 1
        `,
        [
          schoolYearId,
          sectionId,
          gradingPeriodId,
        ]
      );

      advisorySubmission = row;
    } else {
      const [[row]] = await connection.execute(
        `
        SELECT
          gs.id,
          gs.submitted_by AS submittedBy,
          DATE_FORMAT(
            gs.submitted_at,
            '%Y-%m-%dT%H:%i:%sZ'
          ) AS submittedAt,
          CONCAT(t.first_name, ' ', t.last_name) AS submittedByName
        FROM grade_submissions gs
        INNER JOIN grading_periods gp
          ON gp.id = gs.grading_period_id
         AND gp.school_year_id = ?
        LEFT JOIN teacher_table t
          ON t.id = gs.submitted_by
        WHERE gs.grade_level_id = ?
          AND gs.section_id IS NULL
          AND gs.grading_period_id = ?
        LIMIT 1
        `,
        [
          schoolYearId,
          gradeLevelId,
          gradingPeriodId,
        ]
      );

      advisorySubmission = row;
    }

    // ============================================================
    // HINDI PA SUBMITTED
    //
    // Do not expose cached grades to principal yet.
    // ============================================================
    if (!advisorySubmission) {
      return res.status(200).json({
        success: true,
        data: {
          schoolYearId,
          gradingPeriodId,

          gradeLevel,
          gradeLevelId,

          sectionName,
          sectionId,

          advisorySubmitted: false,
          submittedAt: null,
          submittedByName: null,

          subjects: [],
          students: [],
        },
      });
    }

    // ============================================================
    // 5. SUBJECTS FOR THIS CLASS + ACTIVE SCHOOL YEAR
    // ============================================================
    const [subjectSections] = await connection.execute(
      sectionId
        ? `
          SELECT
            ss.id AS subjectSectionId,
            ss.subject_id AS subjectId,
            ss.teacher_id AS teacherId,
            es.subject_name AS subjectName,
            CONCAT(t.first_name, ' ', t.last_name) AS teacherName
          FROM \`subject-section\` ss
          INNER JOIN elem_subjects es
            ON es.id = ss.subject_id
          INNER JOIN teacher_table t
            ON t.id = ss.teacher_id
          WHERE ss.status = 'Active'
            AND ss.school_year_id = ?
            AND (
              ss.section_id = ?
              OR (
                ss.section_id IS NULL
                AND es.grade_level_id = ?
              )
            )
          ORDER BY es.subject_name ASC
          `
        : `
          SELECT
            ss.id AS subjectSectionId,
            ss.subject_id AS subjectId,
            ss.teacher_id AS teacherId,
            es.subject_name AS subjectName,
            CONCAT(t.first_name, ' ', t.last_name) AS teacherName
          FROM \`subject-section\` ss
          INNER JOIN elem_subjects es
            ON es.id = ss.subject_id
          INNER JOIN teacher_table t
            ON t.id = ss.teacher_id
          WHERE ss.status = 'Active'
            AND ss.school_year_id = ?
            AND ss.section_id IS NULL
            AND es.grade_level_id = ?
          ORDER BY es.subject_name ASC
          `,
      sectionId
        ? [schoolYearId, sectionId, gradeLevelId]
        : [schoolYearId, gradeLevelId]
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          schoolYearId,
          gradingPeriodId,

          gradeLevel,
          gradeLevelId,

          sectionName,
          sectionId,

          advisorySubmitted: true,
          submittedAt: advisorySubmission.submittedAt,
          submittedByName:
            advisorySubmission.submittedByName,

          subjects: [],
          students: [],
        },
      });
    }

    const subjectSectionIds = subjectSections.map(
      (s) => s.subjectSectionId
    );

    const subjectPlaceholders = subjectSectionIds
      .map(() => "?")
      .join(",");

    // ============================================================
    // 6. CURRENT STUDENTS ONLY
    //
    // Parehong advisory roster at active school year.
    // ============================================================
    const [students] = await connection.execute(
      sectionId
        ? `
          SELECT
            id,
            gender,
            first_name AS firstName,
            middle_name AS middleName,
            last_name AS lastName
          FROM elem_students
          WHERE section_id = ?
            AND grade_level_id = ?
            AND current_school_year_id = ?
            AND is_deleted = 0
            AND status <> 'graduated'
          ORDER BY last_name ASC, first_name ASC
          `
        : `
          SELECT
            id,
            gender,
            first_name AS firstName,
            middle_name AS middleName,
            last_name AS lastName
          FROM elem_students
          WHERE grade_level_id = ?
            AND section_id IS NULL
            AND current_school_year_id = ?
            AND is_deleted = 0
            AND status <> 'graduated'
          ORDER BY last_name ASC, first_name ASC
          `,
      sectionId
        ? [
            sectionId,
            gradeLevelId,
            schoolYearId,
          ]
        : [
            gradeLevelId,
            schoolYearId,
          ]
    );

    // ============================================================
    // 7. SAME CACHE USED BY TEACHER GRADESHEET
    //
    // Huwag mag-recalculate dito.
    //
    // Kung ano ang average na nasa subject_grade_cache,
    // iyon din ang babasahin ng principal.
    // ============================================================
    const [cacheRows] = await connection.execute(
      `
      SELECT
        student_id AS studentId,
        subject_section_id AS subjectSectionId,
        average,
        is_complete AS isComplete
      FROM subject_grade_cache
      WHERE subject_section_id IN (${subjectPlaceholders})
        AND grading_period_id = ?
      `,
      [...subjectSectionIds, gradingPeriodId]
    );

    const cacheByKey = new Map(
      cacheRows.map((row) => [
        `${row.studentId}:${row.subjectSectionId}`,
        {
          average:
            row.average !== null
              ? Number(row.average)
              : null,
          isComplete: Boolean(row.isComplete),
        },
      ])
    );

    // ============================================================
    // 8. SUBJECT-GRADE SUBMISSIONS
    //
    // Para ma-reproduce natin exactly ang statuses na ginagamit
    // sa teacher advisory gradebook.
    // ============================================================
    const [subjectSubmissionRows] =
      await connection.execute(
        `
        SELECT
          sgs.subject_section_id AS subjectSectionId,
          sgs.submitted_by AS submittedBy,
          DATE_FORMAT(
            sgs.submitted_at,
            '%Y-%m-%dT%H:%i:%sZ'
          ) AS submittedAt,
          CONCAT(t.first_name, ' ', t.last_name)
            AS submittedByName
        FROM subject_grade_submissions sgs
        INNER JOIN teacher_table t
          ON t.id = sgs.submitted_by
        WHERE sgs.subject_section_id
          IN (${subjectPlaceholders})
          AND sgs.grading_period_id = ?
        `,
        [...subjectSectionIds, gradingPeriodId]
      );

    const submissionBySubject = new Map(
      subjectSubmissionRows.map((row) => [
        row.subjectSectionId,
        {
          submittedBy: row.submittedBy,
          submittedByName: row.submittedByName,
          submittedAt: row.submittedAt,
        },
      ])
    );

    // ============================================================
    // 9. OVERALL AVERAGE
    //
    // IMPORTANT:
    // Hindi na natin iho-hold hanggang "allSubjectsSubmitted"
    // dahil advisory grade submission na mismo ang final gate.
    //
    // Ito rin ang table na ginagamit ng teacher advisory gradebook.
    // ============================================================
    let overallRows;

    if (sectionId) {
      [overallRows] = await connection.execute(
        `
        SELECT
          student_id AS studentId,
          overall_average AS overallAverage
        FROM advisory_overall_grades
        WHERE section_id = ?
          AND grading_period_id = ?
        `,
        [
          sectionId,
          gradingPeriodId,
        ]
      );
    } else {
      [overallRows] = await connection.execute(
        `
        SELECT
          student_id AS studentId,
          overall_average AS overallAverage
        FROM advisory_overall_grades
        WHERE grade_level_id = ?
          AND section_id IS NULL
          AND grading_period_id = ?
        `,
        [
          gradeLevelId,
          gradingPeriodId,
        ]
      );
    }

    const overallByStudent = new Map(
      overallRows.map((row) => [
        row.studentId,
        row.overallAverage !== null
          ? Number(row.overallAverage)
          : null,
      ])
    );

    // ============================================================
    // 10. BUILD SAME GRADE CELLS AS TEACHER
    //
    // Teacher logic:
    //
    // adviser's own subject:
    //   complete => submitted
    //
    // other teacher:
    //   subject submission => submitted
    //   complete but not submitted => pending
    //
    // Principal reaches this point ONLY after advisory submission.
    // ============================================================
    const studentsOut = students.map((student) => {
      const grades = {};

      for (const subject of subjectSections) {
        const cache =
          cacheByKey.get(
            `${student.id}:${subject.subjectSectionId}`
          ) || {
            average: null,
            isComplete: false,
          };

        const isOwnAdvisorySubject =
          adviserTeacherId !== null &&
          Number(subject.teacherId) ===
            Number(adviserTeacherId);

        const subjectSubmission =
          submissionBySubject.get(
            subject.subjectSectionId
          ) || null;

        let status;

        // SAME RULE AS TEACHER ADVISORY GRADESHEET
        if (isOwnAdvisorySubject) {
          status = cache.isComplete
            ? "submitted"
            : "not_submitted";
        } else if (subjectSubmission) {
          status = "submitted";
        } else if (cache.isComplete) {
          status = "pending";
        } else {
          status = "not_submitted";
        }

        const visibleAverage =
          status === "submitted" &&
          cache.average !== null
            ? cache.average
            : null;

        grades[String(subject.subjectSectionId)] = {
          status,

          termGrade: visibleAverage,
          average: visibleAverage,

          submittedByName:
            subjectSubmission?.submittedByName ??
            null,

          submittedAt:
            subjectSubmission?.submittedAt ??
            null,

          isOwnAdvisory:
            isOwnAdvisorySubject,
        };
      }

      return {
        studentId: String(student.id),

        firstName: student.firstName,
        middleName: student.middleName,
        lastName: student.lastName,

        gender:
          student.gender === "Female"
            ? "F"
            : "M",

        grades,

        overallAverage:
          overallByStudent.has(student.id)
            ? overallByStudent.get(student.id)
            : null,
      };
    });

    // ============================================================
    // 11. SUBJECT HEADERS
    // ============================================================
    const subjectsOut = subjectSections.map(
      (subject) => {
        const isOwnAdvisory =
          adviserTeacherId !== null &&
          Number(subject.teacherId) ===
            Number(adviserTeacherId);

        const submission =
          submissionBySubject.get(
            subject.subjectSectionId
          ) || null;

        let submitted;

        if (isOwnAdvisory) {
          // Same approach as teacher gradebook.
          submitted = students.every((student) => {
            const cache = cacheByKey.get(
              `${student.id}:${subject.subjectSectionId}`
            );

            return Boolean(cache?.isComplete);
          });
        } else {
          submitted = Boolean(submission);
        }

        return {
          subjectSectionId: String(
            subject.subjectSectionId
          ),

          subjectId: subject.subjectId,
          subjectName: subject.subjectName,

          teacherId: String(subject.teacherId),
          teacherName: subject.teacherName,

          submitted,

          submittedByName:
            submission?.submittedByName ?? null,

          submittedAt:
            submission?.submittedAt ?? null,

          isOwnAdvisory,
        };
      }
    );

    // ============================================================
    // RESPONSE
    // ============================================================
    return res.status(200).json({
      success: true,

      data: {
        schoolYearId,
        gradingPeriodId,

        gradeLevelId,
        gradeLevel,

        sectionId,
        sectionName,

        advisorySubmitted: true,

        submittedAt:
          advisorySubmission.submittedAt,

        submittedByName:
          advisorySubmission.submittedByName,

        subjects: subjectsOut,
        students: studentsOut,
      },
    });
  } catch (error) {
    console.error(
      "Error building principal section gradebook:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Internal server error.",
    });
  }
};

module.exports = {
  getSectionGrade,
  getPrincipalSectionGradebook,
  getGradingPeriods,
};
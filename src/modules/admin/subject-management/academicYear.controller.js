const connection = require("../../../../config/db");

/**
 * Term names are always derived from term_number — never client-supplied.
 */
const TERM_NAME_MAP = { 1: "Term 1", 2: "Term 2", 3: "Term 3" };

function termLabelFor(termNumber) {
  return TERM_NAME_MAP[termNumber] ?? `Term ${termNumber}`;
}

/**
 * Derives a term's display status from its dates.
 * A term that hasn't been configured yet (null dates) is "Upcoming"
 * since it isn't running and hasn't been skipped.
 */
function deriveTermStatus(startDate, endDate) {
  if (!startDate || !endDate) return "Upcoming";
  const today = new Date().toISOString().slice(0, 10);
  if (today < startDate) return "Upcoming";
  if (today > endDate) return "Completed";
  return "Active";
}

async function getUnfinishedTerms(conn, schoolYearId) {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Manila",
  }); // YYYY-MM-DD

  const [rows] = await conn.query(
    `SELECT term_number, term_label, start_date, end_date
     FROM grading_periods
     WHERE school_year_id = ?
       AND (start_date IS NULL OR end_date IS NULL OR end_date >= ?)
     ORDER BY term_number ASC`,
    [schoolYearId, today],
  );

  return rows;
}

async function fetchAcademicYearById(conn, id) {
  const [rows] = await conn.query(
    `SELECT sy.id, sy.school_year, sy.is_active,
            MIN(gp.start_date) AS start_date,
            MAX(gp.end_date) AS end_date
     FROM school_year sy
     LEFT JOIN grading_periods gp ON gp.school_year_id = sy.id
     WHERE sy.id = ?
     GROUP BY sy.id
     LIMIT 1`,
    [id],
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    label: row.school_year,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.is_active ? "Active" : "Inactive",
  };
}

exports.getActiveAcademicYear = async (_req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT sy.id, sy.school_year, sy.is_active,
              MIN(gp.start_date) AS start_date,
              MAX(gp.end_date) AS end_date
       FROM school_year sy
       LEFT JOIN grading_periods gp ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       GROUP BY sy.id
       LIMIT 1`,
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({
        status: "fail",
        message: "No active academic year found.",
      });
    }

    res.status(200).json({
      status: "success",
      message: "Active academic year fetched successfully.",
      data: {
        id: row.id,
        label: row.school_year,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.is_active ? "Active" : "Inactive",
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      status: "error",
      message: "Database error occurred.",
    });
  }
};

const PASSING_GWA = 75;
const HIGHEST_GRADE_LEVEL_ID = 6;

async function getStudentYearEndResults(conn, oldSchoolYearId) {
  /*
   * advisory_overall_grades = overall grade PER TERM.
   *
   * Final GWA:
   * AVG(Term 1, Term 2, Term 3)
   *
   * Kapag may missing term grade, hindi ibi-block ang
   * school-year transition. Ire-record ang student as
   * "pending" for manual review.
   */
  const [rows] = await conn.query(
    `
    SELECT
      s.id AS studentId,
      s.grade_level_id AS gradeLevelId,
      s.section_id AS sectionId,

      COUNT(DISTINCT CASE
        WHEN aog.overall_average IS NOT NULL
        THEN gp.id
      END) AS completedTerms,

      COUNT(DISTINCT gp.id) AS totalTerms,

      ROUND(AVG(aog.overall_average), 2) AS gwa

    FROM elem_students s

    INNER JOIN grading_periods gp
      ON gp.school_year_id = ?

    LEFT JOIN advisory_overall_grades aog
      ON aog.student_id = s.id
      AND aog.grading_period_id = gp.id

    WHERE
      s.is_deleted = 0
      AND s.status <> 'graduated'
      AND s.current_school_year_id = ?

    GROUP BY
      s.id,
      s.grade_level_id,
      s.section_id

    ORDER BY s.id
    `,
    [oldSchoolYearId, oldSchoolYearId],
  );

  return rows;
}

exports.addAcademicYear = async (req, res) => {
  const { label, status } = req.body;

  if (!label || typeof label !== "string") {
    return res.status(400).json({
      status: "fail",
      message: "'label' is required.",
    });
  }

  if (status !== "Active" && status !== "Inactive") {
    return res.status(400).json({
      status: "fail",
      message: "'status' must be 'Active' or 'Inactive'.",
    });
  }

  const isActive = status === "Active" ? 1 : 0;

  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    // =========================================================
    // 1. GET CURRENT ACTIVE SCHOOL YEAR
    // =========================================================

    const [activeRows] = await conn.query(
      `
      SELECT id, school_year
      FROM school_year
      WHERE is_active = 1
      FOR UPDATE
      `,
    );

    const previousActiveYear = activeRows.length > 0 ? activeRows[0] : null;

    // =========================================================
    // 2. CREATE NEW SCHOOL YEAR FIRST
    //
    // Initially inactive muna habang ginagawa ang transition.
    // This prevents queries from suddenly seeing the new SY
    // halfway through the transaction.
    // =========================================================

    // ===== BLOCK: terms of current SY must be done first =====
    if (isActive && previousActiveYear) {
      const unfinished = await getUnfinishedTerms(conn, previousActiveYear.id);

      if (unfinished.length > 0) {
        const names = unfinished.map((t) => t.term_label).join(", ");
        const err = new Error(
          `Cannot change school year yet. The following terms of ${previousActiveYear.school_year} are not finished or have no dates set: ${names}.`,
        );
        err.statusCode = 400;
        throw err;
      }
    }

    const [result] = await conn.query(
      `
      INSERT INTO school_year
        (school_year, is_active)
      VALUES (?, 0)
      `,
      [label],
    );

    const newSchoolYearId = result.insertId;

    // =========================================================
    // 3. CREATE 3 TERMS
    // =========================================================

    await conn.query(
      `
      INSERT INTO grading_periods
        (
          school_year_id,
          term_number,
          term_label,
          start_date,
          end_date,
          is_active
        )
      VALUES
        (?, 1, ?, NULL, NULL, 0),
        (?, 2, ?, NULL, NULL, 0),
        (?, 3, ?, NULL, NULL, 0)
      `,
      [
        newSchoolYearId,
        termLabelFor(1),

        newSchoolYearId,
        termLabelFor(2),

        newSchoolYearId,
        termLabelFor(3),
      ],
    );

    let transitionSummary = null;

    // =========================================================
    // 4. ONLY PROCESS TRANSITION IF NEW YEAR WILL BE ACTIVE
    // =========================================================

    if (isActive && previousActiveYear) {
      const oldSchoolYearId = previousActiveYear.id;

      // -------------------------------------------------------
      // A. PROCESS STUDENTS
      // -------------------------------------------------------

      transitionSummary = await processStudentYearTransition(
        conn,
        oldSchoolYearId,
        newSchoolYearId,
        null,
      );

      // -------------------------------------------------------
      // B. COMPLETE ALL SUBJECTS FROM OLD SCHOOL YEAR
      // -------------------------------------------------------

      await conn.query(
        `
        UPDATE \`subject-section\`
        SET status = 'Completed'
        WHERE school_year_id = ?
          AND status <> 'Completed'
        `,
        [oldSchoolYearId],
      );

      // -------------------------------------------------------
      // C. DEACTIVATE OLD CLASSES
      //
      // Recommended dahil old advisory/class assignments na ito.
      // -------------------------------------------------------

      await conn.query(
        `
        UPDATE classes
        SET status = 'Inactive'
        WHERE school_year_id = ?
        `,
        [oldSchoolYearId],
      );

      // -------------------------------------------------------
      // D. DEACTIVATE OLD GRADING PERIODS
      // -------------------------------------------------------

      await conn.query(
        `
        UPDATE grading_periods
        SET is_active = 0
        WHERE school_year_id = ?
        `,
        [oldSchoolYearId],
      );

      // -------------------------------------------------------
      // E. DEACTIVATE OLD SCHOOL YEAR
      // -------------------------------------------------------

      await conn.query(
        `
        UPDATE school_year
        SET is_active = 0
        WHERE id = ?
        `,
        [oldSchoolYearId],
      );
    }

    // =========================================================
    // 5. ENSURE NO OTHER YEAR IS ACTIVE
    // =========================================================

    if (isActive) {
      await conn.query(
        `
        UPDATE school_year
        SET is_active = 0
        WHERE id <> ?
        `,
        [newSchoolYearId],
      );

      // =======================================================
      // 6. ACTIVATE NEW SCHOOL YEAR
      // =======================================================

      await conn.query(
        `
        UPDATE school_year
        SET is_active = 1
        WHERE id = ?
        `,
        [newSchoolYearId],
      );
    }

    // =========================================================
    // 7. FETCH CREATED YEAR
    // =========================================================

    const created = await fetchAcademicYearById(conn, newSchoolYearId);

    await conn.commit();

    // =========================================================
    // RESPONSE
    // =========================================================

    return res.status(201).json({
      status: "success",
      message:
        isActive && previousActiveYear
          ? "New academic year activated and previous school year completed successfully."
          : "Academic year created successfully.",

      data: created,

      transition: transitionSummary,
    });
  } catch (error) {
    await conn.rollback();

    console.error("Academic year transition error:", error);

    return res.status(error.statusCode || 500).json({
      status: error.statusCode ? "fail" : "error",
      message: error.message || "Database error occurred.",
    });
  } finally {
    conn.release();
  }
};

exports.getTermsForSchoolYear = async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await connection.query(
      `SELECT id, school_year_id, term_number, term_label, start_date, end_date, is_active
       FROM grading_periods
       WHERE school_year_id = ?
       ORDER BY term_number ASC`,
      [id],
    );

    const terms = rows.map((row) => ({
      id: row.id,
      termNumber: row.term_number,
      name: row.term_label, // always derived server-side, e.g. "Term 1"
      startDate: row.start_date, // null until configured
      endDate: row.end_date, // null until configured
      status: deriveTermStatus(row.start_date, row.end_date),
    }));

    res.status(200).json({
      status: "success",
      message: "Terms fetched successfully.",
      data: terms,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ status: "error", message: "Database error occurred." });
  }
};

exports.saveTermsForSchoolYear = async (req, res) => {
  const { id } = req.params;
  const { terms } = req.body;

  if (!Array.isArray(terms) || terms.length === 0) {
    return res
      .status(400)
      .json({ status: "fail", message: "'terms' must be a non-empty array." });
  }
  // Name is never client-supplied — only termNumber + dates are required.
  const invalid = terms.find(
    (t) => typeof t.termNumber !== "number" || !t.startDate || !t.endDate,
  );
  if (invalid) {
    return res.status(400).json({
      status: "fail",
      message: "Each term needs termNumber, startDate, and endDate.",
    });
  }

  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    for (const term of terms) {
      const isActive =
        deriveTermStatus(term.startDate, term.endDate) === "Active" ? 1 : 0;
      const label = termLabelFor(term.termNumber); // always derived, never trusted from client

      // Relies on a UNIQUE (school_year_id, term_number) key so this
      // fills in the seeded-but-empty row instead of duplicating it.
      await conn.query(
        `INSERT INTO grading_periods
           (school_year_id, term_number, term_label, start_date, end_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           term_label = VALUES(term_label),
           start_date = VALUES(start_date),
           end_date = VALUES(end_date),
           is_active = VALUES(is_active)`,
        [id, term.termNumber, label, term.startDate, term.endDate, isActive],
      );
    }

    const [rows] = await conn.query(
      `SELECT id, term_number, term_label, start_date, end_date
       FROM grading_periods
       WHERE school_year_id = ?
       ORDER BY term_number ASC`,
      [id],
    );

    await conn.commit();

    const saved = rows.map((row) => ({
      id: row.id,
      termNumber: row.term_number,
      name: row.term_label,
      startDate: row.start_date,
      endDate: row.end_date,
      status: deriveTermStatus(row.start_date, row.end_date),
    }));

    res.status(200).json({
      status: "success",
      message: "Terms saved successfully.",
      data: saved,
    });
  } catch (error) {
    await conn.rollback();
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ status: "error", message: "Database error occurred." });
  } finally {
    conn.release();
  }
};

exports.getAllSchoolYears = async (_req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT id, school_year, is_active
       FROM school_year
       ORDER BY school_year DESC`,
    );

    res.status(200).json({
      status: "success",
      message: "School years fetched successfully.",
      data: rows,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      status: "error",
      message: "Database error occurred.",
    });
  }
};

async function processStudentYearTransition(
  conn,
  oldSchoolYearId,
  newSchoolYearId,
  processedBy = null,
) {
  const students = await getStudentYearEndResults(conn, oldSchoolYearId);

  const summary = {
    promoted: 0,
    retained: 0,
    graduated: 0,
    pending: 0,
  };

  for (const student of students) {
    const studentId = Number(student.studentId);
    const currentGradeLevelId = Number(student.gradeLevelId);

    const currentSectionId =
      student.sectionId !== null ? Number(student.sectionId) : null;

    const completedTerms = Number(student.completedTerms);
    const totalTerms = Number(student.totalTerms);

    const hasCompleteGrades =
      completedTerms === totalTerms && totalTerms > 0 && student.gwa !== null;

    // =========================================================
    // INCOMPLETE / POSSIBLE DROPPED STUDENT
    // =========================================================
    if (!hasCompleteGrades) {
      await conn.query(
        `
        INSERT INTO student_year_records
          (
            student_id,
            school_year_id,
            grade_level_id,
            section_id,
            status,
            processed_by
          )
        VALUES (?, ?, ?, ?, 'pending', ?)

        ON DUPLICATE KEY UPDATE
          grade_level_id = VALUES(grade_level_id),
          section_id = VALUES(section_id),
          status = 'pending',
          processed_by = VALUES(processed_by),
          processed_at = CURRENT_TIMESTAMP
        `,
        [
          studentId,
          oldSchoolYearId,
          currentGradeLevelId,
          currentSectionId,
          processedBy,
        ],
      );

      /*
       * Important:
       *
       * Huwag natin siyang auto-promote o auto-retain dahil
       * wala tayong complete basis.
       *
       * Pero ililipat natin ang current_school_year_id sa bagong SY
       * para hindi siya manatiling naka-tali sa old active year.
       *
       * Same grade level muna.
       * No section muna.
       */
      await conn.query(
        `
        UPDATE elem_students
        SET
          section_id = NULL,
          current_school_year_id = ?,
          status = 'active'
        WHERE id = ?
        `,
        [newSchoolYearId, studentId],
      );

      summary.pending++;
      continue;
    }

    // =========================================================
    // COMPLETE GRADES
    // =========================================================

    const gwa = Number(student.gwa);

    let yearResult;
    let nextGradeLevelId = currentGradeLevelId;

    if (gwa >= PASSING_GWA) {
      // Grade 6 + passing = graduate
      if (currentGradeLevelId === HIGHEST_GRADE_LEVEL_ID) {
        yearResult = "graduated";
      } else {
        yearResult = "promoted";
        nextGradeLevelId = currentGradeLevelId + 1;
      }
    } else {
      yearResult = "retained";
    }

    // =========================================================
    // SAVE OLD SCHOOL YEAR RESULT
    // =========================================================

    await conn.query(
      `
      INSERT INTO student_year_records
        (
          student_id,
          school_year_id,
          grade_level_id,
          section_id,
          status,
          processed_by
        )
      VALUES (?, ?, ?, ?, ?, ?)

      ON DUPLICATE KEY UPDATE
        grade_level_id = VALUES(grade_level_id),
        section_id = VALUES(section_id),
        status = VALUES(status),
        processed_by = VALUES(processed_by),
        processed_at = CURRENT_TIMESTAMP
      `,
      [
        studentId,
        oldSchoolYearId,
        currentGradeLevelId,
        currentSectionId,
        yearResult,
        processedBy,
      ],
    );

    // =========================================================
    // UPDATE CURRENT STUDENT
    // =========================================================

    if (yearResult === "graduated") {
      await conn.query(
        `
        UPDATE elem_students
        SET
          section_id = NULL,
          status = 'graduated'
        WHERE id = ?
        `,
        [studentId],
      );

      summary.graduated++;
    } else {
      await conn.query(
        `
        UPDATE elem_students
        SET
          grade_level_id = ?,
          section_id = NULL,
          current_school_year_id = ?,
          status = 'active'
        WHERE id = ?
        `,
        [nextGradeLevelId, newSchoolYearId, studentId],
      );

      if (yearResult === "promoted") {
        summary.promoted++;
      } else {
        summary.retained++;
      }
    }
  }

  return summary;
}

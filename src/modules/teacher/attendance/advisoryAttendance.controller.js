const connection = require("../../../../config/db");
const { notifyAbsence, notifyAttendanceComplete } = require("../../notification/notification.service");

async function getActiveGradingPeriodId() {
  const [rows] = await connection.execute(
    `SELECT gp.id
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].id : null;
}

// Kinukuha ang ID ng active na school year.
async function getActiveSchoolYearId() {
  const [rows] = await connection.execute(
    `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].id : null;
}

// Loads every class this teacher advises. Used by the list endpoint,
// and to verify ownership when a specific :classId is requested.
async function loadAdvisoryClasses(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: walang user ID na nakuha mula sa token.",
      });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId],
    );
    if (teacherRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const activeSchoolYearId = await getActiveSchoolYearId();
    if (!activeSchoolYearId) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [classRows] = await connection.execute(
      `SELECT c.id AS classId, c.section_id, gls.section_name AS sectionName,
              gl.grade_level AS gradeLevel
       FROM classes c
       LEFT JOIN grade_level_sections gls ON c.section_id = gls.id
       INNER JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE c.class_adviser_id = ? AND c.school_year_id = ? AND c.status = 'Active'`,
      [teacherId, activeSchoolYearId],
    );

    req.teacherId = teacherId;
    req.advisoryClasses = classRows; // full list, possibly empty
    next();
  } catch (error) {
    console.error("Error loading advisory classes:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
}

// For routes like /:classId — picks the requested class out of this
// teacher's advisory classes, or 403s if it isn't theirs.
function requireOwnedClass(req, res, next) {
  const { classId } = req.params;
  const match = req.advisoryClasses.find(
    (c) => String(c.classId) === String(classId),
  );

  if (!match) {
    return res
      .status(403)
      .json({ success: false, message: "You are not the adviser of this class." });
  }

  req.advisorySection = match;
  next();
}

// GET /api/teacherAttendance/advisory-sections
const getAdvisorySectionsList = async (req, res) => {
  try {
    const classes = req.advisoryClasses;
    if (classes.length === 0) {
      return res.status(404).json({
        success: false,
        message: "You are not the adviser of any section yet.",
      });
    }

    const activeSchoolYearId = await getActiveSchoolYearId();

    const [terms] = await connection.execute(
      `SELECT gp.id,
              gp.term_label AS label,
              DATE_FORMAT(gp.start_date, '%Y-%m-%d') AS startDate,
              DATE_FORMAT(gp.end_date, '%Y-%m-%d') AS endDate,
              gp.is_active AS isActive
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.start_date ASC`,
      [],
    );
    const formattedTerms = terms.map((t) => ({
      ...t,
      id: String(t.id),
      isActive: Number(t.isActive) === 1,
    }));

    const sections = await Promise.all(
      classes.map(async ({ classId, section_id: sectionId, sectionName, gradeLevel }) => {
        const [roster] = sectionId
          ? await connection.execute(
              `SELECT s.id,
                      CONCAT(s.last_name, ', ', s.first_name, IF(s.middle_name IS NOT NULL AND s.middle_name != '', CONCAT(' ', s.middle_name), '')) AS name,
                      s.gender AS gender
               FROM elem_students s
               WHERE s.section_id = ?
                 AND s.is_deleted = 0
                 AND s.status <> 'graduated'
                 AND s.current_school_year_id = ?
               ORDER BY s.last_name ASC, s.first_name ASC`,
              [sectionId, activeSchoolYearId],
            )
          : await connection.execute(
              `SELECT s.id,
                      CONCAT(s.last_name, ', ', s.first_name, IF(s.middle_name IS NOT NULL AND s.middle_name != '', CONCAT(' ', s.middle_name), '')) AS name,
                      s.gender AS gender
               FROM elem_students s
               WHERE s.grade_level_id = (SELECT grade_level_id FROM classes WHERE id = ?)
                 AND s.section_id IS NULL
                 AND s.is_deleted = 0
                 AND s.status <> 'graduated'
                 AND s.current_school_year_id = ?
               ORDER BY s.last_name ASC, s.first_name ASC`,
              [classId, activeSchoolYearId],
            );

        return {
          classId: String(classId),
          sectionId: sectionId ? String(sectionId) : null,
          sectionName: sectionName?.trim() || gradeLevel,
          gradeLevel,
          roster: roster.map((r) => ({ id: String(r.id), name: r.name, gender: r.gender })),
          terms: formattedTerms,
        };
      }),
    );

    return res.status(200).json(sections);
  } catch (error) {
    console.error("Error fetching advisory sections list:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const getAdvisoryAttendance = async (req, res) => {
  try {
    const { classId } = req.advisorySection;
    const { term, allPeriods } = req.query;

    const activeSchoolYearId = await getActiveSchoolYearId();

    // Hindi isasama ang graduated at ang mga estudyanteng wala sa current school year.
    let sql = `
      SELECT a.student_id, DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS date, a.status
      FROM advisory_attendance_records a
      INNER JOIN elem_students s ON s.id = a.student_id
      WHERE a.class_id = ?
        AND s.status <> 'graduated'
        AND s.current_school_year_id = ?
    `;
    const params = [classId, activeSchoolYearId];

    let resolvedTermId = null;
    if (allPeriods !== "true") {
      resolvedTermId = term || (await getActiveGradingPeriodId());
      sql += ` AND a.grading_period_id = ?`;
      params.push(resolvedTermId);
    }

    const [rows] = await connection.execute(sql, params);

    const map = {};
    const presentCount = {};
    for (const r of rows) {
      const sid = String(r.student_id);
      map[sid] = map[sid] || {};
      map[sid][r.date] = r.status;
      if (r.status === "P") presentCount[sid] = (presentCount[sid] || 0) + 1;
    }

    return res.status(200).json({
      success: true,
      data: map,
      presentTotals: presentCount,
      termId: resolvedTermId ? String(resolvedTermId) : null,
    });
  } catch (error) {
    console.error("Error fetching advisory attendance:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const upsertAdvisoryAttendance = async (req, res) => {
  try {
    const { classId, section_id: sectionId } = req.advisorySection;
    const { teacherId } = req;
    const { studentId, date, term } = req.body;
    const status = req.body.status;

    if (!studentId || !date) {
      return res
        .status(400)
        .json({ success: false, message: "studentId and date are required." });
    }

    const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? new Date(`${date}T00:00:00Z`) : null;
    if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ success: false, message: "date must be a valid YYYY-MM-DD date." });
    }

    if (status === undefined) {
      return res.status(400).json({ success: false, message: "status is required." });
    }
    if (status !== null && !["P", "A", "L", "E"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be P, A, L, E, or null." });
    }

    const activeSchoolYearId = await getActiveSchoolYearId();
    if (!activeSchoolYearId) {
      return res.status(400).json({ success: false, message: "No active school year is available." });
    }

    const [[todayRow]] = await connection.query(
      `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today`,
    );
    const today = todayRow?.today;
    if (!today || date > today) {
      return res.status(400).json({ success: false, message: "Attendance cannot be recorded for a future date." });
    }

    const activePeriodId = await getActiveGradingPeriodId();
    const requestedPeriodId = term || activePeriodId;

    const [existingRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId
       FROM advisory_attendance_records
       WHERE class_id = ? AND student_id = ? AND attendance_date = ?
       LIMIT 1`,
      [classId, studentId, date],
    );
    const existingPeriodId = existingRows[0]?.gradingPeriodId ?? null;

    if (!existingPeriodId && status === null) {
      return res.status(200).json({ success: true, termId: requestedPeriodId ? String(requestedPeriodId) : null });
    }

    if (existingPeriodId && term && String(term) !== String(existingPeriodId)) {
      return res.status(400).json({ success: false, message: "This attendance mark belongs to a different grading period." });
    }

    const gradingPeriodId = existingPeriodId || requestedPeriodId;
    if (!gradingPeriodId) {
      return res.status(400).json({ success: false, message: "No active grading period is available." });
    }

    const [periodRows] = await connection.execute(
      `SELECT gp.id, gp.is_active AS isActive,
              DATE_FORMAT(gp.start_date, '%Y-%m-%d') AS startDate,
              DATE_FORMAT(gp.end_date, '%Y-%m-%d') AS endDate
       FROM grading_periods gp
       WHERE gp.id = ? AND gp.school_year_id = ?
         AND ? BETWEEN DATE(gp.start_date) AND DATE(gp.end_date)
       LIMIT 1`,
      [gradingPeriodId, activeSchoolYearId, date],
    );
    const period = periodRows[0];
    if (!period) {
      return res.status(400).json({ success: false, message: "The attendance date must fall within its grading period." });
    }

    if (date === today && (String(gradingPeriodId) !== String(activePeriodId) || Number(period.isActive) !== 1)) {
      return res.status(400).json({ success: false, message: "Attendance can only be marked today while the active grading period is open." });
    }

    if (!existingPeriodId && date !== today) {
      return res.status(400).json({ success: false, message: "New attendance can only be marked for today. Existing past marks may be edited." });
    }

    const [studentRows] = await connection.execute(
      `SELECT s.id
       FROM elem_students s
       INNER JOIN classes c ON c.id = ? AND c.grade_level_id = s.grade_level_id
       WHERE s.id = ? AND s.current_school_year_id = ?
         AND s.is_deleted = 0 AND s.status <> 'graduated'
         AND ((c.section_id IS NOT NULL AND s.section_id = c.section_id)
           OR (c.section_id IS NULL AND s.section_id IS NULL))
       LIMIT 1`,
      [classId, studentId, activeSchoolYearId],
    );
    if (studentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Student is not enrolled in this advisory class for the active school year." });
    }

    if (status === null) {
      await connection.execute(
        `DELETE FROM advisory_attendance_records
         WHERE class_id = ? AND student_id = ? AND attendance_date = ?`,
        [classId, studentId, date],
      );
    } else if (existingPeriodId) {
      await connection.execute(
        `UPDATE advisory_attendance_records
         SET status = ?, recorded_by = ?
         WHERE class_id = ? AND student_id = ? AND attendance_date = ?`,
        [status, teacherId, classId, studentId, date],
      );

      if (status === "A") {
        try {
          await notifyAbsence({ studentId, date });
        } catch (notifErr) {
          console.error("Absence notification error:", notifErr);
        }
      }
    } else {
      await connection.execute(
        `INSERT INTO advisory_attendance_records
           (section_id, class_id, grading_period_id, student_id, attendance_date, status, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), grading_period_id = VALUES(grading_period_id), recorded_by = VALUES(recorded_by)`,
        [sectionId ?? null, classId, gradingPeriodId, studentId, date, status, teacherId],
      );

      if (status === "A") {
        try {
          await notifyAbsence({ studentId, date });
        } catch (notifErr) {
          console.error("Absence notification error:", notifErr);
        }
      }

      try {
        await notifyAttendanceComplete({ classId, date });
      } catch (notifErr) {
        console.error("Attendance-complete notification error:", notifErr);
      }
    }

    return res.status(200).json({
      success: true,
      termId: gradingPeriodId ? String(gradingPeriodId) : null,
    });
  } catch (error) {
    console.error("Error saving advisory attendance:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadAdvisoryClasses,
  requireOwnedClass,
  getAdvisorySectionsList,
  getAdvisoryAttendance,
  upsertAdvisoryAttendance,
};

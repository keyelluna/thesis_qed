const connection = require('../../../../config/db');

async function getActiveGradingPeriodId() {
  const [rows] = await connection.execute(
    `SELECT gp.id
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`
  );
  return rows.length > 0 ? rows[0].id : null;
}

async function loadAdvisorySection(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId]
    );
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const [classRows] = await connection.execute(
      `SELECT c.section_id, gls.section_name AS sectionName, gl.grade_level AS gradeLevel
       FROM classes c
       INNER JOIN grade_level_sections gls ON c.section_id = gls.id
       INNER JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE c.class_adviser_id = ?`,
      [teacherId]
    );
    if (classRows.length === 0) {
      return res.status(404).json({ success: false, message: "You are not the adviser of any section yet." });
    }

    req.teacherId = teacherId;
    req.advisorySection = classRows[0];
    next();
  } catch (error) {
    console.error("Error verifying advisory section access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

// GET /api/teacherAttendance/advisory-section
// Returns the shape the frontend's AdvisorySection type expects:
// { sectionId, sectionName, gradeLevel, roster, terms }
const getAdvisorySectionInfo = async (req, res) => {
  try {
    const { section_id: sectionId, sectionName, gradeLevel } = req.advisorySection;

    const [roster] = await connection.execute(
      `SELECT s.id,
              CONCAT(s.last_name, ', ', s.first_name, IF(s.middle_name IS NOT NULL AND s.middle_name != '', CONCAT(' ', s.middle_name), '')) AS name,
              s.gender AS gender
       FROM elem_students s
       WHERE s.section_id = ?
         AND s.is_deleted = 0
       ORDER BY s.last_name ASC, s.first_name ASC`,
      [sectionId]
    );

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
      []
    );

    return res.status(200).json({
      sectionId: String(sectionId),
      sectionName,
      gradeLevel,
      roster: roster.map((r) => ({ id: String(r.id), name: r.name, gender: r.gender })),
      terms: terms.map((t) => ({ ...t, id: String(t.id), isActive: !!t.isActive })),
    });
  } catch (error) {
    console.error("Error fetching advisory section info:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getAdvisoryAttendance = async (req, res) => {
  try {
    const { section_id: sectionId } = req.advisorySection;
    const { term, allPeriods } = req.query;

    let sql = `
      SELECT student_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS date, status
      FROM advisory_attendance_records
      WHERE section_id = ?
    `;
    const params = [sectionId];

    let resolvedTermId = null;
    if (allPeriods !== "true") {
      resolvedTermId = term || (await getActiveGradingPeriodId());
      if (resolvedTermId) {
        sql += ` AND grading_period_id = ?`;
        params.push(resolvedTermId);
      }
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
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const upsertAdvisoryAttendance = async (req, res) => {
  try {
    const { section_id: sectionId } = req.advisorySection;
    const { teacherId } = req;
    const { studentId, date, term } = req.body;
    const status = req.body.status ?? null;

    if (!studentId || !date) {
      return res.status(400).json({ success: false, message: "studentId and date are required." });
    }

    const gradingPeriodId = term || (await getActiveGradingPeriodId());

    if (status === null) {
      await connection.execute(
        `DELETE FROM advisory_attendance_records
         WHERE section_id = ? AND student_id = ? AND attendance_date = ?`,
        [sectionId, studentId, date]
      );
    } else {
      await connection.execute(
        `INSERT INTO advisory_attendance_records
           (section_id, grading_period_id, student_id, attendance_date, status, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), grading_period_id = VALUES(grading_period_id), recorded_by = VALUES(recorded_by)`,
        [sectionId, gradingPeriodId, studentId, date, status, teacherId]
      );
    }

    return res.status(200).json({ success: true, termId: gradingPeriodId ? String(gradingPeriodId) : null });
  } catch (error) {
    console.error("Error saving advisory attendance:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadAdvisorySection,
  getAdvisorySectionInfo,
  getAdvisoryAttendance,
  upsertAdvisoryAttendance,
};
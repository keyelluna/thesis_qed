const connection = require("../../../../config/db");
const { notifyAbsence, notifyAttendanceComplete } = require("../../notification/notification.service");

async function getActiveGradingPeriodId(db = connection) {
  const [rows] = await db.execute(
    `SELECT gp.id
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`,
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

    // Resolve teacher, active year and owned classes in one database round trip.
    const [classRows] = await connection.execute(
      `SELECT c.id AS classId, c.section_id, gls.section_name AS sectionName,
              gl.grade_level AS gradeLevel, c.school_year_id AS schoolYearId,
              sy.school_year AS schoolYearLabel, t.id AS teacherId
       FROM classes c
       INNER JOIN teacher_table t ON t.id = c.class_adviser_id
       INNER JOIN school_year sy ON sy.id = c.school_year_id AND sy.is_active = 1
       LEFT JOIN grade_level_sections gls ON c.section_id = gls.id
       INNER JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE t.user_id = ? AND c.status = 'Active'`,
      [authId],
    );
    const teacherId = classRows[0]?.teacherId;

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

    const activeSchoolYearId = classes[0].schoolYearId;

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
      classes.map(async ({ classId, section_id: sectionId, sectionName, gradeLevel, schoolYearId, schoolYearLabel }) => {
        const [roster] = sectionId
          ? await connection.execute(
              `SELECT s.id,
                      CONCAT(s.last_name, ', ', s.first_name, IF(s.middle_name IS NOT NULL AND s.middle_name != '', CONCAT(' ', s.middle_name), '')) AS name,
                      s.gender AS gender, DATE_FORMAT(ti.joined_date, '%Y-%m-%d') AS joinedDate
               FROM elem_students s LEFT JOIN student_transfer_ins ti ON ti.student_id=s.id AND ti.school_year_id=s.current_school_year_id
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
                      s.gender AS gender, DATE_FORMAT(ti.joined_date, '%Y-%m-%d') AS joinedDate
               FROM elem_students s LEFT JOIN student_transfer_ins ti ON ti.student_id=s.id AND ti.school_year_id=s.current_school_year_id
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
          schoolYearId: String(schoolYearId),
          schoolYearLabel,
          sectionId: sectionId ? String(sectionId) : null,
          sectionName: sectionName?.trim() || gradeLevel,
          gradeLevel,
          roster: roster.map((r) => ({ id: String(r.id), name: r.name, gender: r.gender, joinedDate: r.joinedDate })),
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

    const activeSchoolYearId = req.advisorySection.schoolYearId;

    // Hindi isasama ang graduated at ang mga estudyanteng wala sa current school year.
    let sql = `
      SELECT a.student_id, DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS date, a.status
      FROM advisory_attendance_records a
      INNER JOIN elem_students s ON s.id = a.student_id
      WHERE a.class_id = ?
        AND s.status <> 'graduated'
        AND s.current_school_year_id = ?
        AND NOT EXISTS (SELECT 1 FROM student_transfer_ins ti WHERE ti.student_id=a.student_id AND ti.school_year_id=s.current_school_year_id AND a.attendance_date<ti.joined_date)
        AND NOT EXISTS (SELECT 1 FROM student_dropout_events d WHERE d.student_id=a.student_id AND d.school_year_id=s.current_school_year_id AND d.reversed_at IS NULL AND a.attendance_date>=d.effective_date)
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
  let conn, committed = false;
  try {
    conn = await connection.getConnection();
    await conn.beginTransaction();
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

    // Reuse the active year resolved by ownership middleware.
    // Never borrow another pool connection while holding a transaction.
    const activeSchoolYearId = req.advisorySection.schoolYearId;
    if (!activeSchoolYearId) {
      return res.status(400).json({ success: false, message: "No active school year is available." });
    }

    const [lockedStudents] = await conn.execute(`SELECT s.id FROM elem_students s JOIN classes c ON c.id=? AND c.grade_level_id=s.grade_level_id AND c.school_year_id=s.current_school_year_id
      WHERE s.id=? AND s.current_school_year_id=? AND s.is_deleted=0 AND s.status<>'graduated'
      AND (s.section_id=c.section_id OR (s.section_id IS NULL AND c.section_id IS NULL)) FOR UPDATE`, [classId,studentId,activeSchoolYearId]);
    if (!lockedStudents.length) return res.status(404).json({message:'Student is not in this advisory class.'});
    await require('./dropout.service').assertAttendanceAllowed(conn,studentId,activeSchoolYearId,date);
    const [[transfer]] = await conn.execute("SELECT DATE_FORMAT(joined_date,'%Y-%m-%d') AS joinedDate FROM student_transfer_ins WHERE student_id=? AND school_year_id=?",[studentId,activeSchoolYearId]);
    if (transfer && date < transfer.joinedDate) return res.status(409).json({message:'Attendance starts on the date the student joined this school.'});

    const [[todayRow]] = await conn.query(
      `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today`,
    );
    const today = todayRow?.today;
    if (!today || date > today) {
      return res.status(400).json({ success: false, message: "Attendance cannot be recorded for a future date." });
    }

    const activePeriodId = await getActiveGradingPeriodId(conn);
    const requestedPeriodId = term || activePeriodId;

    const [existingRows] = await conn.execute(
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

    const [periodRows] = await conn.execute(
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

    if (!existingPeriodId && date !== today && !transfer) {
      return res.status(400).json({ success: false, message: "New attendance can only be marked for today. Existing past marks may be edited." });
    }

    // Membership was already validated and locked above.

    if (status === null) {
      await conn.execute(
        `DELETE FROM advisory_attendance_records
         WHERE class_id = ? AND student_id = ? AND attendance_date = ?`,
        [classId, studentId, date],
      );
    } else if (existingPeriodId) {
      await conn.execute(
        `UPDATE advisory_attendance_records
         SET status = ?, recorded_by = ?
         WHERE class_id = ? AND student_id = ? AND attendance_date = ?`,
        [status, teacherId, classId, studentId, date],
      );

      await conn.commit(); committed = true;
      conn.release(); conn = null;

    } else {
      await conn.execute(
        `INSERT INTO advisory_attendance_records
           (section_id, class_id, grading_period_id, student_id, attendance_date, status, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status), grading_period_id = VALUES(grading_period_id), recorded_by = VALUES(recorded_by)`,
        [sectionId ?? null, classId, gradingPeriodId, studentId, date, status, teacherId],
      );

      await conn.commit(); committed = true;
      conn.release(); conn = null;



    }

    if (!committed) { await conn.commit(); committed = true; }
    if (conn) { conn.release(); conn = null; }
    const response = res.status(200).json({success:true,termId:gradingPeriodId?String(gradingPeriodId):null});
    if(status==='A')try{await notifyAbsence({studentId,date});}catch(error){console.error('Absence notification failed:',error.code||error.name);}
    if(!existingPeriodId&&status!==null)try{await notifyAttendanceComplete({classId,date});}catch(error){console.error('Attendance-complete notification failed:',error.code||error.name);}
    return response;
  } catch (error) {
    if (!error.status) console.error("Error saving advisory attendance:", error.code || error.name);
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.status ? error.message : "Internal server error." });
  } finally { if (conn) { if (!committed) await conn.rollback(); conn.release(); } }
};

module.exports = {
  loadAdvisoryClasses,
  requireOwnedClass,
  getAdvisorySectionsList,
  getAdvisoryAttendance,
  upsertAdvisoryAttendance,
};

const connection = require('../../../../config/db');

const ACTIVE_SY_SUBQUERY = '(SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)';

const getDashboardSummary = async (req, res) => {
  try {
    const authId = req.user?.userId;

    if (!authId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized: walang user ID na nakuha mula sa token.",
      });
    }

    const query = `
      SELECT teacher_table.first_name, teacher_table.last_name 
      FROM qed_authentication
      JOIN teacher_table ON qed_authentication.id = teacher_table.user_id
      WHERE qed_authentication.id = ?
    `;

    const [rows] = await connection.execute(query, [authId]);

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Teacher record not found.",
      });
    }

    const teacherName = `${rows[0].first_name} ${rows[0].last_name}`;

    return res.status(200).json({
      success: true,
      name: teacherName,
      classesToday: 4,
      pendingGrades: 14,
    });
  } catch (error) {
    console.error("Error fetching dashboard summary:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getDashboardStats = async (req, res) => {
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
      [authId]
    );

    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }

    const teacherId = teacherRows[0].id;

    // Only count subject-sections that belong to the currently active school year.
    const [totalClassesRows] = await connection.execute(
      `SELECT COUNT(*) AS totalClasses
       FROM \`subject-section\`
       WHERE teacher_id = ?
         AND status = 'Active'
         AND school_year_id = ${ACTIVE_SY_SUBQUERY}`,
      [teacherId]
    );

    // FIX: removed the old "LIMIT 1 on classes, then look up one section/grade level"
    // approach, which only ever considered the teacher's FIRST advisory class.
    // Now we join elem_students directly against ALL of the teacher's advisory
    // classes at once, so a teacher with multiple advisory sections gets the
    // correct combined count.
    //
    // Also added: exclude graduated students, and only count students who
    // belong to the currently active school year (via elem_students.current_school_year_id),
    // and only count advisory classes that belong to the active school year.
    const [advisoryCountRows] = await connection.execute(
      `SELECT COUNT(*) AS advisoryClassCount
       FROM elem_students st
       INNER JOIN classes c
         ON (
              (c.section_id IS NOT NULL AND st.section_id = c.section_id)
           OR (c.section_id IS NULL AND st.section_id IS NULL AND st.grade_level_id = c.grade_level_id)
            )
       WHERE c.class_adviser_id = ?
         AND st.is_deleted = 0
         AND st.status <> 'graduated'
         AND c.school_year_id = ${ACTIVE_SY_SUBQUERY}
         AND st.current_school_year_id = ${ACTIVE_SY_SUBQUERY}`,
      [teacherId]
    );

    const advisoryClassCount = advisoryCountRows[0].advisoryClassCount;

    const [totalStudentsRows] = await connection.execute(
      `SELECT COUNT(DISTINCT student_id) AS totalStudents
       FROM (
         -- Students reached via subject-sections this teacher teaches
         SELECT st.id AS student_id
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects sub ON sub.id = ss.subject_id
         INNER JOIN elem_students st
           ON st.is_deleted = 0
          AND st.status <> 'graduated'
          AND st.current_school_year_id = ${ACTIVE_SY_SUBQUERY}
          AND (
                (ss.section_id IS NOT NULL AND st.section_id = ss.section_id)
             OR (ss.section_id IS NULL AND st.section_id IS NULL AND st.grade_level_id = sub.grade_level_id)
              )
         WHERE ss.teacher_id = ?
           AND ss.status = 'Active'
           AND ss.school_year_id = ${ACTIVE_SY_SUBQUERY}

         UNION

         -- Students reached via this teacher's advisory roster (all advisory classes)
         SELECT st.id AS student_id
         FROM classes c
         INNER JOIN elem_students st
           ON st.is_deleted = 0
          AND st.status <> 'graduated'
          AND st.current_school_year_id = ${ACTIVE_SY_SUBQUERY}
          AND (
                (c.section_id IS NOT NULL AND st.section_id = c.section_id)
             OR (c.section_id IS NULL AND st.section_id IS NULL AND st.grade_level_id = c.grade_level_id)
              )
         WHERE c.class_adviser_id = ?
           AND c.school_year_id = ${ACTIVE_SY_SUBQUERY}
       ) combined`,
      [teacherId, teacherId]
    );

    return res.status(200).json({
      success: true,
      advisoryClassCount,
      totalStudents: totalStudentsRows[0].totalStudents,
      totalClasses: totalClassesRows[0].totalClasses,
    });
  } catch (error) {
    console.error("Error fetching dashboard stats:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getAttendanceSummary = async (req, res) => {
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
      [authId]
    );

    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }

    const teacherId = teacherRows[0].id;

    // FIX: removed LIMIT 1 — a teacher can have more than one advisory class,
    // so we need every advisory class id, not just the first one found.
    // Also restricted to advisory classes under the currently active school year.
    const [advisoryRows] = await connection.execute(
      `SELECT id FROM classes
       WHERE class_adviser_id = ?
         AND school_year_id = ${ACTIVE_SY_SUBQUERY}`,
      [teacherId]
    );

    if (advisoryRows.length === 0) {
      return res.status(200).json({ success: true, present: 0, absent: 0, late: 0 });
    }

    const classIds = advisoryRows.map((r) => r.id);
    const placeholders = classIds.map(() => "?").join(",");

    const [rows] = await connection.execute(
      `SELECT
         SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS present,
         SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) AS absent,
         SUM(CASE WHEN status = 'L' THEN 1 ELSE 0 END) AS late
       FROM advisory_attendance_records
       WHERE class_id IN (${placeholders})
         AND attendance_date = CURDATE()`,
      classIds
    );

    const row = rows[0] || {};

    return res.status(200).json({
      success: true,
      present: Number(row.present) || 0,
      absent: Number(row.absent) || 0,
      late: Number(row.late) || 0,
    });
  } catch (error) {
    console.error("Error fetching attendance summary:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getDateLabel = (dateInput) => {
  const toDateOnly = (value) => {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  };

  const eventDate = toDateOnly(dateInput);
  const today = toDateOnly(new Date());

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (eventDate.getTime() === today.getTime()) return "Today";
  if (eventDate.getTime() === tomorrow.getTime()) return "Tomorrow";

  return eventDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
};

const getUpcomingEvents = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 5;

    // Restricted to the currently active school year.
    const [rows] = await connection.query(
      `SELECT id, title, type, date, holiday_type
       FROM school_calendar
       WHERE date >= CURDATE()
         AND school_year_id = ${ACTIVE_SY_SUBQUERY}
       ORDER BY date ASC
       LIMIT ?`,
      [limit]
    );

    const events = rows.map((row) => ({
      id: row.id,
      title: row.title,
      type: row.type, // 'activity' | 'holiday'
      holidayType: row.holiday_type, // null if 'activity'
      date: row.date, // 'YYYY-MM-DD'
      dateLabel: getDateLabel(row.date), // "Today" | "Tomorrow"
    }));

    return res.status(200).json({ success: true, data: events });
  } catch (error) {
    console.error("Error fetching upcoming events:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch upcoming events",
    });
  }
};

// Convert 'HH:MM:SS' (MySQL TIME) -> '8:00 AM'
const formatTime = (timeStr) => {
  if (!timeStr) return "";
  const [h, m] = String(timeStr).split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
};

const getTodaysAgenda = async (req, res) => {
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
      [authId]
    );

    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }

    const teacherId = teacherRows[0].id;

    // Use Philippine time so the "today" is correct even if the DB/server runs in UTC.
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      timeZone: "Asia/Manila",
    });

    // class_schedule_day only has Monday-Friday, so weekends return an empty agenda.
    const [rows] = await connection.execute(
      `SELECT
         cs.id,
         cs.subject_name,
         cs.start_time,
         cs.end_time,
         c.room,
         gl.grade_level,
         gls.section_name
       FROM class_schedule cs
       INNER JOIN class_schedule_day csd ON csd.class_schedule_id = cs.id
       INNER JOIN classes c ON c.id = cs.class_id
       INNER JOIN grade_level gl ON gl.id = c.grade_level_id
       LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
       WHERE cs.subject_teacher_id = ?
         AND csd.day_of_week = ?
         AND c.status = 'Active'
         AND c.school_year_id = ${ACTIVE_SY_SUBQUERY}
       ORDER BY cs.start_time ASC`,
      [teacherId, today]
    );

    const agenda = rows.map((row) => ({
      id: row.id,
      subjectName: row.subject_name,
      className: row.section_name
        ? `${row.grade_level} - ${row.section_name}`
        : row.grade_level,
      room: row.room || null,
      startTime: row.start_time, // 'HH:MM:SS'
      endTime: row.end_time,
      timeLabel: `${formatTime(row.start_time)} - ${formatTime(row.end_time)}`,
    }));

    return res.status(200).json({
      success: true,
      day: today,
      count: agenda.length,
      data: agenda,
    });
  } catch (error) {
    console.error("Error fetching today's agenda:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = { getDashboardSummary, getDashboardStats, getAttendanceSummary,  getTodaysAgenda, getUpcomingEvents, getDateLabel };
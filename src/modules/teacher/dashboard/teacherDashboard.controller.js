const connection = require('../../../../config/db');

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

    const [totalClassesRows] = await connection.execute(
      `SELECT COUNT(*) AS totalClasses
       FROM \`subject-section\`
       WHERE teacher_id = ? AND status = 'Active'`,
      [teacherId]
    );

    const [totalStudentsRows] = await connection.execute(
      `SELECT COUNT(DISTINCT st.id) AS totalStudents
       FROM elem_students st
       INNER JOIN \`subject-section\` ss ON st.section_id = ss.section_id
       WHERE ss.teacher_id = ? AND ss.status = 'Active'`,
      [teacherId]
    );

    const [advisoryCountRows] = await connection.execute(
      `SELECT COUNT(*) AS advisoryClassCount
       FROM elem_students st
       INNER JOIN classes c
         ON st.section_id = c.section_id AND st.grade_level_id = c.grade_level_id
       WHERE c.class_adviser_id = ?`,
      [teacherId]
    );

    return res.status(200).json({
      success: true,
      advisoryClassCount: advisoryCountRows[0].advisoryClassCount,
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

    const [advisoryRows] = await connection.execute(
      `SELECT section_id FROM classes WHERE class_adviser_id = ? LIMIT 1`,
      [teacherId]
    );

    if (advisoryRows.length === 0) {
      return res.status(200).json({ success: true, present: 0, absent: 0, late: 0 });
    }

    const sectionId = advisoryRows[0].section_id;

    // Advisory attendance is recorded directly against the section in
    // `advisory_attendance_records` (one row per student per day) — this
    // used to incorrectly join through `attendance_records` /
    // `subject-section`, which tracks a separate, unrelated per-subject
    // attendance feature and had nothing to do with the advisory roster
    // the teacher actually marks on TeacherAttendancePage.
    const [rows] = await connection.execute(
      `SELECT
         SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS present,
         SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) AS absent,
         SUM(CASE WHEN status = 'L' THEN 1 ELSE 0 END) AS late
       FROM advisory_attendance_records
       WHERE section_id = ?
         AND attendance_date = CURDATE()`,
      [sectionId]
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
 
    const [rows] = await connection.query(
      `SELECT id, title, type, date, holiday_type
       FROM school_calendar
       WHERE date >= CURDATE()
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


module.exports = { getDashboardSummary, getDashboardStats, getAttendanceSummary, getUpcomingEvents, getDateLabel };
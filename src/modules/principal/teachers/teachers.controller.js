const connection = require("../../../../config/db");

function formatTime(sqlTime) {
  // sqlTime comes back like "07:30:00" — convert to "7:30 AM"
  if (!sqlTime) return "";
  const [hourStr, minuteStr] = sqlTime.split(":");
  let hour = parseInt(hourStr, 10);
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minuteStr} ${period}`;
}

function buildFullName(row) {
  const middle = row.middle_name ? ` ${row.middle_name}` : "";
  return `${row.first_name}${middle} ${row.last_name}`;
}

exports.getTeachersDirectory = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT
         t.id AS teacherId,
         t.first_name,
         t.middle_name,
         t.last_name,
         gl.grade_level,
         gls.section_name,
         c.room
       FROM teacher_table t
       LEFT JOIN classes c ON c.class_adviser_id = t.id
       LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
       LEFT JOIN grade_level gl ON gl.id = c.grade_level_id
       WHERE t.is_deleted = 0
       ORDER BY
         (c.class_adviser_id IS NULL) ASC,
         gl.id ASC,
         gls.section_name ASC,
         t.last_name ASC,
         t.first_name ASC`
    );

    const teachers = rows.map((row) => ({
      teacherId: String(row.teacherId),
      fullName: buildFullName(row),
      advisorySection: row.section_name || null,
      gradeLevel: row.grade_level || null,
      room: row.room || null,
    }));

    return res.status(200).json(teachers);
  } catch (error) {
    console.error("getTeachersDirectory error:", error);
    return res.status(500).json({ message: "Failed to fetch teachers." });
  }
}

exports.getTeacherProfile = async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ message: "Teacher id is required." });
  }

  try {
    const [teacherRows] = await connection.query(
      `SELECT 
         t.id AS teacherId,
         t.first_name,
         t.middle_name,
         t.last_name,
         gl.grade_level,
         gls.section_name,
         c.room
       FROM teacher_table t
       LEFT JOIN classes c ON c.class_adviser_id = t.id
       LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
       LEFT JOIN grade_level gl ON gl.id = c.grade_level_id
       WHERE t.id = ? AND t.is_deleted = 0
       LIMIT 1`,
      [id]
    );

    if (teacherRows.length === 0) {
      return res.status(404).json({ message: "Teacher not found." });
    }

    const teacher = teacherRows[0];

    const [scheduleRows] = await connection.query(
      `SELECT
         cs.subject_name,
         cs.start_time,
         cs.end_time,
         csd.day_of_week,
         gl.grade_level,
         gls.section_name,
         c.room
       FROM class_schedule cs
       JOIN classes c ON c.id = cs.class_id
       LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
       LEFT JOIN grade_level gl ON gl.id = c.grade_level_id
       LEFT JOIN class_schedule_day csd ON csd.class_schedule_id = cs.id
       WHERE cs.subject_teacher_id = ?
       ORDER BY FIELD(csd.day_of_week, 'Monday','Tuesday','Wednesday','Thursday','Friday'),
                cs.start_time`,
      [id]
    );

    const schedule = scheduleRows
      .filter((row) => row.day_of_week) // skip schedules with no day assigned yet
      .map((row) => ({
        day: row.day_of_week,
        time: `${formatTime(row.start_time)} - ${formatTime(row.end_time)}`,
        subject: row.subject_name,
        gradeSection: `${row.grade_level || ""} - ${row.section_name || ""}`,
        room: row.room || "—",
      }));

    return res.status(200).json({
      teacherId: String(teacher.teacherId),
      fullName: buildFullName(teacher),
      advisorySection: teacher.section_name || "—",
      gradeLevel: teacher.grade_level || "—",
      room: teacher.room || "—",
      schedule,
    });
  } catch (error) {
    console.error("getTeacherProfile error:", error);
    return res.status(500).json({ message: "Failed to fetch teacher profile." });
  }
}

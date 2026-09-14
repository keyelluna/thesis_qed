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

    // A teacher can be adviser to more than one class/section, which means
    // they can appear as multiple rows here (one per advisory class).
    // Since this is a directory of TEACHERS (not classes), group rows by
    // teacherId and collect their advisory sections into a list instead
    // of emitting duplicate teacher rows.
    const teacherMap = new Map();

    for (const row of rows) {
      const teacherId = String(row.teacherId);

      if (!teacherMap.has(teacherId)) {
        teacherMap.set(teacherId, {
          teacherId,
          fullName: buildFullName(row),
          advisories: [],
        });
      }

      // Only add an advisory entry if this row actually has one
      // (LEFT JOIN can produce a row with all-null class info for
      // teachers who aren't advisers to any class).
      if (row.section_name || row.grade_level || row.room) {
        teacherMap.get(teacherId).advisories.push({
          gradeLevel: row.grade_level || null,
          section: row.section_name || null,
          room: row.room || null,
        });
      }
    }

    const teachers = Array.from(teacherMap.values()).map((t) => {
      const primary = t.advisories[0] || {};
      return {
        teacherId: t.teacherId,
        fullName: t.fullName,
        // Keep these for backward compatibility with the table's existing columns
        // (shows the first/primary advisory)
        advisorySection: primary.section || null,
        gradeLevel: primary.gradeLevel || null,
        room: primary.room || null,
        // Full list, in case the UI wants to show "2 advisory sections" etc.
        advisories: t.advisories,
      };
    });

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
       WHERE t.id = ? AND t.is_deleted = 0`,
      [id]
    );

    if (teacherRows.length === 0) {
      return res.status(404).json({ message: "Teacher not found." });
    }

    const teacher = teacherRows[0];

    // Same multi-advisory situation applies here: a single teacher can have
    // multiple rows (one per advisory class). Collect them into a list.
    const advisories = teacherRows
      .filter((row) => row.section_name || row.grade_level || row.room)
      .map((row) => ({
        gradeLevel: row.grade_level || "—",
        section: row.section_name || "—",
        room: row.room || "—",
      }));

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

    const primary = advisories[0] || {};

    return res.status(200).json({
      teacherId: String(teacher.teacherId),
      fullName: buildFullName(teacher),
      advisorySection: primary.section || "—",
      gradeLevel: primary.gradeLevel || "—",
      room: primary.room || "—",
      advisories,
      schedule,
    });
  } catch (error) {
    console.error("getTeacherProfile error:", error);
    return res.status(500).json({ message: "Failed to fetch teacher profile." });
  }
}
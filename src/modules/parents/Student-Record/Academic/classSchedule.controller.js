const connection = require("../../../../../config/db");

const DAY_ABBREV = {
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
};

function formatTime(timeStr) {
  // timeStr comes from MySQL as "HH:MM:SS"
  if (!timeStr) return "";
  const [hourStr, minuteStr] = timeStr.split(":");
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr;
  const period = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${period}`;
}

const getClassSchedule = async (req, res) => {
  const { studentId } = req.params;

  try {
    const [rows] = await connection.query(
      `SELECT
     cs.id AS schedule_id,
     cs.subject_name,
     cs.start_time,
     cs.end_time,
     csd.day_of_week,
     t.first_name AS teacher_first_name,
     t.last_name AS teacher_last_name
   FROM elem_students es
   JOIN classes c
     ON (c.section_id = es.section_id
         OR (c.section_id IS NULL AND c.grade_level_id = es.grade_level_id))
   JOIN school_year sy
     ON sy.id = c.school_year_id AND sy.is_active = 1
   JOIN class_schedule cs ON cs.class_id = c.id
   JOIN class_schedule_day csd ON csd.class_schedule_id = cs.id
   LEFT JOIN teacher_table t
     ON t.id = cs.subject_teacher_id AND t.is_deleted = 0
   WHERE es.id = ?
     AND es.is_deleted = 0
     AND c.status = 'Active'
   ORDER BY cs.start_time ASC`,
      [studentId],
    );

    // Group rows by schedule_id since one class_schedule row can have multiple days
    const scheduleMap = new Map();

    for (const row of rows) {
      const dayAbbrev = DAY_ABBREV[row.day_of_week];
      if (!dayAbbrev) continue;

      if (!scheduleMap.has(row.schedule_id)) {
        scheduleMap.set(row.schedule_id, {
          id: String(row.schedule_id),
          subject: row.subject_name,
          teacher: row.teacher_first_name
            ? `${row.teacher_first_name} ${row.teacher_last_name}`.trim()
            : "TBA",
          startTime: formatTime(row.start_time),
          endTime: formatTime(row.end_time),
          days: [],
        });
      }

      scheduleMap.get(row.schedule_id).days.push(dayAbbrev);
    }

    const schedule = Array.from(scheduleMap.values());

    res.status(200).json(schedule);
  } catch (error) {
    console.error("getClassSchedule error:", error);
    res.status(500).json({ message: "Failed to fetch class schedule." });
  }
};

module.exports = { getClassSchedule };

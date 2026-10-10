const connection = require('../../config/db');

// Shared by the principal profile and the signed-in teacher dashboard.
async function getTeacherScheduleRows(teacherId, dayOfWeek = null) {
  const [rows] = await connection.query(
    `SELECT cs.id, cs.class_id, cs.subject_name, cs.start_time, cs.end_time,
            csd.day_of_week, gl.grade_level, gls.section_name, c.room
     FROM class_schedule cs
     JOIN classes c ON c.id = cs.class_id
     LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
     LEFT JOIN grade_level gl ON gl.id = c.grade_level_id
     JOIN class_schedule_day csd ON csd.class_schedule_id = cs.id
     WHERE cs.subject_teacher_id = ?
       AND c.school_year_id = (SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)
       ${dayOfWeek ? 'AND csd.day_of_week = ?' : ''}
     ORDER BY FIELD(csd.day_of_week, 'Monday','Tuesday','Wednesday','Thursday','Friday'),
              cs.start_time, cs.id`,
    dayOfWeek ? [teacherId, dayOfWeek] : [teacherId]
  );
  return rows;
}

module.exports = { getTeacherScheduleRows };

const connection = require("../../../../config/db");

/**
 * GET /getTodaysAttendance
 *
 * Source table: advisory_attendance_records
 *   status enum('P','A','L','E')
 *
 * Mapping (no dedicated "concerning" flag exists on the table, so this is
 * an assumption — adjust if the product definition differs):
 *   present    = count of 'P' (Present)
 *   absent     = count of 'A' (Absent)
 *   concerning = count of 'L' (Late) + 'E' (Excused) for today
 *
 * Response shape matches TodaysAttendance in data/types.ts:
 *   { present: number, absent: number, concerning: number }
 */
exports.getTodaysAttendance = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT
         SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS present,
         SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) AS absent,
         SUM(CASE WHEN status IN ('L', 'E') THEN 1 ELSE 0 END) AS concerning
       FROM advisory_attendance_records
       WHERE attendance_date = CURDATE()`
    );

    const row = rows[0] || {};

    return res.status(200).json({
      present: Number(row.present) || 0,
      absent: Number(row.absent) || 0,
      concerning: Number(row.concerning) || 0,
    });
  } catch (error) {
    console.error("getTodaysAttendance error:", error);
    return res.status(500).json({ message: "Failed to fetch today's attendance." });
  }
};

/**
 * GET /getAttendanceByGrade
 *
 * Attendance rate per grade level, for today's date, based on
 * advisory_attendance_records joined through classes -> grade_level.
 *
 * class_id is used (not section_id) because some advisory_attendance_records
 * rows have a NULL section_id but a populated class_id (see e.g. rows for
 * class_id 37 in the seed data).
 *
 * attendance = percentage of today's records for that grade with status = 'P'
 *
 * Response shape matches GradeAttendance[] in data/types.ts:
 *   [{ grade: string, attendance: number }, ...]
 */
exports.getAttendanceByGrade = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT
         gl.id AS gradeLevelId,
         gl.grade_level AS grade,
         ROUND(
           SUM(CASE WHEN aar.status = 'P' THEN 1 ELSE 0 END) / COUNT(*) * 100,
           1
         ) AS attendance
       FROM advisory_attendance_records aar
       JOIN classes c ON aar.class_id = c.id
       JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE aar.attendance_date = CURDATE()
       GROUP BY gl.id, gl.grade_level
       ORDER BY gl.id`
    );

    const attendanceByGrade = rows.map((row) => ({
      grade: row.grade,
      attendance: Number(row.attendance) || 0,
    }));

    return res.status(200).json(attendanceByGrade);
  } catch (error) {
    console.error("getAttendanceByGrade error:", error);
    return res.status(500).json({ message: "Failed to fetch attendance by grade." });
  }
};
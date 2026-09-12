// attendance.controller.js
const connection = require('../../.././../../config/db');

exports.getMyChildren = async (req, res) => {
  try {
    const authUserId = req.user?.userId; // <-- FIXED (dati req.user.id)

    if (!authUserId) {
      return res.status(401).json({ message: "Unauthorized." });
    }

    const [parentRows] = await connection.query(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0 LIMIT 1`,
      [authUserId]
    );

    if (parentRows.length === 0) {
      return res.status(404).json({ message: "Parent record not found." });
    }

    const parentId = parentRows[0].id;

    const [children] = await connection.query(
      `SELECT
         es.id,
         es.student_number,
         es.last_name,
         es.first_name,
         es.middle_name,
         gl.grade_level,
         gls.section_name
       FROM parent_student ps
       JOIN elem_students es ON es.id = ps.student_id
       LEFT JOIN grade_level gl ON gl.id = es.grade_level_id
       LEFT JOIN grade_level_sections gls ON gls.id = es.section_id
       WHERE ps.parent_id = ? AND es.is_deleted = 0`,
      [parentId]
    );

    return res.status(200).json({ children });
  } catch (error) {
    console.error("getMyChildren error:", error);
    return res.status(500).json({ message: "Failed to fetch children." });
  }
};

// ---- helper: generate every calendar month between start_date and end_date (inclusive) ----
function getMonthsInRange(startDate, endDate) {
  const months = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  // normalize to first day of month
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const last = new Date(end.getFullYear(), end.getMonth(), 1);

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  while (cursor <= last) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth(); // 0-indexed
    const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const monthLabel = `${monthNames[month]} ${year}`;
    months.push({ monthKey, monthLabel });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return months;
}

exports.getAttendanceSummary = async (req, res) => {
  try {
    const authUserId = req.user?.userId; // <-- FIXED (dati req.user.id)
    const { studentId } = req.params;

    if (!authUserId) {
      return res.status(401).json({ message: "Unauthorized." });
    }

    if (!studentId) {
      return res.status(400).json({ message: "studentId is required." });
    }

    const [parentRows] = await connection.query(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0 LIMIT 1`,
      [authUserId]
    );

    if (parentRows.length === 0) {
      return res.status(404).json({ message: "Parent record not found." });
    }

    const parentId = parentRows[0].id;

    const [ownershipRows] = await connection.query(
      `SELECT ps.student_id
       FROM parent_student ps
       WHERE ps.parent_id = ? AND ps.student_id = ?
       LIMIT 1`,
      [parentId, studentId]
    );

    if (ownershipRows.length === 0) {
      return res.status(403).json({ message: "You are not authorized to view this student's attendance." });
    }

    const [studentRows] = await connection.query(
      `SELECT
         es.id,
         es.first_name,
         es.last_name,
         es.middle_name,
         gl.grade_level,
         gls.section_name
       FROM elem_students es
       LEFT JOIN grade_level gl ON gl.id = es.grade_level_id
       LEFT JOIN grade_level_sections gls ON gls.id = es.section_id
       WHERE es.id = ? AND es.is_deleted = 0
       LIMIT 1`,
      [studentId]
    );

    if (studentRows.length === 0) {
      return res.status(404).json({ message: "Student not found." });
    }

    const student = studentRows[0];

    const [gradingPeriods] = await connection.query(
      `SELECT id, school_year_id, term_number, term_label, start_date, end_date, is_active
       FROM grading_periods
       ORDER BY term_number ASC`
    );

    const [attendanceRows] = await connection.query(
      `SELECT
         aar.grading_period_id,
         DATE_FORMAT(aar.attendance_date, '%Y-%m') AS month_key,
         SUM(CASE WHEN aar.status = 'P' THEN 1 ELSE 0 END) AS present_count,
         SUM(CASE WHEN aar.status = 'A' THEN 1 ELSE 0 END) AS absent_count,
         SUM(CASE WHEN aar.status = 'L' THEN 1 ELSE 0 END) AS tardiness_count,
         SUM(CASE WHEN aar.status = 'E' THEN 1 ELSE 0 END) AS excused_count,
         COUNT(*) AS total_days
       FROM advisory_attendance_records aar
       WHERE aar.student_id = ?
       GROUP BY aar.grading_period_id, month_key`,
      [studentId]
    );

    const gradingPeriods_withData = gradingPeriods.map((gp) => {
      // Lahat ng months sa loob ng start_date–end_date ng term na ito
      const allMonthsInTerm = getMonthsInRange(gp.start_date, gp.end_date);

      // I-map yung actual attendance data by month_key para mabilis i-lookup
      const attendanceByMonthKey = {};
      attendanceRows
        .filter((row) => row.grading_period_id === gp.id)
        .forEach((row) => {
          attendanceByMonthKey[row.month_key] = {
            present: Number(row.present_count),
            absent: Number(row.absent_count),
            tardiness: Number(row.tardiness_count),
            excused: Number(row.excused_count),
            totalDays: Number(row.total_days),
          };
        });

      // I-merge: kada month sa term, gamitin yung actual data kung meron,
      // kung wala, 0 lahat (walang record pa para dun sa buwan na yun)
      const months = allMonthsInTerm.map(({ monthKey, monthLabel }) => {
        const data = attendanceByMonthKey[monthKey] || {
          present: 0,
          absent: 0,
          tardiness: 0,
          excused: 0,
          totalDays: 0,
        };
        return {
          monthKey,
          monthLabel,
          ...data,
        };
      });

      const totals = months.reduce(
        (acc, m) => ({
          present: acc.present + m.present,
          absent: acc.absent + m.absent,
          tardiness: acc.tardiness + m.tardiness,
          excused: acc.excused + m.excused,
          totalDays: acc.totalDays + m.totalDays,
        }),
        { present: 0, absent: 0, tardiness: 0, excused: 0, totalDays: 0 }
      );

      return {
        gradingPeriodId: gp.id,
        termNumber: gp.term_number,
        termLabel: gp.term_label,
        startDate: gp.start_date,
        endDate: gp.end_date,
        isActive: !!gp.is_active,
        months,
        totals,
      };
    });

    return res.status(200).json({
      student: {
        id: student.id,
        firstName: student.first_name,
        lastName: student.last_name,
        middleName: student.middle_name,
        gradeLevel: student.grade_level,
        section: student.section_name,
      },
      gradingPeriods: gradingPeriods_withData,
    });
  } catch (error) {
    console.error("getAttendanceSummary error:", error);
    return res.status(500).json({ message: "Failed to fetch attendance summary." });
  }
};
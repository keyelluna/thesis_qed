const connection = require("../../../../../config/db");

/**
 * GET /api/attendance/monthly?student_id=101&month=1&year=2026
 *
 * Params (query):
 *   student_id - required, id from elem_students
 *   month      - required, 1-12
 *   year       - required, e.g. 2026
 *
 * Logic:
 *   - "School days" for the month = number of DISTINCT attendance_date
 *     na may record sa attendance_records (kahit anong section/subject),
 *     kasi yun ang basehan natin base sa sinabi mo (ilang beses nag-record
 *     ng attendance ang teacher sa loob ng buwan).
 *   - Status counts (P/A/L/E) = specific sa student_id na hiningi,
 *     bilang ng records niya per status sa loob ng month/year na yun.
 */
exports.getMonthlyAttendance = async (req, res) => {
  try {
    const { student_id, month, year } = req.query;

    // Validation
    if (!student_id || !month || !year) {
      return res.status(400).json({
        success: false,
        message: "student_id, month, at year ay required.",
      });
    }

    const monthNum = parseInt(month, 10);
    const yearNum = parseInt(year, 10);

    if (
      isNaN(monthNum) ||
      isNaN(yearNum) ||
      monthNum < 1 ||
      monthNum > 12
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid month or year.",
      });
    }

    // Check muna kung existing yung student (para may proper 404 kung wala)
    const [studentRows] = await connection.query(
      `SELECT id, student_number, last_name, first_name, middle_name, grade_level_id, section_id
       FROM elem_students
       WHERE id = ? AND is_deleted = 0`,
      [student_id]
    );

    if (studentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    const student = studentRows[0];

    // 1) Number of school days sa month/year na yun
    //    = distinct attendance_date na may record (kahit anong subject_section)
    const [schoolDaysRows] = await connection.query(
      `SELECT COUNT(DISTINCT attendance_date) AS school_days
       FROM attendance_records
       WHERE MONTH(attendance_date) = ? AND YEAR(attendance_date) = ?`,
      [monthNum, yearNum]
    );

    const schoolDays = schoolDaysRows[0].school_days || 0;

    // 2) Status counts (P, A, L, E) ng specific student sa month/year na yun
    const [statusRows] = await connection.query(
      `SELECT status, COUNT(*) AS total
       FROM attendance_records
       WHERE student_id = ?
         AND MONTH(attendance_date) = ?
         AND YEAR(attendance_date) = ?
       GROUP BY status`,
      [student_id, monthNum, yearNum]
    );

    // Default lahat sa 0 muna, tapos i-overwrite base sa query result
    const statusCounts = { P: 0, A: 0, L: 0, E: 0 };
    statusRows.forEach((row) => {
      statusCounts[row.status] = row.total;
    });

    const totalRecorded =
      statusCounts.P + statusCounts.A + statusCounts.L + statusCounts.E;

    return res.status(200).json({
      success: true,
      data: {
        student: {
          id: student.id,
          student_number: student.student_number,
          full_name: `${student.first_name} ${student.middle_name || ""} ${student.last_name}`.replace(/\s+/g, " ").trim(),
          grade_level_id: student.grade_level_id,
          section_id: student.section_id,
        },
        month: monthNum,
        year: yearNum,
        school_days: schoolDays,
        status_summary: {
          present: statusCounts.P,
          absent: statusCounts.A,
          late: statusCounts.L,
          excused: statusCounts.E,
        },
        total_records: totalRecorded,
      },
    });
  } catch (error) {
    console.error("getMonthlyAttendance error:", error);
    return res.status(500).json({
      success: false,
      message: "May error sa pag-kuha ng monthly attendance.",
    });
  }
};

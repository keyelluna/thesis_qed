const connection = require('../../../../config/db');

const getAdvisoryRoster = async (req, res) => {
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

    const [classRows] = await connection.execute(
      `SELECT gl.grade_level, gls.section_name, c.section_id, c.grade_level_id
       FROM classes c
       JOIN grade_level gl ON gl.id = c.grade_level_id
       LEFT JOIN grade_level_sections gls ON gls.id = c.section_id
       WHERE c.class_adviser_id = ? AND c.status = 'Active'
       AND c.school_year_id = (SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)
       ORDER BY c.id
       LIMIT 1`,
      [teacherId]
    );

    if (classRows.length === 0) {
      return res.status(200).json({
        success: true,
        gradeLevel: null,
        sectionName: null,
        students: [],
      });
    }

    const { grade_level, section_name, section_id, grade_level_id } = classRows[0];

    const [studentRows] = await connection.execute(
      `SELECT id, student_number, last_name, first_name, middle_name, gender
       FROM elem_students
       WHERE (section_id = ? OR (section_id IS NULL AND ? IS NULL AND grade_level_id = ?)) AND is_deleted = 0
       AND status <> 'graduated' AND current_school_year_id = (SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)
       ORDER BY last_name, first_name`,
      [section_id, section_id, grade_level_id]
    );

    return res.status(200).json({
      success: true,
      gradeLevel: grade_level,
      sectionName: section_name,
      students: studentRows,
    });
  } catch (error) {
    console.error("Error fetching advisory roster:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = { getAdvisoryRoster };
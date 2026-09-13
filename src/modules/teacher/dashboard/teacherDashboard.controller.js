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

    const [classRows] = await connection.execute(
      `SELECT c.section_id, c.grade_level_id
       FROM classes c
       WHERE c.class_adviser_id = ?
       LIMIT 1`,
      [teacherId]
    );

    let advisoryClassCount = 0;
    if (classRows.length > 0) {
      const { section_id: sectionId, grade_level_id: gradeLevelId } = classRows[0];
      const [advisoryCountRows] = sectionId
        ? await connection.execute(
            `SELECT COUNT(*) AS advisoryClassCount
             FROM elem_students
             WHERE section_id = ? AND is_deleted = 0`,
            [sectionId]
          )
        : await connection.execute(
            `SELECT COUNT(*) AS advisoryClassCount
             FROM elem_students
             WHERE grade_level_id = ? AND section_id IS NULL AND is_deleted = 0`,
            [gradeLevelId]
          );
      advisoryClassCount = advisoryCountRows[0].advisoryClassCount;
    }


    const [totalStudentsRows] = await connection.execute(
      `SELECT COUNT(DISTINCT student_id) AS totalStudents
       FROM (
         -- Students reached via subject-sections this teacher teaches
         SELECT st.id AS student_id
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects sub ON sub.id = ss.subject_id
         INNER JOIN elem_students st
           ON st.is_deleted = 0
          AND (
                (ss.section_id IS NOT NULL AND st.section_id = ss.section_id)
             OR (ss.section_id IS NULL AND st.section_id IS NULL AND st.grade_level_id = sub.grade_level_id)
              )
         WHERE ss.teacher_id = ? AND ss.status = 'Active'

         UNION

         -- Students reached via this teacher's advisory roster
         SELECT st.id AS student_id
         FROM classes c
         INNER JOIN elem_students st
           ON st.is_deleted = 0
          AND (
                (c.section_id IS NOT NULL AND st.section_id = c.section_id)
             OR (c.section_id IS NULL AND st.section_id IS NULL AND st.grade_level_id = c.grade_level_id)
              )
         WHERE c.class_adviser_id = ?
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

    const [advisoryRows] = await connection.execute(
      `SELECT id FROM classes WHERE class_adviser_id = ? LIMIT 1`,
      [teacherId]
    );

    if (advisoryRows.length === 0) {
      return res.status(200).json({ success: true, present: 0, absent: 0, late: 0 });
    }

    const classId = advisoryRows[0].id;

    const [rows] = await connection.execute(
      `SELECT
         SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS present,
         SUM(CASE WHEN status = 'A' THEN 1 ELSE 0 END) AS absent,
         SUM(CASE WHEN status = 'L' THEN 1 ELSE 0 END) AS late
       FROM advisory_attendance_records
       WHERE class_id = ?
         AND attendance_date = CURDATE()`,
      [classId]
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

module.exports = { getDashboardSummary, getDashboardStats, getAttendanceSummary };
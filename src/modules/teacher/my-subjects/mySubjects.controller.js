// teacherSubjectController.js
const connection = require('../../../../config/db');

exports.getAssignedSubjects = async (req, res) => {
  try {
    const userId = req.user?.userId; // galing sa JWT payload (qed_authentication.id)

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: walang user ID na nakuha mula sa token.',
      });
    }

    const [rows] = await connection.query(
      `SELECT 
          ss.id AS subject_section_id,
          es.id AS subject_id,
          es.subject_code,
          es.subject_name,
          gl.id AS grade_level_id,
          gl.grade_level,
          gls.id AS section_id,
          gls.section_name
       FROM \`subject-section\` ss
       INNER JOIN teacher_table tt ON ss.teacher_id = tt.id
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       INNER JOIN grade_level_sections gls ON ss.section_id = gls.id
       INNER JOIN grade_level gl ON es.grade_level_id = gl.id
       WHERE tt.user_id = ?
       ORDER BY gl.id ASC, gls.section_name ASC, es.subject_name ASC`,
      [userId]
    );

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error('Error fetching assigned subjects:', error);
    return res.status(500).json({
      success: false,
      message: 'Error sa pag-fetch ng assigned subjects.',
      error: error.message,
    });
  }
};
exports.getSubjectClassList = async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { subjectSectionId } = req.params;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: walang user ID na nakuha mula sa token.',
      });
    }

    if (!subjectSectionId || isNaN(Number(subjectSectionId))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid subject section ID.',
      });
    }

    // Verify this subject-section belongs to the requesting teacher, and
    // pull subject/grade/section info in the same pass.
    const [sectionRows] = await connection.query(
      `SELECT 
          ss.id AS subject_section_id,
          es.subject_name,
          gl.grade_level,
          gls.id AS section_id,
          gls.section_name
       FROM \`subject-section\` ss
       INNER JOIN teacher_table tt ON ss.teacher_id = tt.id
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       INNER JOIN grade_level_sections gls ON ss.section_id = gls.id
       INNER JOIN grade_level gl ON es.grade_level_id = gl.id
       WHERE ss.id = ? AND tt.user_id = ?`,
      [subjectSectionId, userId]
    );

    if (sectionRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Subject section not found or hindi ito assigned sa iyo.',
      });
    }

    const section = sectionRows[0];

    // Students enrolled in that grade_level_sections row — matches
    // elem_students.section_id, excluding soft-deleted records.
    const [studentRows] = await connection.query(
      `SELECT 
          s.id AS student_id,
          s.student_number,
          s.first_name,
          s.middle_name,
          s.last_name,
          s.gender
       FROM elem_students s
       WHERE s.section_id = ? AND s.is_deleted = 0
       ORDER BY s.last_name ASC, s.first_name ASC`,
      [section.section_id]
    );

    return res.status(200).json({
      success: true,
      data: {
        subject_name: section.subject_name,
        grade_level: section.grade_level,
        section_name: section.section_name,
        students: studentRows,
      },
    });
  } catch (error) {
    console.error('Error fetching subject class list:', error);
    return res.status(500).json({
      success: false,
      message: 'Error sa pag-fetch ng class list.',
      error: error.message,
    });
  }
};


const connection = require('../../../../config/db');

exports.getAssignedSubjects = async (req, res) => {
  try {
    const userId = req.user?.userId;

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
       LEFT JOIN grade_level_sections gls ON ss.section_id = gls.id
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


exports.getAssignedSubjectsWithStudents = async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: walang user ID na nakuha mula sa token.',
      });
    }

    // 1. All subject-sections this teacher is assigned to, across every
    // grade level. LEFT JOIN grade_level_sections so whole-grade
    // subjects (section_id NULL) aren't dropped.
    const [subjectSections] = await connection.query(
      `SELECT 
          ss.id AS subject_section_id,
          es.id AS subject_id,
          es.subject_code,
          es.subject_name,
          es.grade_level_id AS subject_grade_level_id,
          gl.grade_level,
          gls.id AS section_id,
          gls.section_name
       FROM \`subject-section\` ss
       INNER JOIN teacher_table tt ON ss.teacher_id = tt.id
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       LEFT JOIN grade_level_sections gls ON ss.section_id = gls.id
       INNER JOIN grade_level gl ON es.grade_level_id = gl.id
       WHERE tt.user_id = ?
       ORDER BY gl.id ASC, gls.section_name ASC, es.subject_name ASC`,
      [userId]
    );

    if (subjectSections.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
      });
    }

    const sectionedIds = [
      ...new Set(
        subjectSections
          .filter((s) => s.section_id !== null)
          .map((s) => s.section_id)
      ),
    ];
    const wholeGradeIds = [
      ...new Set(
        subjectSections
          .filter((s) => s.section_id === null)
          .map((s) => s.subject_grade_level_id)
      ),
    ];

    // 2. Batch-fetch rosters for fixed sections and whole-grade subjects
    // separately, only running each query if there's something to fetch.
    const [sectionStudents, gradeLevelStudents] = await Promise.all([
      sectionedIds.length
        ? connection
            .query(
              `SELECT 
                  s.id AS student_id,
                  s.section_id,
                  s.student_number,
                  s.first_name,
                  s.middle_name,
                  s.last_name,
                  s.gender
               FROM elem_students s
               WHERE s.section_id IN (?) AND s.is_deleted = 0
               ORDER BY s.last_name ASC, s.first_name ASC`,
              [sectionedIds]
            )
            .then(([rows]) => rows)
        : Promise.resolve([]),
      wholeGradeIds.length
        ? connection
            .query(
              `SELECT 
                  s.id AS student_id,
                  s.grade_level_id,
                  s.student_number,
                  s.first_name,
                  s.middle_name,
                  s.last_name,
                  s.gender
               FROM elem_students s
               WHERE s.grade_level_id IN (?) AND s.is_deleted = 0
               ORDER BY s.last_name ASC, s.first_name ASC`,
              [wholeGradeIds]
            )
            .then(([rows]) => rows)
        : Promise.resolve([]),
    ]);

    // 3. Group rosters for fast lookup while assembling the response.
    const studentsBySectionId = new Map();
    for (const student of sectionStudents) {
      if (!studentsBySectionId.has(student.section_id)) {
        studentsBySectionId.set(student.section_id, []);
      }
      studentsBySectionId.get(student.section_id).push(student);
    }

    const studentsByGradeLevelId = new Map();
    for (const student of gradeLevelStudents) {
      if (!studentsByGradeLevelId.has(student.grade_level_id)) {
        studentsByGradeLevelId.set(student.grade_level_id, []);
      }
      studentsByGradeLevelId.get(student.grade_level_id).push(student);
    }

    // 4. Assemble final response: one entry per subject-section, each
    // with its own distinct roster.
    const data = subjectSections.map((s) => {
      const students = s.section_id
        ? studentsBySectionId.get(s.section_id) || []
        : studentsByGradeLevelId.get(s.subject_grade_level_id) || [];

      return {
        subject_section_id: s.subject_section_id,
        subject_id: s.subject_id,
        subject_code: s.subject_code,
        subject_name: s.subject_name,
        grade_level: s.grade_level,
        section_name: s.section_name || null,
        student_count: students.length,
        students,
      };
    });

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error('Error fetching assigned subjects with students:', error);
    return res.status(500).json({
      success: false,
      message: 'Error sa pag-fetch ng assigned subjects with students.',
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


    const [sectionRows] = await connection.query(
      `SELECT 
          ss.id AS subject_section_id,
          ss.section_id,
          es.subject_name,
          es.grade_level_id AS subject_grade_level_id,
          gl.grade_level,
          gls.section_name
       FROM \`subject-section\` ss
       INNER JOIN teacher_table tt ON ss.teacher_id = tt.id
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       LEFT JOIN grade_level_sections gls ON ss.section_id = gls.id
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


    const [studentRows] = section.section_id
      ? await connection.query(
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
        )
      : await connection.query(
          `SELECT 
              s.id AS student_id,
              s.student_number,
              s.first_name,
              s.middle_name,
              s.last_name,
              s.gender
           FROM elem_students s
           WHERE s.grade_level_id = ? AND s.is_deleted = 0
           ORDER BY s.last_name ASC, s.first_name ASC`,
          [section.subject_grade_level_id]
        );

    return res.status(200).json({
      success: true,
      data: {
        subject_name: section.subject_name,
        grade_level: section.grade_level,
        section_name: section.section_name || null,
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
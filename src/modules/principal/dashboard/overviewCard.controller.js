const connection = require("../../../../config/db");

//========================== Attendance Rate ==========================

exports.getOverviewAttendance = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT
         ROUND(
           SUM(CASE WHEN aar.status = 'P' THEN 1 ELSE 0 END) / COUNT(*) * 100,
           1
         ) AS attendance
       FROM advisory_attendance_records aar
       JOIN grading_periods gp ON aar.grading_period_id = gp.id
       WHERE gp.is_active = 1`
    );

    return res.status(200).json({
      attendance: Number(rows[0]?.attendance) || 0,
    });
  } catch (error) {
    console.error("getOverviewAttendance error:", error);
    return res.status(500).json({ message: "Failed to fetch term attendance rate." });
  }
};

//========================== Overall Performance ==========================

async function getCurrentGradingPeriod() {
  const [rows] = await connection.query(
    `SELECT id, school_year_id, term_number, term_label, start_date, end_date
     FROM grading_periods
     WHERE is_active = 1
     LIMIT 1`
  );
  return rows.length ? rows[0] : null;
}

exports.getStudentAcademicPerformance = async (req, res) => {
  try {
    const { studentId } = req.params;

    if (!studentId) {
      return res.status(400).json({ success: false, message: "Kulang ang studentId." });
    }

    const currentTerm = await getCurrentGradingPeriod();
    if (!currentTerm) {
      return res.status(404).json({ success: false, message: "Walang active grading period sa ngayon." });
    }

    // Basic student info
    const [studentRows] = await connection.query(
      `SELECT id, student_number, last_name, first_name, middle_name,
              grade_level_id, section_id
       FROM elem_students
       WHERE id = ? AND is_deleted = 0`,
      [studentId]
    );

    if (!studentRows.length) {
      return res.status(404).json({ success: false, message: "Hindi nahanap ang estudyante." });
    }
    const student = studentRows[0];

    // Per-subject grades para sa current term
    const [subjectGrades] = await connection.query(
      `SELECT
          es.id            AS subject_id,
          es.subject_name,
          ss.id            AS subject_section_id,
          sgc.average,
          sgc.is_complete,
          sgc.updated_at
       FROM subject_grade_cache sgc
       INNER JOIN \`subject-section\` ss ON ss.id = sgc.subject_section_id
       INNER JOIN elem_subjects es ON es.id = ss.subject_id
       WHERE sgc.student_id = ?
         AND sgc.grading_period_id = ?
       ORDER BY es.subject_name ASC`,
      [studentId, currentTerm.id]
    );

    // Overall / advisory average para sa current term (kung meron)
    const [overallRows] = await connection.query(
      `SELECT overall_average, updated_at
       FROM advisory_overall_grades
       WHERE student_id = ?
         AND grading_period_id = ?
       LIMIT 1`,
      [studentId, currentTerm.id]
    );

    return res.status(200).json({
      success: true,
      term: currentTerm,
      student,
      overall_average: overallRows.length ? overallRows[0].overall_average : null,
      subjects: subjectGrades,
    });
  } catch (error) {
    console.error("getStudentAcademicPerformance error:", error);
    return res.status(500).json({ success: false, message: "May error sa server." });
  }
};

exports.getSectionAcademicPerformance = async (req, res) => {
  try {
    const { sectionId } = req.params;

    if (!sectionId) {
      return res.status(400).json({ success: false, message: "Kulang ang sectionId." });
    }

    const currentTerm = await getCurrentGradingPeriod();
    if (!currentTerm) {
      return res.status(404).json({ success: false, message: "Walang active grading period sa ngayon." });
    }

    const [sectionRows] = await connection.query(
      `SELECT id, section_name, grade_level_id
       FROM grade_level_sections
       WHERE id = ?`,
      [sectionId]
    );

    if (!sectionRows.length) {
      return res.status(404).json({ success: false, message: "Hindi nahanap ang section." });
    }
    const section = sectionRows[0];

    // Lahat ng grades ng section para sa current term, per student per subject
    const [rows] = await connection.query(
      `SELECT
          st.id            AS student_id,
          st.student_number,
          st.last_name,
          st.first_name,
          es.subject_name,
          sgc.average,
          sgc.is_complete
       FROM elem_students st
       INNER JOIN \`subject-section\` ss ON ss.section_id = st.section_id
       INNER JOIN elem_subjects es ON es.id = ss.subject_id
       LEFT JOIN subject_grade_cache sgc
              ON sgc.student_id = st.id
             AND sgc.subject_section_id = ss.id
             AND sgc.grading_period_id = ?
       WHERE st.section_id = ?
         AND st.is_deleted = 0
       ORDER BY st.last_name ASC, es.subject_name ASC`,
      [currentTerm.id, sectionId]
    );

    // I-group per student para mas madaling gamitin sa frontend
    const studentsMap = new Map();
    for (const row of rows) {
      if (!studentsMap.has(row.student_id)) {
        studentsMap.set(row.student_id, {
          student_id: row.student_id,
          student_number: row.student_number,
          last_name: row.last_name,
          first_name: row.first_name,
          subjects: [],
        });
      }
      studentsMap.get(row.student_id).subjects.push({
        subject_name: row.subject_name,
        average: row.average,
        is_complete: !!row.is_complete,
      });
    }

    return res.status(200).json({
      success: true,
      term: currentTerm,
      section,
      students: Array.from(studentsMap.values()),
    });
  } catch (error) {
    console.error("getSectionAcademicPerformance error:", error);
    return res.status(500).json({ success: false, message: "May error sa server." });
  }
};

exports.getSchoolWideAcademicPerformance = async (req, res) => {
  try {
    const currentTerm = await getCurrentGradingPeriod();
    if (!currentTerm) {
      return res.status(404).json({ success: false, message: "Walang active grading period sa ngayon." });
    }

    // Lahat ng grade levels
    const [gradeLevels] = await connection.query(
      `SELECT id, grade_level FROM grade_level ORDER BY id ASC`
    );

    // Lahat ng active sections
    const [sections] = await connection.query(
      `SELECT id, grade_level_id, section_name
       FROM grade_level_sections
       WHERE is_active = 1
       ORDER BY grade_level_id ASC, section_name ASC`
    );

    // Lahat ng estudyante + overall average sa current term (LEFT JOIN
    // para makasama pa rin yung wala pang grade / incomplete)
    const [students] = await connection.query(
      `SELECT
          st.id            AS student_id,
          st.student_number,
          st.last_name,
          st.first_name,
          st.grade_level_id,
          st.section_id,
          aog.overall_average,
          aog.updated_at
       FROM elem_students st
       LEFT JOIN advisory_overall_grades aog
              ON aog.student_id = st.id
             AND aog.grading_period_id = ?
       WHERE st.is_deleted = 0
       ORDER BY st.grade_level_id ASC, st.section_id ASC, st.last_name ASC`,
      [currentTerm.id]
    );

    // I-nest: grade level -> sections -> students (para "magkakasama" na
    // ang lahat pero organized pa rin)
    const gradeLevelMap = new Map(
      gradeLevels.map((gl) => [
        gl.id,
        { grade_level_id: gl.id, grade_level: gl.grade_level, sections: [] },
      ])
    );

    const sectionMap = new Map();
    for (const sec of sections) {
      const sectionEntry = {
        section_id: sec.id,
        section_name: sec.section_name,
        students: [],
      };
      sectionMap.set(sec.id, sectionEntry);
      const gl = gradeLevelMap.get(sec.grade_level_id);
      if (gl) gl.sections.push(sectionEntry);
    }

    // Kung may estudyanteng walang section (hal. NULL section_id),
    // ilagay sa isang "Unassigned" bucket para hindi mawala sa report.
    const unassigned = { section_id: null, section_name: "Unassigned", students: [] };

    for (const st of students) {
      const target = st.section_id && sectionMap.has(st.section_id)
        ? sectionMap.get(st.section_id)
        : unassigned;

      target.students.push({
        student_id: st.student_id,
        student_number: st.student_number,
        last_name: st.last_name,
        first_name: st.first_name,
        overall_average: st.overall_average,
      });
    }

    const gradeLevelsOutput = Array.from(gradeLevelMap.values());
    if (unassigned.students.length) {
      gradeLevelsOutput.push({
        grade_level_id: null,
        grade_level: "Unassigned",
        sections: [unassigned],
      });
    }

    return res.status(200).json({
      success: true,
      term: currentTerm,
      grade_levels: gradeLevelsOutput,
    });
  } catch (error) {
    console.error("getSchoolWideAcademicPerformance error:", error);
    return res.status(500).json({ success: false, message: "May error sa server." });
  }
};
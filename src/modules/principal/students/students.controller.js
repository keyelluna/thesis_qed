const connection = require("../../../../config/db");

function buildFullName({ first_name, middle_name, last_name }) {
  const middle = middle_name ? ` ${middle_name}` : "";
  return `${first_name}${middle} ${last_name}`;
}

// GET /grade-levels
// Powers PrincipalStudentsPage's grid — one row per grade level.
// Assumes 1 section per grade (elementary setup), matching ClassList's
// single sectionInfo shape.
// GET /grade-levels — dagdagan ng gradeId sa output
exports.getGradeLevels = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT
          gl.id AS gradeId,
          gl.grade_level AS grade,
          gls.section_name AS section,
          c.id AS classId,
          COUNT(es.id) AS totalStudents
       FROM grade_level gl
       JOIN classes c ON c.grade_level_id = gl.id
       JOIN grade_level_sections gls ON gls.id = c.section_id
       LEFT JOIN elem_students es
         ON es.grade_level_id = gl.id
         AND es.section_id = c.section_id
         AND es.is_deleted = 0
       GROUP BY gl.id, gls.id, c.id

       UNION ALL

       SELECT
          gl.id AS gradeId,
          gl.grade_level AS grade,
          NULL AS section,
          NULL AS classId,
          COUNT(es.id) AS totalStudents
       FROM grade_level gl
       LEFT JOIN elem_students es
         ON es.grade_level_id = gl.id
         AND es.section_id IS NULL
         AND es.is_deleted = 0
       WHERE NOT EXISTS (
         SELECT 1
         FROM classes c2
         JOIN grade_level_sections gls2 ON gls2.id = c2.section_id
         WHERE c2.grade_level_id = gl.id
       )
       GROUP BY gl.id

       ORDER BY gradeId`
    );

    const gradeLevels = rows
      .filter(r => r.section !== null || r.totalStudents > 0)
      .map((row) => ({
        gradeId: row.gradeId,
        grade: row.grade,
        section: row.section ?? null,
        classId: row.classId ?? null,
        totalStudents: Number(row.totalStudents),
      }));

    return res.json(gradeLevels);
  } catch (err) {
    console.error("getGradeLevels error:", err);
    return res.status(500).json({ message: "Failed to fetch grade levels." });
  }
};

// GET /grade/:gradeId/unassigned
// Powers ClassListPage for grades with no section record yet —
// shows students whose section_id is NULL under that grade.
exports.getUnassignedClassList = async (req, res) => {
  const { gradeId } = req.params;

  try {
    const [gradeRows] = await connection.query(
      `SELECT id, grade_level AS grade FROM grade_level WHERE id = ? LIMIT 1`,
      [gradeId]
    );

    if (gradeRows.length === 0) {
      return res.status(404).json({ message: "Grade level not found." });
    }

    const gradeRow = gradeRows[0];

    const [studentRows] = await connection.query(
      `SELECT
          es.student_number,
          es.last_name,
          es.first_name,
          es.middle_name,
          es.gender
       FROM elem_students es
       WHERE es.grade_level_id = ? AND es.section_id IS NULL AND es.is_deleted = 0
       ORDER BY es.last_name, es.first_name`,
      [gradeId]
    );

    const roster = studentRows.map((row) => ({
      studentId: row.student_number,
      lastName: row.last_name,
      firstName: row.first_name,
      middleInitial: row.middle_name ? `${row.middle_name.charAt(0)}.` : "",
      gender: row.gender,
    }));

    const classList = {
      classId: null,
      grade: gradeRow.grade,
      sectionInfo: {
        section: "Unassigned",
        adviser: "Unassigned",
        room: "",
      },
      roster,
    };

    return res.json(classList);
  } catch (err) {
    console.error("getUnassignedClassList error:", err);
    return res.status(500).json({ message: "Failed to fetch class list." });
  }
};
// GET /class-list/:grade
// Powers ClassListPage — sectionInfo + full roster for one grade.
exports.getClassList = async (req, res) => {
  const { classId } = req.params;

  try {
    const [classRows] = await connection.query(
      `SELECT
          c.id AS class_id,
          gl.grade_level AS grade,
          gls.section_name AS section,
          gls.id AS section_id,
          c.room AS room,
          t.first_name AS adviser_first_name,
          t.middle_name AS adviser_middle_name,
          t.last_name AS adviser_last_name
       FROM classes c
       JOIN grade_level gl ON gl.id = c.grade_level_id
       JOIN grade_level_sections gls ON gls.id = c.section_id
       LEFT JOIN teacher_table t ON t.id = c.class_adviser_id
       WHERE c.id = ?
       LIMIT 1`,
      [classId]
    );

    if (classRows.length === 0) {
      return res.status(404).json({ message: "Class not found." });
    }

    const classRow = classRows[0];

    const adviser = classRow.adviser_first_name
      ? buildFullName({
          first_name: classRow.adviser_first_name,
          middle_name: classRow.adviser_middle_name,
          last_name: classRow.adviser_last_name,
        })
      : "Unassigned";

    const [studentRows] = await connection.query(
      `SELECT
          es.student_number,
          es.last_name,
          es.first_name,
          es.middle_name,
          es.gender
       FROM elem_students es
       WHERE es.section_id = ? AND es.is_deleted = 0
       ORDER BY es.last_name, es.first_name`,
      [classRow.section_id]
    );

    const roster = studentRows.map((row) => ({
      studentId: row.student_number,
      lastName: row.last_name,
      firstName: row.first_name,
      middleInitial: row.middle_name ? `${row.middle_name.charAt(0)}.` : "",
      gender: row.gender,
    }));

    const classList = {
      classId: classRow.class_id,
      grade: classRow.grade,
      sectionInfo: {
        section: classRow.section,
        adviser,
        room: classRow.room || "",
      },
      roster,
    };

    return res.json(classList);
  } catch (err) {
    console.error("getClassList error:", err);
    return res.status(500).json({ message: "Failed to fetch class list." });
  }
};
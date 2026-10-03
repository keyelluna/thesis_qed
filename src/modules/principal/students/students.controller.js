const connection = require("../../../../config/db");

function buildFullName({ first_name, middle_name, last_name }) {
  const middle = middle_name ? ` ${middle_name}` : "";
  return `${first_name}${middle} ${last_name}`;
}

// Id ng active school year (null kung wala)
async function getActiveSchoolYearId() {
  const [rows] = await connection.query(
    `SELECT id FROM school_year WHERE is_active = 1 ORDER BY id DESC LIMIT 1`
  );
  return rows.length ? rows[0].id : null;
}

// GET /total-students
// Lahat ng enrolled sa current school year, hindi kasama ang deleted at graduated.
// Hindi nakadepende sa section, kaya kasama pati walang section_id.
exports.getTotalStudents = async (req, res) => {
  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.json({ total: 0 });
    }

    const [[row]] = await connection.query(
      `SELECT COUNT(*) AS total
       FROM elem_students
       WHERE is_deleted = 0
         AND status <> 'graduated'
         AND current_school_year_id = ?`,
      [schoolYearId]
    );

    return res.json({ total: Number(row.total) || 0 });
  } catch (err) {
    console.error("getTotalStudents error:", err);
    return res.status(500).json({ message: "Failed to fetch total students." });
  }
};

// GET /grade-levels
// Powers PrincipalStudentsPage's grid, isang row per grade level.
// Current school year lang, at walang deleted o graduated na estudyante.
exports.getGradeLevels = async (req, res) => {
  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.json([]);
    }

    const [rows] = await connection.query(
      `SELECT
          gl.id AS gradeId,
          gl.grade_level AS grade,
          gls.section_name AS section,
          c.id AS classId,
          COUNT(es.id) AS totalStudents
       FROM grade_level gl
       JOIN classes c
         ON c.grade_level_id = gl.id
        AND c.school_year_id = ?
       JOIN grade_level_sections gls
         ON gls.id = c.section_id
        AND gls.school_year_id = ?
       LEFT JOIN elem_students es
         ON es.grade_level_id = gl.id
        AND es.section_id = c.section_id
        AND es.is_deleted = 0
        AND es.status <> 'graduated'
        AND es.current_school_year_id = ?
       GROUP BY gl.id, gls.id, c.id

       UNION ALL

       -- Estudyanteng walang section (section_id NULL), per grade level.
       -- Walang NOT EXISTS para hindi mawala kahit may sections na ang grade.
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
        AND es.status <> 'graduated'
        AND es.current_school_year_id = ?
       GROUP BY gl.id

       ORDER BY gradeId`,
      [schoolYearId, schoolYearId, schoolYearId, schoolYearId]
    );

    const gradeLevels = rows
      .filter((r) => r.section !== null || r.totalStudents > 0)
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
// Estudyante ng grade na walang section (section_id NULL),
// current school year lang, walang deleted at graduated.
exports.getUnassignedClassList = async (req, res) => {
  const { gradeId } = req.params;

  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(404).json({ message: "No active school year." });
    }

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
       WHERE es.grade_level_id = ?
         AND es.section_id IS NULL
         AND es.is_deleted = 0
         AND es.status <> 'graduated'
         AND es.current_school_year_id = ?
       ORDER BY es.last_name, es.first_name`,
      [gradeId, schoolYearId]
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

// GET /class-list/:classId
// sectionInfo + full roster ng isang class (current school year lang).
exports.getClassList = async (req, res) => {
  const { classId } = req.params;

  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(404).json({ message: "No active school year." });
    }

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
         AND c.school_year_id = ?
       LIMIT 1`,
      [classId, schoolYearId]
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
       WHERE es.section_id = ?
         AND es.is_deleted = 0
         AND es.status <> 'graduated'
         AND es.current_school_year_id = ?
       ORDER BY es.last_name, es.first_name`,
      [classRow.section_id, schoolYearId]
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
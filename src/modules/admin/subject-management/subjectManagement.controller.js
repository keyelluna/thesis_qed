const connection = require("../../../../config/db");

exports.getSubjectSectionsByGrade = async (req, res) => {
  const { gradeLevel } = req.params;

  try {
const query = `
  SELECT 
    ss.id             AS id,
    es.subject_name   AS subject_name,
    es.grade_level_id AS grade_level_id,
    es.is_graded      AS is_graded,
    gls.section_name  AS section_name,
    ss.teacher_id     AS teacher_id,
    sy.school_year    AS school_year,
    ss.status         AS status
  FROM \`subject-section\` ss
  JOIN elem_subjects es        ON es.id = ss.subject_id
  LEFT JOIN grade_level_sections gls ON gls.id = ss.section_id
  JOIN school_year sy          ON sy.id = ss.school_year_id
  WHERE es.grade_level_id = ?
    AND sy.is_active = 1
  ORDER BY es.subject_name ASC
`;

    const [rows] = await connection.query(query, [gradeLevel]);

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

exports.getSubjectsByGrade = async (req, res) => {
  const { gradeLevel } = req.params;

  try {
    const subjectsQuery = `
      SELECT 
        id,
        subject_name,
        grade_level_id
      FROM elem_subjects
      WHERE grade_level_id = ?
    `;

    const [rows] = await connection.query(subjectsQuery, [gradeLevel]);

    res.status(200).json({
      success: true,
      data: rows,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

// Bagong function: para lang sa "Add Subject" modal — grade level + subject name lang
// ang nase-save, diretso sa elem_subjects (catalog). Hiwalay ito sa addSubjectSection,
// na siyang nag-a-assign ng subject sa isang section+teacher+school year.
exports.addSubject = async (req, res) => {
  const { gradeLevelId, subjectName, isGraded, schoolYear } = req.body;

  if (!gradeLevelId || !subjectName) {
    return res.status(400).json({
      success: false,
      message: "gradeLevelId and subjectName are required.",
    });
  }

  try {
    // Guard: baka meron nang ganitong subject sa parehong grade level
    const [existing] = await connection.query(
      `SELECT id FROM elem_subjects WHERE subject_name = ? AND grade_level_id = ? LIMIT 1`,
      [subjectName, gradeLevelId]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: `"${subjectName}" already exists for this grade level.`,
      });
    }

    const [result] = await connection.query(
      `INSERT INTO elem_subjects (subject_name, grade_level_id, is_graded) VALUES (?, ?, ?)`,
      [subjectName, gradeLevelId, isGraded]
    );

    return res.status(201).json({
      success: true,
      message: "Subject added successfully.",
      data: {
        id: result.insertId,
        subject_name: subjectName,
        grade_level_id: gradeLevelId,
        is_graded: isGraded,
        schoolYear: schoolYear ?? null,
        status: "Active",
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

// exports.addSubjectSection = async (req, res) => {
//   const {
//     gradeLevelId,
//     subjectName,
//     sectionName,
//     teacherId,
//     schoolYear,
//     status = "Active",
//   } = req.body;

//   if (!gradeLevelId || !subjectName || !sectionName || !schoolYear) {
//     return res.status(400).json({
//       success: false,
//       message: "gradeLevelId, subjectName, sectionName, and schoolYear are required.",
//     });
//   }

//   const conn = await connection.execute();

//   try {
//     await conn.beginTransaction();

//     const [subjectRows] = await conn.query(
//       `SELECT id FROM elem_subjects WHERE subject_name = ? AND grade_level_id = ?`,
//       [subjectName, gradeLevelId]
//     );
//     if (subjectRows.length === 0) {
//       await conn.rollback();
//       return res.status(404).json({
//         success: false,
//         message: `Subject "${subjectName}" not found for this grade level.`,
//       });
//     }
//     const subjectId = subjectRows[0].id;

//     const [sectionRows] = await conn.query(
//       `SELECT id FROM grade_level_sections WHERE section_name = ? AND grade_level_id = ? AND is_active = 1 LIMIT 1`,
//       [sectionName, gradeLevelId]
//     );
//     if (sectionRows.length === 0) {
//       await conn.rollback();
//       return res.status(404).json({
//         success: false,
//         message: `Section "${sectionName}" not found for this grade level.`,
//       });
//     }
//     const sectionId = sectionRows[0].id;

//     const [syRows] = await conn.query(
//       `SELECT id FROM school_year WHERE school_year = ? LIMIT 1`,
//       [schoolYear]
//     );
//     if (syRows.length === 0) {
//       await conn.rollback();
//       return res.status(404).json({
//         success: false,
//         message: `School year "${schoolYear}" not found.`,
//       });
//     }
//     const schoolYearId = syRows[0].id;

//     const [existing] = await conn.query(
//       `SELECT id FROM \`subject-section\`
//        WHERE subject_id = ? AND section_id = ? AND school_year_id = ? LIMIT 1`,
//       [subjectId, sectionId, schoolYearId]
//     );
//     if (existing.length > 0) {
//       await conn.rollback();
//       return res.status(409).json({
//         success: false,
//         message: `"${subjectName}" is already assigned to section "${sectionName}" for ${schoolYear}.`,
//       });
//     }

//     const [result] = await conn.query(
//       `INSERT INTO \`subject-section\`
//          (subject_id, section_id, teacher_id, school_year_id, status)
//        VALUES (?, ?, ?, ?, ?)`,
//       [subjectId, sectionId, teacherId ?? 0, schoolYearId, status]
//     );

//     await conn.commit();

//     return res.status(201).json({
//       success: true,
//       message: "Subject assigned to section successfully.",
//       data: {
//         id: result.insertId,
//         subject_id: subjectId,
//         section_id: sectionId,
//         teacher_id: teacherId,
//         school_year_id: schoolYearId,
//         status,
//       },
//     });
//   } catch (error) {
//     await conn.rollback();
//     console.error("Database Error:", error);
//     res.status(500).json({
//       success: false,
//       message: "Database error occurred.",
//     });
//   } finally {
//     conn.release();
//   }
// };

exports.updateSubjectSection = async (req, res) => {
  const { id } = req.params;
  const { isGraded } = req.body;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Subject assignment id is required.",
    });
  }

  if (typeof isGraded !== "boolean") {
    return res.status(400).json({
      success: false,
      message: "isGraded is required.",
    });
  }

  try {
    const [existingRows] = await connection.query(
      `SELECT subject_id FROM \`subject-section\` WHERE id = ? LIMIT 1`,
      [id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Subject assignment not found.",
      });
    }
    const subjectId = existingRows[0].subject_id;

    await connection.query(
      `UPDATE elem_subjects SET is_graded = ? WHERE id = ?`,
      [isGraded, subjectId]
    );

    return res.status(200).json({
      success: true,
      message: "Subject updated successfully.",
      data: {
        id: Number(id),
        subject_id: subjectId,
        is_graded: isGraded,
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

exports.assignTeacherToSection = async (req, res) => {
  const { id } = req.params;
  const { gradeLevelId, sectionName, teacherId } = req.body;

  if (!gradeLevelId || !sectionName) {
    return res.status(400).json({
      success: false,
      message: "gradeLevelId and sectionName are required.",
    });
  }

  try {
    const [existingRows] = await connection.query(
      `SELECT id FROM \`subject-section\` WHERE id = ? LIMIT 1`,
      [id]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Subject assignment not found.",
      });
    }

    const [sectionRows] = await connection.query(
      `SELECT id FROM grade_level_sections WHERE section_name = ? AND grade_level_id = ? AND is_active = 1 LIMIT 1`,
      [sectionName, gradeLevelId]
    );
    if (sectionRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Section "${sectionName}" not found for this grade level.`,
      });
    }
    const sectionId = sectionRows[0].id;

    await connection.query(
      `UPDATE \`subject-section\` SET section_id = ?, teacher_id = ? WHERE id = ?`,
      [sectionId, teacherId ?? 0, id]
    );

    return res.status(200).json({
      success: true,
      message: "Teacher assigned successfully.",
      data: {
        id: Number(id),
        section_id: sectionId,
        teacher_id: teacherId,
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};

exports.toggleSubjectStatus = async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({
      success: false,
      message: "Subject assignment id is required.",
    });
  }

  try {
    const [existingRows] = await connection.query(
      `SELECT id, status FROM \`subject-section\` WHERE id = ? LIMIT 1`,
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Subject assignment not found.",
      });
    }

    const currentStatus = existingRows[0].status;
    const newStatus = currentStatus === "Active" ? "Inactive" : "Active";

    await connection.query(
      `UPDATE \`subject-section\` SET status = ? WHERE id = ?`,
      [newStatus, id]
    );

    return res.status(200).json({
      success: true,
      message: `Subject ${newStatus === "Active" ? "activated" : "deactivated"} successfully.`,
      data: {
        id: Number(id),
        status: newStatus,
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};
const connection = require("../../../../config/db");

//search children via student number, and name
exports.getChildren = async (req, res) => {
  const {
    studentNumber,
    lastName,
    firstName,
    middleName,
    gradeLevel,
    section,
    adviser,
  } = req.body;

  if (!studentNumber || !lastName || !firstName) {
    return res.status(400).json({
      success: false,
      message: "Input required fields",
    });
  }

  try {
    const query = `
  SELECT 
    elem_students.id,
    elem_students.student_number,
    elem_students.last_name,
    elem_students.first_name,
    elem_students.middle_name,
    grade_level.grade_level,
    grade_level_sections.section_name,
    CONCAT(teacher_table.first_name, ' ', teacher_table.last_name) AS adviser_name
  FROM elem_students
  INNER JOIN grade_level 
    ON elem_students.grade_level_id = grade_level.id
  INNER JOIN grade_level_sections 
    ON elem_students.section_id = grade_level_sections.id
  LEFT JOIN classes 
    ON grade_level_sections.id = classes.section_id
  LEFT JOIN teacher_table 
    ON classes.class_adviser_id = teacher_table.id
  WHERE elem_students.student_number = ?
    AND LOWER(elem_students.last_name) = LOWER(?)
    AND LOWER(elem_students.first_name) = LOWER(?)
`;
    const [rows] = await connection.query(query, [
      studentNumber,
      lastName,
      firstName,
    ]);

    if (rows.length > 0) {
      return res.status(200).json({
        success: true,
        message: "Information Matched!",
        student: rows[0],
      });
    } else {
      return res.status(401).json({
        success: false,
        message: "No information matched",
      });
    }
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error!",
    });
  }
};

//if student matched, linked it to user
exports.linkedChildren = async (req, res) => {
  const parentUserId = req.user?.userId;
  const { studentNumber, lastName, firstName } = req.body;

  if (!parentUserId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  if (!studentNumber || !lastName || !firstName) {
    return res.status(400).json({
      success: false,
      message: "Input required fields",
    });
  }

  const dbConn = await connection.getConnection();

  try {
    await dbConn.beginTransaction();

    const [parentRows] = await dbConn.query(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
      [parentUserId]
    );

    if (parentRows.length === 0) {
      await dbConn.rollback();
      return res.status(404).json({
        success: false,
        message: "Parent record not found",
      });
    }
    const parentId = parentRows[0].id;

    const [studentRows] = await dbConn.query(
      `SELECT id, student_number FROM elem_students
       WHERE student_number = ?
         AND LOWER(last_name) = LOWER(?)
         AND LOWER(first_name) = LOWER(?)
         AND is_deleted = 0`,
      [studentNumber, lastName, firstName]
    );

    if (studentRows.length === 0) {
      await dbConn.rollback();
      return res.status(404).json({
        success: false,
        message: "No student matched",
      });
    }

    const student = studentRows[0];

    const [existingLink] = await dbConn.query(
      `SELECT * FROM parent_student WHERE student_id = ?`,
      [student.id]
    );

    if (existingLink.length > 0) {
      await dbConn.rollback();
      return res.status(409).json({
        success: false,
        message: "Student already linked to a parent",
      });
    }

    await dbConn.query(
      `INSERT INTO parent_student (parent_id, student_id) VALUES (?, ?)`,
      [parentId, student.id]
    );

    await dbConn.commit();

    return res.status(200).json({
      success: true,
      message: "Student successfully linked",
    });
  } catch (error) {
    await dbConn.rollback();
    console.error("Database error:", error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "Student already linked to a parent",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error!",
    });
  } finally {
    dbConn.release();
  }
};

//get linked children
exports.getEnrolledChildren = async (req, res) => {
  const parentUserId = req.user?.userId;

  if (!parentUserId) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  }

  try {
    // get parent_table id from logged-in user
    const [parentRows] = await connection.query(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
      [parentUserId]
    );

    if (parentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Parent record not found",
      });
    }

    const parentId = parentRows[0].id;

    const query = `
      SELECT 
        elem_students.id,
        elem_students.student_number,
        elem_students.learner_reference_number,
        elem_students.last_name,
        elem_students.first_name,
        elem_students.middle_name,
        elem_students.gender,
        grade_level.grade_level,
        grade_level_sections.section_name,
        CONCAT(teacher_table.first_name, ' ', teacher_table.last_name) AS adviser_name
      FROM parent_student
      INNER JOIN elem_students 
        ON parent_student.student_id = elem_students.id
      LEFT JOIN grade_level 
        ON elem_students.grade_level_id = grade_level.id
      LEFT JOIN grade_level_sections 
        ON elem_students.section_id = grade_level_sections.id
      LEFT JOIN classes 
        ON grade_level_sections.id = classes.section_id
      LEFT JOIN teacher_table 
        ON classes.class_adviser_id = teacher_table.id
      WHERE parent_student.parent_id = ?
        AND elem_students.is_deleted = 0
    `;

    const [rows] = await connection.execute(query, [parentId]);

    return res.status(200).json({
      success: true,
      message: rows.length > 0 ? "Linked students retrieved" : "No linked students found",
      students: rows,
    });
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error!",
    });
  }
};
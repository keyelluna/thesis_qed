const connection = require("../../../../config/db");

// ADD NEW STUDENT
exports.addNewStudent = async (req, res) => {
  const {
    studentId,
    lastName,
    firstName,
    middleName,
    lrn,
    gender,
    gradeLevel,
    section,
  } = req.body;

  const sectionId = section ? section : null;

  try {
    const [activeSY] = await connection.query(
      `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`
    );

    if (activeSY.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No active school year found. Please set an active school year first.",
      });
    }

    const currentSchoolYearId = activeSY[0].id;

    const studentQuery = `
        INSERT INTO elem_students
        (student_number, last_name, first_name, middle_name, learner_reference_number, gender, grade_level_id, section_id, current_school_year_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await connection.query(studentQuery, [
      studentId,
      lastName,
      firstName,
      middleName,
      lrn,
      gender,
      gradeLevel,
      sectionId,
      currentSchoolYearId,
      "active",
    ]);

    res.status(201).json({
      success: true,
      message: "Student record created successfully!",
      data: { id: result.insertId },
    });
  } catch (error) {
    console.error("Database Error:", error);

    if (error.code === "ER_DUP_ENTRY") {
      const message = error.sqlMessage || error.message || "";

      if (message.includes("student_number")) {
        return res.status(409).json({
          success: false,
          message: "Student ID number must be unique.",
        });
      }

      if (message.includes("learner_reference_number")) {
        return res.status(409).json({
          success: false,
          message: "LRN must be unique.",
        });
      }

      return res.status(409).json({
        success: false,
        message: "Duplicate entry detected.",
      });
    }

    return res
      .status(500)
      .json({ success: false, message: "Database error." });
  }
};


exports.updateStudent = async (req, res) => {
  const { id } = req.params;
  const {
    studentId,
    lastName,
    firstName,
    middleName,
    lrn,
    gender,
    gradeLevel,
    section,
  } = req.body;

  const sectionId = section ? section : null;

  try {
    // Check kung may ibang student (maliban sa kasalukuyang id) na may parehong student_number o lrn
    const checkQuery = `
      SELECT id, student_number, learner_reference_number FROM elem_students 
      WHERE (student_number = ? OR learner_reference_number = ?) AND id != ?
    `;
    const [existing] = await connection.query(checkQuery, [studentId, lrn, id]);

    if (existing.length > 0) {
      const duplicateStudentNumber = existing.some(
        (row) => row.student_number === studentId
      );
      const duplicateLrn = existing.some(
        (row) => row.learner_reference_number === lrn
      );

      let message = "";
      if (duplicateStudentNumber && duplicateLrn) {
        message = "Student number and LRN already exist. Please use unique values.";
      } else if (duplicateStudentNumber) {
        message = "Student number already exists. Please use a unique student number.";
      } else if (duplicateLrn) {
        message = "LRN already exists. Please use a unique LRN.";
      }

      return res.status(400).json({
        success: false,
        message,
      });
    }

    const studentQuery = `
      UPDATE elem_students 
      SET student_number = ?, last_name = ?, first_name = ?, middle_name = ?, learner_reference_number = ?, gender = ?, grade_level_id = ?, section_id = ? WHERE id = ?
    `;

    await connection.query(studentQuery, [
      studentId,
      lastName,
      firstName,
      middleName,
      lrn,
      gender,
      gradeLevel,
      sectionId,
      id,
    ]);

    res.status(200).json({
      success: true,
      message: "Student record updated successfully!",
    });
  } catch (error) {
    // Backup check: kung may UNIQUE constraint sa DB level at nadaanan pa rin
    if (error.code === "ER_DUP_ENTRY") {
      // Tingnan kung anong column ang na-violate base sa error message
      let message = "Duplicate entry found. Please use unique values.";
      if (error.sqlMessage?.includes("student_number")) {
        message = "Student number already exists. Please use a unique student number.";
      } else if (error.sqlMessage?.includes("learner_reference_number")) {
        message = "LRN already exists. Please use a unique LRN.";
      }

      return res.status(400).json({
        success: false,
        message,
      });
    }

    console.error("Database Error:", error);
    res
      .status(500)
      .json({ success: false, message: "Database error occurred." });
  }
};

// GET STUDENT BY ID (View Student Info)
exports.getStudentById = async (req, res) => {
  const { id } = req.params;

  try {
    const studentQuery = `
      SELECT 
        id,
        student_number,
        last_name,
        first_name,
        middle_name,
        learner_reference_number,
        gender,
        grade_level_id,
        section_id,
        parent_guardian_name
      FROM elem_students
      WHERE id = ? AND is_deleted = 0
    `;

    const [rows] = await connection.query(studentQuery, [id]);

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    res.status(200).json({
      success: true,
      data: rows[0],
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};


exports.getAllStudents = async (req, res) => {
    try {
        const query = `
            SELECT 
                s.*,
                gl.grade_level AS grade_level_name,
                sec.section_name
            FROM elem_students s
            LEFT JOIN grade_level gl ON s.grade_level_id = gl.id
            LEFT JOIN grade_level_sections sec ON s.section_id = sec.id
            JOIN school_year sy ON sy.id = s.current_school_year_id
            WHERE s.is_deleted = 0
              AND sy.is_active = 1
              AND s.status != 'graduated'
            ORDER BY s.grade_level_id ASC
        `;

        const [students] = await connection.query(query);

        return res.status(200).json({
            success: true,
            message: 'Students retrieved successfully',
            data: students
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

//GET THE TOTAL NUMBER OF STUDENTS
exports.getTotalStudents = async (req, res) => {
  try {
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM elem_students es
       JOIN school_year sy ON sy.id = es.current_school_year_id
       WHERE es.is_deleted = 0
         AND sy.is_active = 1
         AND es.status != 'graduated'`,
    );

    return res.status(200).json({
      success: true,
      total: rows[0].total,
    });
  } catch (error) {
    console.error("Error fetching total students:", error);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// FILTERED
//get all grade evel studentt
exports.getAllGrade = async (req, res) => {
    try {
        // Query para makuha lang ang mga hindi deleted (is_deleted = 0 o FALSE)
        const [gradeLevels] = await connection.query(
            `SELECT * FROM elem_students WHERE is_deleted = 0 ORDER BY id ASC`
        );

        return res.status(200).json({
            success: true,
            message: 'Grade levels retrieved successfully',
            data: gradeLevels
        });
    } catch (error) {
        console.error('Error fetching grade levels:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// SOFT DELETE STUDENT
exports.softDeleteStudent = async (req, res) => {
  const { id } = req.params;

  try {
    const deleteQuery = `
      UPDATE elem_students 
      SET is_deleted = 1, deleted_at = NOW()
      WHERE id = ?
    `;

    const [result] = await connection.query(deleteQuery, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    res.status(200).json({
      success: true,
      message: "Student record deleted successfully!",
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
};
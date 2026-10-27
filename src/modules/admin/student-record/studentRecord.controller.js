const connection = require("../../../../config/db");
const { studentReadScope } = require('./studentRecord.authorization');
const { lockActiveYear, lockTarget, fail, positiveId } = require('../../../services/studentPlacement.service');

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

  const sectionId = section ? Number(section) : null;
  let conn;

  try {
    if (!positiveId(Number(gradeLevel)) || (sectionId !== null && !positiveId(sectionId))) fail(400, 'Choose a valid grade and section.');
    conn = await connection.getConnection();
    await conn.beginTransaction();
    const year = await lockActiveYear(conn);
    const [grades] = await conn.query('SELECT id FROM grade_level WHERE id = ?', [Number(gradeLevel)]);
    if (!grades.length) fail(400, 'Grade level not found.');
    if (sectionId !== null) await lockTarget(conn, Number(year.id), Number(gradeLevel), sectionId);
    const activeSY = [year];

    if (activeSY.length === 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message:
          "No active school year found. Please set an active school year first.",
      });
    }

    const currentSchoolYearId = activeSY[0].id;
    const { isTransferee = false, joinedDate } = req.body;
    if (typeof isTransferee !== 'boolean') fail(400, 'Choose a valid transferee status.');
    if (isTransferee) {
      if (!require('../../teacher/attendance/dropout.service').isoDate(joinedDate)) fail(400, 'Date joined this school is required.');
      const [[bounds]] = await conn.query("SELECT DATE_FORMAT(MIN(start_date),'%Y-%m-%d') AS startDate, DATE_FORMAT(MAX(end_date),'%Y-%m-%d') AS endDate, DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today FROM grading_periods WHERE school_year_id=?", [currentSchoolYearId]);
      if (!bounds?.startDate || !bounds?.endDate || joinedDate < bounds.startDate || joinedDate > bounds.endDate || joinedDate > bounds.today) fail(400, 'Joining date must be within the active school year and cannot be in the future.');
    }

    const studentQuery = `
        INSERT INTO elem_students
        (student_number, last_name, first_name, middle_name, learner_reference_number, gender, grade_level_id, section_id, current_school_year_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const [result] = await conn.query(studentQuery, [
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

    if (isTransferee) await conn.query('INSERT INTO student_transfer_ins (student_id,school_year_id,joined_date,recorded_by) VALUES (?,?,?,?)', [result.insertId,currentSchoolYearId,joinedDate,req.user.userId]);
    await conn.commit();
    res.status(201).json({
      success: true,
      message: "Student record created successfully!",
      data: { id: result.insertId },
    });
  } catch (error) {
    if (conn) await conn.rollback();
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
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

    return res.status(500).json({ success: false, message: "Database error." });
  }
  finally { if (conn) conn.release(); }
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

  const sectionId = section ? Number(section) : null;
  let conn;

  try {
    if (!positiveId(Number(gradeLevel)) || (sectionId !== null && !positiveId(sectionId))) fail(400, 'Choose a valid grade and section.');
    conn = await connection.getConnection();
    await conn.beginTransaction();
    const year = await lockActiveYear(conn);
    const [grades] = await conn.query('SELECT id FROM grade_level WHERE id = ?', [Number(gradeLevel)]);
    if (!grades.length) fail(400, 'Grade level not found.');
    if (sectionId !== null) await lockTarget(conn, Number(year.id), Number(gradeLevel), sectionId);
    // =========================================================
    // 1. CHECK IF STUDENT IS STILL ACTIVE / CURRENT
    // =========================================================
    const [studentRows] = await conn.query(
      `
      SELECT s.id, s.grade_level_id, s.section_id, s.current_school_year_id
      FROM elem_students s
      JOIN school_year sy
        ON sy.id = s.current_school_year_id
      WHERE s.id = ?
        AND s.is_deleted = 0
        AND s.status <> 'graduated'
        AND sy.is_active = 1
      FOR UPDATE
      `,
      [id]
    );

    if (studentRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "Active student not found.",
      });
    }

    const current = studentRows[0], expected = req.body.expectedPlacement;
    if (!expected || expected.schoolYearId !== Number(current.current_school_year_id) || expected.gradeLevelId !== Number(current.grade_level_id) || expected.sectionId !== current.section_id) {
      fail(409, 'Student placement changed. Refresh the record before saving.');
    }

    // =========================================================
    // 2. CHECK DUPLICATE STUDENT NUMBER / LRN
    // =========================================================
    const checkQuery = `
      SELECT
        id,
        student_number,
        learner_reference_number
      FROM elem_students
      WHERE (
        student_number = ?
        OR learner_reference_number = ?
      )
      AND id != ?
    `;

    const [existing] = await conn.query(checkQuery, [
      studentId,
      lrn,
      id,
    ]);

    if (existing.length > 0) {
      const duplicateStudentNumber = existing.some(
        (row) => row.student_number === studentId
      );

      const duplicateLrn = existing.some(
        (row) => row.learner_reference_number === lrn
      );

      let message = "";

      if (duplicateStudentNumber && duplicateLrn) {
        message =
          "Student number and LRN already exist. Please use unique values.";
      } else if (duplicateStudentNumber) {
        message =
          "Student number already exists. Please use a unique student number.";
      } else if (duplicateLrn) {
        message =
          "LRN already exists. Please use a unique LRN.";
      }

      await conn.rollback();
      return res.status(409).json({
        success: false,
        message,
      });
    }

    // =========================================================
    // 3. UPDATE STUDENT
    // =========================================================
    const studentQuery = `
      UPDATE elem_students
      SET
        student_number = ?,
        last_name = ?,
        first_name = ?,
        middle_name = ?,
        learner_reference_number = ?,
        gender = ?,
        grade_level_id = ?,
        section_id = ?
      WHERE id = ?
        AND current_school_year_id = ?
        AND is_deleted = 0
        AND status <> 'graduated'
    `;

    const [result] = await conn.query(studentQuery, [
      studentId,
      lastName,
      firstName,
      middleName,
      lrn,
      gender,
      gradeLevel,
      sectionId,
      id,
      year.id,
    ]);

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "Student not found or cannot be updated.",
      });
    }

    await conn.commit();
    return res.status(200).json({
      success: true,
      message: "Student record updated successfully!",
    });
  } catch (error) {
    if (conn) await conn.rollback();
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    if (error.code === "ER_DUP_ENTRY") {
      let message = "Duplicate entry found. Please use unique values.";

      if (error.sqlMessage?.includes("student_number")) {
        message =
          "Student number already exists. Please use a unique student number.";
      } else if (
        error.sqlMessage?.includes("learner_reference_number")
      ) {
        message =
          "LRN already exists. Please use a unique LRN.";
      }

      return res.status(409).json({
        success: false,
        message,
      });
    }

    console.error("Database Error:", error);

    return res.status(500).json({
      success: false,
      message: "Database error occurred.",
    });
  }
  finally { if (conn) conn.release(); }
};

// GET STUDENT BY ID (View Student Info)
exports.getStudentById = async (req, res) => {
  const { id } = req.params;

  try {
    const scope = studentReadScope(req, 's');
    const studentQuery = `
      SELECT 
        s.id,
        s.student_number,
        s.last_name,
        s.first_name,
        s.middle_name,
        s.learner_reference_number,
        s.gender,
        s.grade_level_id,
        s.section_id,
        s.parent_guardian_name
      FROM elem_students s
      WHERE s.id = ?
  AND s.is_deleted = 0
  AND s.status <> 'graduated'
  AND ${scope.sql}
    `;

    const [rows] = await connection.query(studentQuery, [id, ...scope.params]);

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
    const scope = studentReadScope(req, 's');
    const query = `
            SELECT 
                s.*,
                DATE_FORMAT(ti.joined_date,'%Y-%m-%d') AS joined_date,
                gl.grade_level AS grade_level_name,
                sec.section_name,
                CASE WHEN dropout.id IS NULL THEN s.status ELSE 'dropped' END AS enrollment_status,
                DATE_FORMAT(dropout.effective_date,'%Y-%m-%d') AS dropout_effective_date,
                guardian.first_name AS guardian_first_name,
                guardian.middle_name AS guardian_middle_name,
                guardian.last_name AS guardian_last_name,
                guardian.contact_number AS guardian_contact_number
            FROM elem_students s
            LEFT JOIN student_transfer_ins ti ON ti.student_id=s.id AND ti.school_year_id=s.current_school_year_id
            LEFT JOIN student_dropout_events dropout ON dropout.student_id=s.id AND dropout.school_year_id=s.current_school_year_id AND dropout.reversed_at IS NULL
            LEFT JOIN parent_table guardian ON guardian.id = (
              SELECT link.parent_id FROM parent_student link
              INNER JOIN parent_table linked_parent ON linked_parent.id = link.parent_id AND linked_parent.is_deleted = 0
              WHERE link.student_id = s.id
              ORDER BY link.parent_id ASC LIMIT 1
            )
            LEFT JOIN grade_level gl ON s.grade_level_id = gl.id
            LEFT JOIN grade_level_sections sec ON s.section_id = sec.id
            JOIN school_year sy ON sy.id = s.current_school_year_id
            WHERE s.is_deleted = 0
              AND sy.is_active = 1
              AND s.status != 'graduated'
              AND ${scope.sql}
            ORDER BY s.grade_level_id ASC
        `;

    const [students] = await connection.query(query, scope.params);

    return res.status(200).json({
      success: true,
      message: "Students retrieved successfully",
      data: students,
    });
  } catch (error) {
    console.error("Error fetching students:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

//GET THE TOTAL NUMBER OF STUDENTS
exports.getTotalStudents = async (req, res) => {
  try {
    const scope = studentReadScope(req, 'es');
    const [rows] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM elem_students es
       JOIN school_year sy ON sy.id = es.current_school_year_id
       WHERE es.is_deleted = 0
         AND sy.is_active = 1
         AND es.status != 'graduated'
         AND ${scope.sql}`, scope.params,
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
    const scope = studentReadScope(req, 's');
    const [gradeLevels] = await connection.query(
      `
      SELECT s.*
      FROM elem_students s
      JOIN school_year sy
        ON sy.id = s.current_school_year_id
      WHERE s.is_deleted = 0
        AND sy.is_active = 1
        AND s.status <> 'graduated'
        AND ${scope.sql}
      ORDER BY s.id ASC
      `, scope.params,
    );

    return res.status(200).json({
      success: true,
      message: "Grade levels retrieved successfully",
      data: gradeLevels,
    });
  } catch (error) {
    console.error("Error fetching grade levels:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
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

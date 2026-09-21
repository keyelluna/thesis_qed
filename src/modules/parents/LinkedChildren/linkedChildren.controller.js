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

// Parehong thresholds/logic ng getStudentPerformanceTrend controller —
// dito rin dapat manggaling ang "single source of truth" kung sakaling
// pagsamahin pa natin ang dalawang controller sa isang shared util file.
const PERFORMANCE_STATUS_THRESHOLDS = [
  { min: 90, status: "excellent" },
  { min: 80, status: "good" },
  { min: 75, status: "fair" },
  { min: 0, status: "needsImprovement" },
];

function getPerformanceStatus(overall) {
  if (overall === null || overall === undefined) return "pending";
  const match = PERFORMANCE_STATUS_THRESHOLDS.find((t) => overall >= t.min);
  return match.status;
}

const toPercentFromRating = (ratingAvg) => {
  if (ratingAvg === null || ratingAvg === undefined) return null;
  return Math.round((ratingAvg / 5) * 100 * 10) / 10;
};

const roundOrNull = (val) =>
  val === null || val === undefined ? null : Math.round(val * 10) / 10;

// Batched na pagkuha ng current overall_score/performance_status ng listahan
// ng studentIds, para sa isang active school year lang. Hindi ito buong
// trend (walang per-term breakdown) — latest term na may laman lang ang
// kinukuha, tapos ginagawang isang badge-ready value.
async function attachCurrentPerformance(studentRows) {
  if (studentRows.length === 0) return studentRows;

  const studentIds = studentRows.map((r) => r.id);
  const studentPlaceholders = studentIds.map(() => "?").join(",");

  const [terms] = await connection.execute(
    `SELECT gp.id, gp.term_number AS termNumber
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1
     ORDER BY gp.term_number ASC`,
  );

  if (terms.length === 0) {
    return studentRows.map((row) => ({
      ...row,
      overall_score: null,
      performance_status: "pending",
    }));
  }

  const gradingPeriodIds = terms.map((t) => t.id);
  const termNumbers = [...new Set(terms.map((t) => t.termNumber))];
  const gpPlaceholders = gradingPeriodIds.map(() => "?").join(",");
  const termPlaceholders = termNumbers.map(() => "?").join(",");
  // term_number -> grading_period id na kabilang doon, para ma-map pabalik
  // ang holistic_ratings (na per term_number lang, walang grading_period_id)
  // sa tamang "slot" kapag pinagsasama-sama natin per grading period.
  const gpIdToTermNumber = new Map(terms.map((t) => [t.id, t.termNumber]));

  const [performanceRows] = await connection.execute(
    `SELECT student_id AS studentId, grading_period_id AS gradingPeriodId,
            AVG(overall_average) AS avgPerformance
     FROM advisory_overall_grades
     WHERE grading_period_id IN (${gpPlaceholders})
       AND student_id IN (${studentPlaceholders})
       AND overall_average IS NOT NULL
     GROUP BY student_id, grading_period_id`,
    [...gradingPeriodIds, ...studentIds],
  );

  const [attendanceRows] = await connection.execute(
    `SELECT student_id AS studentId, grading_period_id AS gradingPeriodId,
            SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS presentCount,
            COUNT(*) AS totalCount
     FROM advisory_attendance_records
     WHERE grading_period_id IN (${gpPlaceholders})
       AND student_id IN (${studentPlaceholders})
     GROUP BY student_id, grading_period_id`,
    [...gradingPeriodIds, ...studentIds],
  );

  const [holisticRows] = await connection.execute(
    `SELECT student_id AS studentId, term_number AS termNumber, axis,
            AVG(rating) AS avgRating
     FROM holistic_ratings
     WHERE term_number IN (${termPlaceholders})
       AND student_id IN (${studentPlaceholders})
     GROUP BY student_id, term_number, axis`,
    [...termNumbers, ...studentIds],
  );

  // studentId -> gradingPeriodId -> value
  const performanceByStudent = new Map();
  for (const r of performanceRows) {
    if (!performanceByStudent.has(r.studentId)) {
      performanceByStudent.set(r.studentId, new Map());
    }
    performanceByStudent
      .get(r.studentId)
      .set(r.gradingPeriodId, Number(r.avgPerformance));
  }

  const attendanceByStudent = new Map();
  for (const r of attendanceRows) {
    if (!attendanceByStudent.has(r.studentId)) {
      attendanceByStudent.set(r.studentId, new Map());
    }
    const rate =
      r.totalCount > 0
        ? (Number(r.presentCount) / Number(r.totalCount)) * 100
        : null;
    attendanceByStudent.get(r.studentId).set(r.gradingPeriodId, rate);
  }

  // studentId -> termNumber -> { axis: value }
  const holisticByStudent = new Map();
  for (const r of holisticRows) {
    if (!holisticByStudent.has(r.studentId)) {
      holisticByStudent.set(r.studentId, new Map());
    }
    const termMap = holisticByStudent.get(r.studentId);
    if (!termMap.has(r.termNumber)) {
      termMap.set(r.termNumber, {});
    }
    termMap.get(r.termNumber)[r.axis] = Number(r.avgRating);
  }

  return studentRows.map((row) => {
    const studentId = row.id;
    const performanceMap = performanceByStudent.get(studentId) ?? new Map();
    const attendanceMap = attendanceByStudent.get(studentId) ?? new Map();
    const holisticMap = holisticByStudent.get(studentId) ?? new Map();

    // Terms pababa mula sa pinaka-huli, kunin yung unang term na may
    // overall value (performance/attendance/holistic) — ito yung "current"
    // status na ipapakita sa badge.
    let currentOverall = null;
    for (let i = terms.length - 1; i >= 0; i -= 1) {
      const t = terms[i];
      const holisticAxes = holisticMap.get(t.termNumber) || {};
      const cognitive = toPercentFromRating(holisticAxes.cognitive ?? null);
      const emotional = toPercentFromRating(holisticAxes.emotional ?? null);
      const behavioral = toPercentFromRating(holisticAxes.behavioral ?? null);
      const social = toPercentFromRating(holisticAxes.social ?? null);

      const holisticValues = [cognitive, emotional, behavioral, social].filter(
        (v) => v !== null && v !== undefined,
      );
      const holisticAvg =
        holisticValues.length > 0
          ? holisticValues.reduce((sum, v) => sum + v, 0) /
            holisticValues.length
          : null;

      const performance = roundOrNull(performanceMap.get(t.id) ?? null);
      const attendance = roundOrNull(attendanceMap.get(t.id) ?? null);

      const categoryValues = [performance, attendance, holisticAvg].filter(
        (v) => v !== null && v !== undefined,
      );

      if (categoryValues.length > 0) {
        currentOverall = roundOrNull(
          categoryValues.reduce((sum, v) => sum + v, 0) /
            categoryValues.length,
        );
        break;
      }
    }

    return {
      ...row,
      overall_score: currentOverall,
      performance_status: getPerformanceStatus(currentOverall),
    };
  });
}

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

    const studentsWithPerformance = await attachCurrentPerformance(rows);

    return res.status(200).json({
      success: true,
      message:
        rows.length > 0 ? "Linked students retrieved" : "No linked students found",
      students: studentsWithPerformance,
    });
  } catch (error) {
    console.error("Database error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error!",
    });
  }
};
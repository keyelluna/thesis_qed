const connection = require("../../.././../../config/db");

// Same advisory submission scope as the academic report, including sectionless classes.
const SUBMITTED = `EXISTS (
  SELECT 1 FROM grade_submissions gs
  WHERE gs.grading_period_id = gp.id AND (
    (s.section_id IS NOT NULL AND gs.section_id = s.section_id) OR
    (s.section_id IS NULL AND gs.section_id IS NULL AND gs.grade_level_id = s.grade_level_id)
  )
)`;

function visibilityEntry(row) {
  const submitted = Number(row.submitted) === 1;
  const isVisible = Number(row.isVisible) === 1;
  const termEnded = Number(row.termEnded) === 1;
  return {
    gradingPeriodId: row.gradingPeriodId,
    termNumber: row.termNumber,
    termLabel: row.termLabel,
    submitted, isVisible, termEnded,
    available: submitted && isVisible && termEnded,
  };
}

async function getVisibilityMapForStudent(studentId) {
  const [rows] = await connection.execute(
    `SELECT
        gp.id            AS gradingPeriodId,
        gp.term_number   AS termNumber,
        gp.term_label    AS termLabel,
        gp.end_date      AS endDate,
        COALESCE(gv.is_visible, 0)      AS isVisible,
        (CURDATE() >= gp.end_date)      AS termEnded,
        ${SUBMITTED} AS submitted
     FROM grading_periods gp
     INNER JOIN school_year sy ON sy.id = gp.school_year_id
     INNER JOIN elem_students s ON s.id = ? AND s.is_deleted = 0
       AND s.current_school_year_id = gp.school_year_id
     LEFT JOIN grade_visibility gv
        ON gv.grading_period_id = gp.id AND gv.student_id = s.id
     WHERE sy.is_active = 1
     ORDER BY gp.term_number ASC`,
    [studentId]
  );

//   console.log(`[getVisibilityMapForStudent] studentId=${studentId} raw rows:`, rows);

  const mapped = rows.map(visibilityEntry);

//   console.log(`[getVisibilityMapForStudent] studentId=${studentId} mapped:`, mapped);

  return mapped;
}

async function getSingleTermVisibility(studentId, gradingPeriodId) {
  const [rows] = await connection.execute(
    `SELECT
        gp.id AS gradingPeriodId,
        gp.term_number AS termNumber,
        gp.term_label AS termLabel,
        COALESCE(gv.is_visible, 0) AS isVisible,
        (CURDATE() >= gp.end_date) AS termEnded,
        ${SUBMITTED} AS submitted
     FROM grading_periods gp
     INNER JOIN elem_students s ON s.id = ? AND s.is_deleted = 0
       AND s.current_school_year_id = gp.school_year_id
     LEFT JOIN grade_visibility gv
        ON gv.grading_period_id = gp.id AND gv.student_id = s.id
     WHERE gp.id = ?
     LIMIT 1`,
    [studentId, gradingPeriodId]
  );

  if (!rows.length) return null;

  const r = rows[0];
  return visibilityEntry(r);
}
async function isStudentLinkedToParent(parentUserId, studentId) {
  const [rows] = await connection.execute(
    `SELECT 1
     FROM parent_student ps
     INNER JOIN parent_table pt ON pt.id = ps.parent_id
     WHERE pt.user_id = ? AND ps.student_id = ?
     LIMIT 1`,
    [parentUserId, studentId]
  );
  return rows.length > 0;
}

async function getVisibilityStatus(req, res) {
  try {
    const { studentId } = req.params;
    const { role, userId } = req.user;

    if (role === "parent") {
      const isLinked = await isStudentLinkedToParent(userId, studentId);
      if (!isLinked) {
        return res.status(403).json({ success: false, message: "Hindi mo ito authorized na tignan." });
      }
    }

    const visibility = await getVisibilityMapForStudent(studentId);

    return res.status(200).json({ success: true, data: visibility });
  } catch (err) {
    console.error("getVisibilityStatus error:", err);
    return res.status(500).json({ success: false, message: "Failed to load visibility status." });
  }
}

async function getStudentTermPerformance(req, res) {
  try {
    const { studentId } = req.params;
    const { role, userId } = req.user;

    if (role === "parent") {
      const isLinked = await isStudentLinkedToParent(userId, studentId);
      if (!isLinked) {
        return res.status(403).json({ success: false, message: "Hindi mo ito authorized na tignan." });
      }
    }

    const visibility = await getVisibilityMapForStudent(studentId);

    let terms = [];
    const meta = {};

    if (role === "parent") {
      const availableTermNumbers = new Set(
        visibility.filter((v) => v.available).map((v) => v.termNumber)
      );

      terms = terms.map((t) => ({
        ...t,
        locked: !availableTermNumbers.has(t.termNumber),
      }));
    }

    return res.status(200).json({
      success: true,
      data: terms,
      meta,
      visibility,
    });
  } catch (err) {
    console.error("getStudentTermPerformance error:", err);
    return res.status(500).json({ success: false, message: "Failed to load term performance." });
  }
}

module.exports = {
  getVisibilityStatus,
  getStudentTermPerformance,
  getSingleTermVisibility
};

const connection = require("../../.././../../config/db");

async function getVisibilityMapForStudent(studentId) {
  const [rows] = await connection.execute(
    `SELECT
        gp.id            AS gradingPeriodId,
        gp.term_number   AS termNumber,
        gp.term_label    AS termLabel,
        gp.end_date      AS endDate,
        COALESCE(gv.is_visible, 0)      AS isVisible,
        (CURDATE() >= gp.end_date)      AS termEnded
     FROM grading_periods gp
     INNER JOIN school_year sy ON sy.id = gp.school_year_id
     LEFT JOIN grade_visibility gv
        ON gv.grading_period_id = gp.id AND gv.student_id = ?
     WHERE sy.is_active = 1
     ORDER BY gp.term_number ASC`,
    [studentId]
  );

//   console.log(`[getVisibilityMapForStudent] studentId=${studentId} raw rows:`, rows);

  const mapped = rows.map((r) => ({
    gradingPeriodId: r.gradingPeriodId,
    termNumber: r.termNumber,
    termLabel: r.termLabel,
    isVisible: !!r.isVisible,
    termEnded: !!r.termEnded,
    available: !!r.isVisible && !!r.termEnded,
  }));

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
        (CURDATE() >= gp.end_date) AS termEnded
     FROM grading_periods gp
     LEFT JOIN grade_visibility gv
        ON gv.grading_period_id = gp.id AND gv.student_id = ?
     WHERE gp.id = ?
     LIMIT 1`,
    [studentId, gradingPeriodId]
  );

  if (!rows.length) return null;

  const r = rows[0];
  return {
    gradingPeriodId: r.gradingPeriodId,
    termNumber: r.termNumber,
    termLabel: r.termLabel,
    isVisible: !!r.isVisible,
    termEnded: !!r.termEnded,
    available: !!r.isVisible && !!r.termEnded,
  };
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
};
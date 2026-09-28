const connection = require("../../../../config/db");

//========================== Helpers ==========================

// Current grading period: nasa active school year at pasok sa petsa ngayon.
async function getCurrentGradingPeriod() {
  const [rows] = await connection.query(
    `SELECT gp.id, gp.school_year_id, gp.term_number, gp.term_label
     FROM grading_periods gp
     JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1
       AND CURDATE() BETWEEN gp.start_date AND gp.end_date
     ORDER BY gp.term_number ASC
     LIMIT 1`
  );
  return rows.length ? rows[0] : null;
}

function getTrend(current, previous) {
  if (previous === undefined || previous === null) return "flat";
  if (Number(current) > Number(previous)) return "up";
  if (Number(current) < Number(previous)) return "down";
  return "flat";
}

//========================== Top Subject Per Grade ==========================

exports.getTopSubjectPerGrade = async (req, res) => {
  try {
    const currentTerm = await getCurrentGradingPeriod();
    if (!currentTerm) {
      return res.status(200).json([]);
    }

    const [rows] = await connection.query(
      `SELECT
         gl.id AS gradeLevelId,
         gl.grade_level AS grade,
         es.subject_name AS subject,
         ROUND(AVG(sgc.average), 1) AS score
       FROM subject_grade_cache sgc
       JOIN \`subject-section\` ss ON sgc.subject_section_id = ss.id
       JOIN elem_subjects es ON ss.subject_id = es.id
       JOIN grade_level gl ON es.grade_level_id = gl.id
       JOIN elem_students st ON sgc.student_id = st.id
       WHERE sgc.grading_period_id = ?
         AND ss.school_year_id = ?
         AND sgc.average IS NOT NULL
         AND st.is_deleted = 0
         AND st.status <> 'graduated'
       GROUP BY gl.id, gl.grade_level, es.subject_name`,
      [currentTerm.id, currentTerm.school_year_id]
    );

    // Previous term (same school year) para sa trend
    let prevRows = [];
    if (currentTerm.term_number > 1) {
      const [prev] = await connection.query(
        `SELECT
           gl.id AS gradeLevelId,
           es.subject_name AS subject,
           ROUND(AVG(sgc.average), 1) AS score
         FROM subject_grade_cache sgc
         JOIN \`subject-section\` ss ON sgc.subject_section_id = ss.id
         JOIN elem_subjects es ON ss.subject_id = es.id
         JOIN grade_level gl ON es.grade_level_id = gl.id
         JOIN grading_periods gp ON sgc.grading_period_id = gp.id
         JOIN elem_students st ON sgc.student_id = st.id
         WHERE gp.school_year_id = ?
           AND gp.term_number = ?
           AND ss.school_year_id = ?
           AND sgc.average IS NOT NULL
           AND st.is_deleted = 0
           AND st.status <> 'graduated'
         GROUP BY gl.id, es.subject_name`,
        [
          currentTerm.school_year_id,
          currentTerm.term_number - 1,
          currentTerm.school_year_id,
        ]
      );
      prevRows = prev;
    }

    const topPerGrade = {};
    for (const row of rows) {
      const current = topPerGrade[row.gradeLevelId];
      if (!current || Number(row.score) > Number(current.score)) {
        topPerGrade[row.gradeLevelId] = row;
      }
    }

    const result = Object.values(topPerGrade).map((row) => {
      const prev = prevRows.find(
        (p) => p.gradeLevelId === row.gradeLevelId && p.subject === row.subject
      );
      return {
        grade: row.grade,
        subject: row.subject,
        score: Number(row.score) || 0,
        trend: getTrend(row.score, prev?.score),
      };
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("getTopSubjectPerGrade error:", error);
    return res.status(500).json({ message: "Failed to fetch top subject per grade." });
  }
};

//========================== Subject Ranking By Term ==========================

exports.getSubjectRankingByTerm = async (req, res) => {
  try {
    // Lahat ng terms ng active school year lang
    const [periods] = await connection.query(
      `SELECT gp.id, gp.school_year_id, gp.term_number, gp.term_label
       FROM grading_periods gp
       JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number`
    );

    const result = {};

    for (const period of periods) {
      const [rows] = await connection.query(
        `SELECT
           gl.grade_level AS grade,
           es.subject_name AS subject,
           ROUND(AVG(sgc.average), 1) AS score
         FROM subject_grade_cache sgc
         JOIN \`subject-section\` ss ON sgc.subject_section_id = ss.id
         JOIN elem_subjects es ON ss.subject_id = es.id
         JOIN grade_level gl ON es.grade_level_id = gl.id
         JOIN elem_students st ON sgc.student_id = st.id
         WHERE sgc.grading_period_id = ?
           AND ss.school_year_id = ?
           AND sgc.average IS NOT NULL
           AND st.is_deleted = 0
           AND st.status <> 'graduated'
         GROUP BY gl.id, gl.grade_level, es.subject_name
         ORDER BY score DESC`,
        [period.id, period.school_year_id]
      );

      const prevPeriod = periods.find((p) => p.term_number === period.term_number - 1);
      let prevRows = [];
      if (prevPeriod) {
        const [prev] = await connection.query(
          `SELECT gl.grade_level AS grade, es.subject_name AS subject,
                  ROUND(AVG(sgc.average), 1) AS score
           FROM subject_grade_cache sgc
           JOIN \`subject-section\` ss ON sgc.subject_section_id = ss.id
           JOIN elem_subjects es ON ss.subject_id = es.id
           JOIN grade_level gl ON es.grade_level_id = gl.id
           JOIN elem_students st ON sgc.student_id = st.id
           WHERE sgc.grading_period_id = ?
             AND ss.school_year_id = ?
             AND sgc.average IS NOT NULL
             AND st.is_deleted = 0
             AND st.status <> 'graduated'
           GROUP BY gl.id, gl.grade_level, es.subject_name`,
          [prevPeriod.id, prevPeriod.school_year_id]
        );
        prevRows = prev;
      }

      result[period.term_label] = rows.map((row, index) => {
        const prev = prevRows.find(
          (p) => p.grade === row.grade && p.subject === row.subject
        );
        return {
          rank: index + 1,
          subject: row.subject,
          grade: row.grade,
          score: Number(row.score) || 0,
          trend: getTrend(row.score, prev?.score),
        };
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("getSubjectRankingByTerm error:", error);
    return res.status(500).json({ message: "Failed to fetch subject ranking." });
  }
};
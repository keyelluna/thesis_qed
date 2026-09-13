const connection = require("../../../../config/db");


exports.getTopSubjectPerGrade = async (req, res) => {
  try {
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
       JOIN grading_periods gp ON sgc.grading_period_id = gp.id
       WHERE gp.is_active = 1 AND sgc.average IS NOT NULL
       GROUP BY gl.id, gl.grade_level, es.subject_name`
    );

    const [[activeTerm]] = await connection.query(
      `SELECT school_year_id, term_number FROM grading_periods WHERE is_active = 1 LIMIT 1`
    );

    let prevRows = [];
    if (activeTerm && activeTerm.term_number > 1) {
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
         WHERE gp.school_year_id = ? AND gp.term_number = ? AND sgc.average IS NOT NULL
         GROUP BY gl.id, es.subject_name`,
        [activeTerm.school_year_id, activeTerm.term_number - 1]
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
      let trend = "flat";
      if (prev) {
        if (Number(row.score) > Number(prev.score)) trend = "up";
        else if (Number(row.score) < Number(prev.score)) trend = "down";
      }
      return {
        grade: row.grade,
        subject: row.subject,
        score: Number(row.score) || 0,
        trend,
      };
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error("getTopSubjectPerGrade error:", error);
    return res.status(500).json({ message: "Failed to fetch top subject per grade." });
  }
};

exports.getSubjectRankingByTerm = async (req, res) => {
  try {
    const [periods] = await connection.query(
      `SELECT id, term_number, term_label FROM grading_periods WHERE school_year_id = (
         SELECT id FROM school_year WHERE is_active = 1 LIMIT 1
       ) ORDER BY term_number`
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
         WHERE sgc.grading_period_id = ? AND sgc.average IS NOT NULL
         GROUP BY gl.id, gl.grade_level, es.subject_name
         ORDER BY score DESC`,
        [period.id]
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
           WHERE sgc.grading_period_id = ? AND sgc.average IS NOT NULL
           GROUP BY gl.id, gl.grade_level, es.subject_name`,
          [prevPeriod.id]
        );
        prevRows = prev;
      }

      result[period.term_label] = rows.map((row, index) => {
        const prev = prevRows.find(
          (p) => p.grade === row.grade && p.subject === row.subject
        );
        let trend = "flat";
        if (prev) {
          if (Number(row.score) > Number(prev.score)) trend = "up";
          else if (Number(row.score) < Number(prev.score)) trend = "down";
        }
        return {
          rank: index + 1,
          subject: row.subject,
          grade: row.grade,
          score: Number(row.score) || 0,
          trend,
        };
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("getSubjectRankingByTerm error:", error);
    return res.status(500).json({ message: "Failed to fetch subject ranking." });
  }
};
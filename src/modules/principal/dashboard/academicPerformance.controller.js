const connection = require("../../../../config/db");

exports.getPerformanceByGrade = async (req, res) => {
  try {
    const [allGrades] = await connection.query(`
      SELECT id AS gradeLevelId, grade_level AS grade
      FROM grade_level
      ORDER BY id ASC
    `);

    const [overallRows] = await connection.query(`
      SELECT 
        gl.id AS gradeLevelId,
        AVG(aog.overall_average) AS score
      FROM advisory_overall_grades aog
      JOIN elem_students es 
        ON es.id = aog.student_id 
        AND es.is_deleted = 0
        AND es.status <> 'graduated'
      JOIN grade_level gl 
        ON gl.id = es.grade_level_id
      JOIN grading_periods gp 
        ON gp.id = aog.grading_period_id
      JOIN school_year sy 
        ON sy.id = gp.school_year_id 
        AND sy.is_active = 1
      WHERE aog.overall_average IS NOT NULL
      GROUP BY gl.id
    `);

    const [sectionRows] = await connection.query(`
      SELECT 
        es.grade_level_id AS gradeLevelId,
        gls.id AS sectionId,
        gls.section_name AS section,
        AVG(aog.overall_average) AS score
      FROM advisory_overall_grades aog
      JOIN elem_students es 
        ON es.id = aog.student_id 
        AND es.is_deleted = 0
        AND es.status <> 'graduated'
      JOIN grade_level_sections gls 
        ON gls.id = aog.section_id
      JOIN grading_periods gp 
        ON gp.id = aog.grading_period_id
      JOIN school_year sy 
        ON sy.id = gp.school_year_id 
        AND sy.is_active = 1
      WHERE aog.overall_average IS NOT NULL
      GROUP BY es.grade_level_id, gls.id, gls.section_name
      ORDER BY gls.id ASC
    `);

    const performanceByGrade = allGrades.map((grade) => {
      const overallMatch = overallRows.find(
        (r) => r.gradeLevelId === grade.gradeLevelId,
      );
      const sections = sectionRows
        .filter((s) => s.gradeLevelId === grade.gradeLevelId)
        .map((s) => ({
          sectionId: s.sectionId,
          section: s.section,
          score: parseFloat(Number(s.score).toFixed(1)),
        }));

      return {
        grade: grade.grade,
        score: overallMatch
          ? parseFloat(Number(overallMatch.score).toFixed(1))
          : null,
        sections,
      };
    });

    return res.status(200).json({
      success: true,
      data: performanceByGrade, 
    });
  } catch (error) {
    console.error("Error fetching performance by grade:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch performance by grade",
    });
  }
};

exports.getPerformanceTrend = async (req, res) => {
  try {
    const [terms] = await connection.execute(
      `SELECT gp.id, gp.term_number AS termNumber, gp.term_label AS termLabel
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`,
    );

    if (terms.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const gradingPeriodIds = terms.map((t) => t.id);
    const termNumbers = [...new Set(terms.map((t) => t.termNumber))];
    const gpPlaceholders = gradingPeriodIds.map(() => "?").join(",");
    const termPlaceholders = termNumbers.map(() => "?").join(",");

    const [performanceRows] = await connection.execute(
      `SELECT aog.grading_period_id AS gradingPeriodId,
              AVG(aog.overall_average) AS avgPerformance
       FROM advisory_overall_grades aog
       JOIN elem_students es
         ON es.id = aog.student_id
         AND es.is_deleted = 0
         AND es.status <> 'graduated'
       WHERE aog.grading_period_id IN (${gpPlaceholders})
         AND aog.overall_average IS NOT NULL
       GROUP BY aog.grading_period_id`,
      gradingPeriodIds,
    );
    const performanceByGp = new Map(
      performanceRows.map((r) => [r.gradingPeriodId, Number(r.avgPerformance)]),
    );

    const [attendanceRows] = await connection.execute(
      `SELECT aar.grading_period_id AS gradingPeriodId,
              SUM(CASE WHEN aar.status = 'P' THEN 1 ELSE 0 END) AS presentCount,
              COUNT(*) AS totalCount
       FROM advisory_attendance_records aar
       JOIN elem_students es
         ON es.id = aar.student_id
         AND es.is_deleted = 0
         AND es.status <> 'graduated'
       WHERE aar.grading_period_id IN (${gpPlaceholders})
       GROUP BY aar.grading_period_id`,
      gradingPeriodIds,
    );
    const attendanceByGp = new Map(
      attendanceRows.map((r) => [
        r.gradingPeriodId,
        r.totalCount > 0
          ? (Number(r.presentCount) / Number(r.totalCount)) * 100
          : null,
      ]),
    );

    const [holisticRows] = await connection.execute(
      `SELECT hr.term_number AS termNumber, hr.axis, AVG(hr.rating) AS avgRating
       FROM holistic_ratings hr
       JOIN elem_students es
         ON es.id = hr.student_id
         AND es.is_deleted = 0
         AND es.status <> 'graduated'
       JOIN \`subject-section\` ss
         ON ss.id = hr.subject_section_id
       JOIN school_year sy
         ON sy.id = ss.school_year_id
         AND sy.is_active = 1
       WHERE hr.term_number IN (${termPlaceholders})
       GROUP BY hr.term_number, hr.axis`,
      termNumbers,
    );
    const holisticByTerm = new Map();
    for (const row of holisticRows) {
      if (!holisticByTerm.has(row.termNumber)) {
        holisticByTerm.set(row.termNumber, {});
      }
      holisticByTerm.get(row.termNumber)[row.axis] = Number(row.avgRating);
    }

    const toPercentFromRating = (ratingAvg) => {
      if (ratingAvg === null || ratingAvg === undefined) return null;
      return Math.round((ratingAvg / 5) * 100 * 10) / 10;
    };
    const roundOrNull = (val) =>
      val === null || val === undefined ? null : Math.round(val * 10) / 10;

    const data = terms.map((t) => {
      const holisticAxes = holisticByTerm.get(t.termNumber) || {};

      const performance = roundOrNull(performanceByGp.get(t.id) ?? null);
      const attendance = roundOrNull(attendanceByGp.get(t.id) ?? null);
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

      const categoryValues = [performance, attendance, holisticAvg].filter(
        (v) => v !== null && v !== undefined,
      );
      const overall =
        categoryValues.length > 0
          ? roundOrNull(
              categoryValues.reduce((sum, v) => sum + v, 0) /
                categoryValues.length,
            )
          : null;

      return {
        term: t.termLabel,
        performance,
        attendance,
        cognitive,
        emotional,
        behavioral,
        social,
        holisticAverage: roundOrNull(holisticAvg),
        overall,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error fetching performance trend:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

function deriveTermStatus(startDate, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);

  const end = new Date(endDate);
  end.setHours(0, 0, 0, 0);

  if (today < start) return "Upcoming";
  if (today > end) return "Completed";
  return "Active";
}

// GET /activeTerm
exports.getActiveTerm = async (_req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT gp.id, gp.school_year_id, gp.term_number, gp.term_label,
              gp.start_date, gp.end_date, gp.is_active,
              sy.school_year
       FROM grading_periods gp
       INNER JOIN school_year sy ON sy.id = gp.school_year_id
       WHERE gp.is_active = 1
       LIMIT 1`,
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({
        status: "fail",
        message: "No active term found.",
      });
    }

    res.status(200).json({
      status: "success",
      message: "Active term fetched successfully.",
      data: {
        id: row.id,
        schoolYearId: row.school_year_id,
        schoolYear: row.school_year,
        termNumber: row.term_number,
        name: row.term_label,
        startDate: row.start_date,
        endDate: row.end_date,
        status: deriveTermStatus(row.start_date, row.end_date),
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res
      .status(500)
      .json({ status: "error", message: "Database error occurred." });
  }
};
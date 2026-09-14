const connection = require("../../../../config/db");
// GET /performanceByGrade
// Overall academic performance per grade level (blended across sections),
// PLUS per-section breakdown para sa hover tooltip sa frontend.
exports.getPerformanceByGrade = async (req, res) => {
  try {
    // 1. Lahat ng grade levels — starting point, hindi advisory_overall_grades
    const [allGrades] = await connection.query(`
      SELECT id AS gradeLevelId, grade_level AS grade
      FROM grade_level
      ORDER BY id ASC
    `);

    // 2. Overall score per grade level (blinend, meron lang kung may data)
    const [overallRows] = await connection.query(`
      SELECT 
        gl.id AS gradeLevelId,
        AVG(aog.overall_average) AS score
      FROM advisory_overall_grades aog
      JOIN elem_students es 
        ON es.id = aog.student_id 
        AND es.is_deleted = 0
      JOIN grade_level gl 
        ON gl.id = es.grade_level_id
      JOIN grading_periods gp 
        ON gp.id = aog.grading_period_id 
        AND gp.is_active = 1
      WHERE aog.overall_average IS NOT NULL
      GROUP BY gl.id
    `);

    // 3. Score per section (breakdown pag-hover)
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
      JOIN grade_level_sections gls 
        ON gls.id = aog.section_id
      JOIN grading_periods gp 
        ON gp.id = aog.grading_period_id 
        AND gp.is_active = 1
      WHERE aog.overall_average IS NOT NULL
      GROUP BY es.grade_level_id, gls.id, gls.section_name
      ORDER BY gls.id ASC
    `);

    // 4. I-merge: simula sa allGrades (lahat ng 6), i-attach ang score/sections
    // kung meron; kung wala, null ang score at [] ang sections.
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
      data: performanceByGrade, // matches GradePerformance[]
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

    // 2. Academic performance average per grading period (advisory_overall_grades)
    const [performanceRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId, AVG(overall_average) AS avgPerformance
   FROM advisory_overall_grades
   WHERE grading_period_id IN (${gpPlaceholders}) AND overall_average IS NOT NULL
   GROUP BY grading_period_id`,
      gradingPeriodIds,
    );
    const performanceByGp = new Map(
      performanceRows.map((r) => [r.gradingPeriodId, Number(r.avgPerformance)]),
    );

    // 3. Attendance rate per grading period (advisory/homeroom daily attendance)
    const [attendanceRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId,
              SUM(CASE WHEN status = 'P' THEN 1 ELSE 0 END) AS presentCount,
              COUNT(*) AS totalCount
       FROM advisory_attendance_records
       WHERE grading_period_id IN (${gpPlaceholders})
       GROUP BY grading_period_id`,
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

    // 4. Holistic ratings average per axis, grouped by term_number
    const [holisticRows] = await connection.execute(
      `SELECT term_number AS termNumber, axis, AVG(rating) AS avgRating
       FROM holistic_ratings
       WHERE term_number IN (${termPlaceholders})
       GROUP BY term_number, axis`,
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

      // Holistic group = average ng 4 axes (null-safe: hindi isasali sa
      // divisor ang mga axis na walang data)
      const holisticValues = [cognitive, emotional, behavioral, social].filter(
        (v) => v !== null && v !== undefined,
      );
      const holisticAvg =
        holisticValues.length > 0
          ? holisticValues.reduce((sum, v) => sum + v, 0) /
            holisticValues.length
          : null;

      // Overall trend = average ng 3 equal-weight categories:
      // performance, attendance, holistic (null-safe din — kung walang
      // value ang isang category, hindi ito isasali sa divisor)
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

exports.getActiveTerm = async (_req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT gp.id, gp.school_year_id, gp.term_number, gp.term_label,
              gp.start_date, gp.end_date, gp.is_active,
              sy.school_year
       FROM grading_periods gp
       INNER JOIN school_year sy ON sy.id = gp.school_year_id
       WHERE gp.is_active = 1
       LIMIT 1`
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
    res.status(500).json({ status: "error", message: "Database error occurred." });
  }
};
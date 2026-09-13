// reports.controller.js
const connection = require("../../../../config/db");

const TREND_THRESHOLD = 2;

exports.getTermOptions = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT gp.term_label
       FROM grading_periods gp
       JOIN school_year sy ON sy.id = gp.school_year_id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`
    );

    const options = rows.map((r) => r.term_label);

    return res.status(200).json({ success: true, data: options });
  } catch (err) {
    console.error("getTermOptions error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch term options." });
  }
};

async function getActiveSchoolYearId() {
  const [rows] = await connection.query(
    `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`
  );
  return rows[0]?.id ?? null;
}

async function getGradingPeriodByTermLabel(termLabel) {
  const schoolYearId = await getActiveSchoolYearId();
  if (!schoolYearId) return null;

  const [rows] = await connection.query(
    `SELECT id, term_number, school_year_id
     FROM grading_periods
     WHERE term_label = ? AND school_year_id = ?
     LIMIT 1`,
    [termLabel, schoolYearId]
  );
  return rows[0] ?? null;
}

async function getPreviousGradingPeriod(currentPeriod) {
  if (!currentPeriod || currentPeriod.term_number <= 1) return null;

  const [rows] = await connection.query(
    `SELECT id FROM grading_periods
     WHERE school_year_id = ? AND term_number = ?
     LIMIT 1`,
    [currentPeriod.school_year_id, currentPeriod.term_number - 1]
  );
  return rows[0] ?? null;
}

async function getSubjectGradeAverages(gradingPeriodId) {
  const [rows] = await connection.query(
    `SELECT
       es.subject_name AS subject,
       gl.grade_level AS grade,
       ROUND(AVG(sgc.average), 0) AS score
     FROM subject_grade_cache sgc
     JOIN \`subject-section\` ss ON ss.id = sgc.subject_section_id
     JOIN elem_subjects es ON es.id = ss.subject_id
     JOIN grade_level_sections gls ON gls.id = ss.section_id
     JOIN grade_level gl ON gl.id = gls.grade_level_id
     WHERE sgc.grading_period_id = ?
       AND sgc.average IS NOT NULL
       AND ss.section_id IS NOT NULL
     GROUP BY es.subject_name, gl.grade_level`,
    [gradingPeriodId]
  );
  return rows;
}

function resolveTrend(currentScore, previousScore) {
  if (previousScore === null || previousScore === undefined) return "flat";
  const diff = currentScore - previousScore;
  if (diff > TREND_THRESHOLD) return "up";
  if (diff < -TREND_THRESHOLD) return "down";
  return "flat";
}


exports.getSubjectRanking = async (req, res) => {
  try {
    const { term } = req.query;
    if (!term) {
      return res.status(400).json({ success: false, message: "Query param 'term' is required." });
    }

    const currentPeriod = await getGradingPeriodByTermLabel(term);
    if (!currentPeriod) {
      return res.status(404).json({ success: false, message: `No grading period found for term '${term}'.` });
    }

    const [currentRows, previousPeriod] = await Promise.all([
      getSubjectGradeAverages(currentPeriod.id),
      getPreviousGradingPeriod(currentPeriod),
    ]);

    let previousRows = [];
    if (previousPeriod) {
      previousRows = await getSubjectGradeAverages(previousPeriod.id);
    }

    const previousLookup = new Map(
      previousRows.map((r) => [`${r.subject}|${r.grade}`, Number(r.score)])
    );

    const ranking = currentRows.map((r) => {
      const score = Number(r.score);
      const previousScore = previousLookup.get(`${r.subject}|${r.grade}`) ?? null;
      return {
        subject: r.subject,
        grade: r.grade,
        score,
        trend: resolveTrend(score, previousScore),
      };
    });

    return res.status(200).json({ success: true, data: ranking });
  } catch (err) {
    console.error("getSubjectRanking error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch subject ranking." });
  }
};

exports.getGradeOptions = async (req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT grade_level FROM grade_level ORDER BY id ASC`
    );
    const options = ["All Grades", ...rows.map((r) => r.grade_level)];
    return res.status(200).json({ success: true, data: options });
  } catch (err) {
    console.error("getGradeOptions error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch grade options." });
  }
};

// ============================== HOLISTIC REPORTS ==============================

const AXES = ["cognitive", "emotional", "behavioral", "social"];

function buildEmptyScores() {
  return { cognitive: null, emotional: null, behavioral: null, social: null };
}

function pivotToHeatmapRows(flatRows, orderedLabels) {
  const byLabel = new Map();
  for (const label of orderedLabels) {
    byLabel.set(label, { label, scores: buildEmptyScores() });
  }

  for (const row of flatRows) {
    if (!byLabel.has(row.label)) {
      byLabel.set(row.label, { label: row.label, scores: buildEmptyScores() });
    }
    const entry = byLabel.get(row.label);
    entry.scores[row.axis] = Math.round(Number(row.avg_rating) * 10) / 10;
  }

  return Array.from(byLabel.values());
}

async function getTermNumberByLabel(termLabel) {
  const schoolYearId = await getActiveSchoolYearId();
  if (!schoolYearId) return null;

  const [rows] = await connection.query(
    `SELECT term_number FROM grading_periods
     WHERE term_label = ? AND school_year_id = ?
     LIMIT 1`,
    [termLabel, schoolYearId]
  );
  return rows[0]?.term_number ?? null;
}

async function getHolisticByGradeLevel(termNumber) {
  const [flatRows] = await connection.query(
    `SELECT
       gl.grade_level AS label,
       hr.axis AS axis,
       AVG(hr.rating) AS avg_rating
     FROM holistic_ratings hr
     JOIN \`subject-section\` ss ON ss.id = hr.subject_section_id
     JOIN grade_level_sections gls ON gls.id = ss.section_id
     JOIN grade_level gl ON gl.id = gls.grade_level_id
     WHERE hr.term_number = ?
     GROUP BY gl.grade_level, hr.axis`,
    [termNumber]
  );

  const [gradeLevelRows] = await connection.query(
    `SELECT grade_level FROM grade_level ORDER BY id ASC`
  );
  const orderedLabels = gradeLevelRows.map((r) => r.grade_level);

  return pivotToHeatmapRows(flatRows, orderedLabels);
}

async function getHolisticBySubject(termNumber) {
  const [flatRows] = await connection.query(
    `SELECT
       es.subject_name AS label,
       hr.axis AS axis,
       AVG(hr.rating) AS avg_rating
     FROM holistic_ratings hr
     JOIN \`subject-section\` ss ON ss.id = hr.subject_section_id
     JOIN elem_subjects es ON es.id = ss.subject_id
     WHERE hr.term_number = ?
     GROUP BY es.subject_name, hr.axis`,
    [termNumber]
  );

  // Preserve a stable, sensible order: subjects appear in the order
  // they were first seen in the query results (grouped alphabetically
  // by MySQL's GROUP BY isn't guaranteed, so sort explicitly).
  const uniqueLabels = Array.from(new Set(flatRows.map((r) => r.label))).sort();

  return pivotToHeatmapRows(flatRows, uniqueLabels);
}

// GET /api/principal/analytics/holistic?term=Term 1&view=By Grade Level
exports.getHolisticRows = async (req, res) => {
  try {
    const { term, view } = req.query;
    if (!term || !view) {
      return res.status(400).json({ success: false, message: "Query params 'term' and 'view' are required." });
    }

    const termNumber = await getTermNumberByLabel(term);
    if (termNumber === null) {
      return res.status(404).json({ success: false, message: `No grading period found for term '${term}'.` });
    }

    const rows =
      view === "By Grade Level"
        ? await getHolisticByGradeLevel(termNumber)
        : await getHolisticBySubject(termNumber);

    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error("getHolisticRows error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch holistic rows." });
  }
};


exports.getViewOptions = async (req, res) => {
  try {
    const options = ["By Grade Level", "By Subject"];
    return res.status(200).json({ success: true, data: options });
  } catch (err) {
    console.error("getViewOptions error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch view options." });
  }
};
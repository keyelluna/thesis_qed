const connection = require('../../../../../config/db');

const AXES = ["cognitive", "emotional", "social", "behavioral"];

function emptyDomainAverages() {
  return { cognitive: null, emotional: null, social: null, behavioral: null };
}

function classifyDomain(avg) {
  if (avg === null) return null;
  if (avg >= 4.5) return "Excellent";
  if (avg >= 3.5) return "Good";
  if (avg >= 2.5) return "Average";
  if (avg >= 1.5) return "Needs Improvement";
  return "Critical";
}

function riskLevelFromDomains(domainAverages) {
  const levels = Object.values(domainAverages).map(classifyDomain);
  if (levels.includes("Critical")) return "HIGH";
  if (levels.includes("Needs Improvement")) return "MEDIUM";
  return "NONE";
}

/** rows: [{ axis, rating }] for ONE week, pooled across every subject */
function averageDomainsFromRows(rows) {
  const byAxis = new Map();
  for (const r of rows) {
    if (!byAxis.has(r.axis)) byAxis.set(r.axis, []);
    byAxis.get(r.axis).push(Number(r.rating));
  }
  const domainAverages = emptyDomainAverages();
  let count = 0;
  for (const axis of AXES) {
    const vals = byAxis.get(axis);
    if (vals && vals.length) {
      domainAverages[axis] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      count += vals.length;
    }
  }
  return { domainAverages, count };
}

/**
 * Access-control middleware: verifies the logged-in parent actually has
 * this student as a linked child (via `parent_student`) before returning
 * any holistic data. Mirrors studentTermPerformance.controller's loadParentStudent.
 */
async function loadParentStudent(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [parentRows] = await connection.execute(
      `SELECT id FROM parent_table WHERE user_id = ?`,
      [authId]
    );
    if (parentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Parent record not found." });
    }
    const parentId = parentRows[0].id;

    const { studentId } = req.params;

    const [linkRows] = await connection.execute(
      `SELECT es.id, es.section_id
       FROM elem_students es
       INNER JOIN parent_student ps ON ps.student_id = es.id
       WHERE es.id = ? AND ps.parent_id = ? AND es.is_deleted = 0`,
      [studentId, parentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({ success: false, message: "You don't have access to this student's records." });
    }

    req.parentId = parentId;
    req.studentSectionId = linkRows[0].section_id;
    next();
  } catch (error) {
    console.error("Error verifying parent-student access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/**
 * GET /weeklyHolisticEvaluation/students/:studentId?termNumber=1
 *
 * Student's holistic evaluation for the term, POOLED across every subject
 * (not broken out per subject) — one entry per week.
 * "current" = latest week's snapshot (for WholeChildSnapshotData props).
 * "history" = earlier weeks, most recent first (for the `history` prop).
 * Requires loadParentStudent to run first (uses req.studentSectionId).
 */
async function getStudentWeeklyEvaluation(req, res) {
  try {
    const { studentId } = req.params;
    const sectionId = req.studentSectionId;
    const { termNumber } = req.query;
    if (!termNumber) {
      return res.status(400).json({ success: false, message: "termNumber is required." });
    }

    const emptyResponse = {
      current: { domainAverages: emptyDomainAverages(), evaluationCount: 0, lastEvaluation: null, riskLevel: "NONE" },
      history: [],
    };

    if (!sectionId) {
      return res.status(200).json({ success: true, data: emptyResponse });
    }

    // Every active subject for the child's section — no teacher/advisory filtering,
    // parents see the whole child, not one teacher's slice.
    const [subjectSectionRows] = await connection.execute(
      `SELECT id FROM \`subject-section\` WHERE section_id = ? AND status = 'Active'`,
      [sectionId]
    );
    const subjectSectionIds = subjectSectionRows.map((r) => r.id);

    if (subjectSectionIds.length === 0) {
      return res.status(200).json({ success: true, data: emptyResponse });
    }

    const placeholders = subjectSectionIds.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `SELECT DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week, axis, rating
       FROM holistic_ratings
       WHERE subject_section_id IN (${placeholders}) AND student_id = ? AND term_number = ?`,
      [...subjectSectionIds, studentId, termNumber]
    );

    if (rows.length === 0) {
      return res.status(200).json({ success: true, data: emptyResponse });
    }

    // Pool every subject's ratings together, per week.
    const byWeek = new Map();
    for (const r of rows) {
      if (!byWeek.has(r.week)) byWeek.set(r.week, []);
      byWeek.get(r.week).push({ axis: r.axis, rating: r.rating });
    }

    const weeksAscending = Array.from(byWeek.keys()).sort();
    const weeklyEntries = weeksAscending.map((week) => {
      const { domainAverages, count } = averageDomainsFromRows(byWeek.get(week));
      return { week, domainAverages, evaluationCount: count };
    });

    const latest = weeklyEntries[weeklyEntries.length - 1];
    const current = {
      domainAverages: latest.domainAverages,
      evaluationCount: latest.evaluationCount,
      lastEvaluation: latest.week,
      riskLevel: riskLevelFromDomains(latest.domainAverages),
    };

    // Most recent first, latest week excluded (that's already "current").
    const history = weeklyEntries
      .slice(0, -1)
      .reverse()
      .map((entry) => ({
        label: entry.week,
        date: entry.week,
        domainAverages: entry.domainAverages,
      }));

    return res.status(200).json({ success: true, data: { current, history } });
  } catch (error) {
    console.error("Error fetching student weekly evaluation:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

/**
 * GET /holisticTermAverages/students/:studentId
 * GET /holisticTermAverages/students/:studentId?termNumber=1
 *
 * Student's holistic averages per DOMAIN (cognitive/emotional/social/behavioral),
 * POOLED across every subject and every week — one entry per grading term.
 *
 * - Without `termNumber`: returns every term for the student's active school year,
 *   each with its own domainAverages (terms with no ratings yet still appear, with
 *   null averages) — shaped for a per-term breakdown table/chart.
 * - With `termNumber`: returns just that one term's summary.
 *
 * `domainAverages` here matches the DomainSummary shape used by the
 * WhatTheDataMeans/InterpretedData card ({ cognitive, emotional, behavioral, social }),
 * just without the `latest`/`delta` framing since this is a whole-term average,
 * not a single week.
 *
 * Requires loadParentStudent to run first (uses req.studentSectionId).
 */
async function getStudentTermAverages(req, res) {
  try {
    const { studentId } = req.params;
    const sectionId = req.studentSectionId;
    const { termNumber } = req.query;

    // 1. Which terms are we reporting on? Pull the active school year's grading
    // periods so terms with zero ratings still show up (null averages, not just missing).
    const [periodRows] = await connection.execute(
      `SELECT gp.term_number, gp.term_label
       FROM grading_periods gp
       INNER JOIN school_year sy ON sy.id = gp.school_year_id
       WHERE sy.is_active = 1
       ${termNumber ? "AND gp.term_number = ?" : ""}
       ORDER BY gp.term_number ASC`,
      termNumber ? [termNumber] : []
    );

    if (periodRows.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const buildEmptyTerm = (row) => ({
      termNumber: row.term_number,
      termLabel: row.term_label,
      domainAverages: emptyDomainAverages(),
      evaluationCount: 0,
      riskLevel: "NONE",
    });

    if (!sectionId) {
      return res.status(200).json({ success: true, data: periodRows.map(buildEmptyTerm) });
    }

    const [subjectSectionRows] = await connection.execute(
      `SELECT id FROM \`subject-section\` WHERE section_id = ? AND status = 'Active'`,
      [sectionId]
    );
    const subjectSectionIds = subjectSectionRows.map((r) => r.id);

    if (subjectSectionIds.length === 0) {
      return res.status(200).json({ success: true, data: periodRows.map(buildEmptyTerm) });
    }

    const sectionPlaceholders = subjectSectionIds.map(() => "?").join(",");
    const termPlaceholders = periodRows.map(() => "?").join(",");
    const termNumbers = periodRows.map((r) => r.term_number);

    // Aggregate directly in SQL: one row per (term_number, axis) with its average
    // rating and how many ratings fed into it.
    const [aggRows] = await connection.execute(
      `SELECT term_number, axis, AVG(rating) AS avgRating, COUNT(*) AS cnt
       FROM holistic_ratings
       WHERE subject_section_id IN (${sectionPlaceholders})
         AND student_id = ?
         AND term_number IN (${termPlaceholders})
       GROUP BY term_number, axis`,
      [...subjectSectionIds, studentId, ...termNumbers]
    );

    // termNumber -> { domainAverages, evaluationCount }
    const byTerm = new Map();
    for (const row of aggRows) {
      if (!byTerm.has(row.term_number)) {
        byTerm.set(row.term_number, { domainAverages: emptyDomainAverages(), evaluationCount: 0 });
      }
      const entry = byTerm.get(row.term_number);
      if (AXES.includes(row.axis)) {
        entry.domainAverages[row.axis] = Math.round(Number(row.avgRating) * 10) / 10;
      }
      entry.evaluationCount += Number(row.cnt);
    }

    const data = periodRows.map((row) => {
      const entry = byTerm.get(row.term_number);
      if (!entry) return buildEmptyTerm(row);
      return {
        termNumber: row.term_number,
        termLabel: row.term_label,
        domainAverages: entry.domainAverages,
        evaluationCount: entry.evaluationCount,
        riskLevel: riskLevelFromDomains(entry.domainAverages),
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error fetching student term averages:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

module.exports = {
  loadParentStudent,
  getStudentWeeklyEvaluation,
  getStudentTermAverages,
};
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
 * GET /holisticTermAverages/students/:studentId?preview=true
 *
 * Student's holistic averages per DOMAIN (cognitive/emotional/social/behavioral),
 * POOLED across every subject and every week — one entry per grading term.
 *
 * RELEASE GATING: a term's averages are only surfaced once that term has
 * actually ENDED — i.e. `grading_periods.end_date` is in the past. This is
 * independent of which grading period is currently "active": while Term 2
 * is the active term, parents still only see Term 1 (already finished).
 * Term 2 only unlocks once Term 2's own end_date has passed, and so on —
 * each term gates on its own end date, not on the term after it starting.
 *
 * Every term in the active school year still appears in the array (so the
 * UI can render a locked/pending state instead of nothing), but unreleased
 * terms come back with `released: false` and zeroed-out numbers — even if
 * ratings already exist in the DB for that term, they're withheld until
 * release.
 *
 * PREVIEW BYPASS: pass `?preview=true` to skip the release gate and see a
 * term's real numbers before its end_date has passed — for QA/sanity
 * checking only. This is currently NOT role-restricted (loadParentStudent
 * only checks parent-child linkage), so before this ships anywhere a parent
 * could stumble onto it, gate `preview` behind an admin/teacher check or
 * remove it entirely.
 *
 * - Without `termNumber`: every term for the active school year.
 * - With `termNumber`: just that one term.
 *
 * Requires loadParentStudent to run first (uses req.studentSectionId).
 */
async function getStudentTermAverages(req, res) {
  try {
    const { studentId } = req.params;
    const sectionId = req.studentSectionId;
    const { termNumber, preview } = req.query;
    const isPreview = preview === "true";

    // 1. Which terms are we reporting on? Pull the active school year's grading
    // periods, computing per-term whether it has already ended (end_date in
    // the past) — that's the release gate. Terms with zero ratings still
    // show up here.
    const [periodRows] = await connection.execute(
      `SELECT gp.id AS grading_period_id, gp.term_number, gp.term_label,
              (gp.end_date < CURDATE()) AS term_ended
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

    const isReleased = (row) => isPreview || Boolean(row.term_ended);

    const buildEmptyTerm = (row, released = false) => ({
      termNumber: row.term_number,
      termLabel: row.term_label,
      released,
      domainAverages: emptyDomainAverages(),
      evaluationCount: 0,
      riskLevel: "NONE",
    });

    if (!sectionId) {
      return res.status(200).json({ success: true, data: periodRows.map((row) => buildEmptyTerm(row, isReleased(row))) });
    }

    const [subjectSectionRows] = await connection.execute(
      `SELECT id FROM \`subject-section\` WHERE section_id = ? AND status = 'Active'`,
      [sectionId]
    );
    const subjectSectionIds = subjectSectionRows.map((r) => r.id);

    if (subjectSectionIds.length === 0) {
      return res.status(200).json({
        success: true,
        data: periodRows.map((row) => buildEmptyTerm(row, isReleased(row))),
      });
    }

    const sectionPlaceholders = subjectSectionIds.map(() => "?").join(",");
    const termNumberPlaceholders = periodRows.map(() => "?").join(",");
    const termNumbers = periodRows.map((r) => r.term_number);

    // Aggregate directly in SQL: one row per (term_number, axis) with its average
    // rating and how many ratings fed into it.
    const [aggRows] = await connection.execute(
      `SELECT term_number, axis, AVG(rating) AS avgRating, COUNT(*) AS cnt
       FROM holistic_ratings
       WHERE subject_section_id IN (${sectionPlaceholders})
         AND student_id = ?
         AND term_number IN (${termNumberPlaceholders})
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
      const released = isReleased(row);

      // Not released yet: never send real numbers down, even if the ratings
      // already exist in the DB — same reasoning as buildEmptyTerm.
      if (!released) return buildEmptyTerm(row, false);

      const entry = byTerm.get(row.term_number);
      if (!entry) return buildEmptyTerm(row, true);

      return {
        termNumber: row.term_number,
        termLabel: row.term_label,
        released: true,
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
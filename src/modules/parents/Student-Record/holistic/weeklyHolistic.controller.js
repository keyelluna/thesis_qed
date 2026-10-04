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

async function loadParentStudent(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [parentRows] = await connection.execute(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
      [authId]
    );
    if (parentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Parent record not found." });
    }
    const parentId = parentRows[0].id;

    const { studentId } = req.params;

    const [linkRows] = await connection.execute(
      `SELECT es.id, es.section_id, es.grade_level_id
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
    req.studentGradeLevelId = linkRows[0].grade_level_id;
    next();
  } catch (error) {
    console.error("Error verifying parent-student access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

async function getStudentWeeklyEvaluation(req, res) {
  try {
    const { studentId } = req.params;
    const sectionId = req.studentSectionId ?? null;
    const gradeLevelId = req.studentGradeLevelId ?? null;
    const { termNumber } = req.query;
    if (!termNumber) {
      return res.status(400).json({ success: false, message: "termNumber is required." });
    }

    const emptyResponse = {
      current: { domainAverages: emptyDomainAverages(), evaluationCount: 0, lastEvaluation: null, riskLevel: "NONE" },
      history: [],
      subjects: [],
    };

    const [termRows] = await connection.execute(
      `SELECT gp.id
       FROM grading_periods gp
       INNER JOIN school_year sy ON sy.id = gp.school_year_id
       WHERE sy.is_active = 1 AND gp.term_number = ?`,
      [termNumber]
    );
    if (termRows.length === 0) {
      return res.status(200).json({ success: true, data: emptyResponse });
    }

    const [subjectSectionRows] = await connection.execute(
      `SELECT ss.id AS subjectSectionId, es.subject_name AS subjectName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON es.id = ss.subject_id
       INNER JOIN school_year sy ON sy.id = ss.school_year_id AND sy.is_active = 1
       WHERE ss.status = 'Active'
         AND (
           ss.section_id = ?
           OR (ss.section_id IS NULL AND es.grade_level_id = ?)
         )`,
      [sectionId, gradeLevelId]
    );
    const subjectSectionIds = subjectSectionRows.map((r) => r.subjectSectionId);

    if (subjectSectionIds.length === 0) {
      return res.status(200).json({ success: true, data: emptyResponse });
    }

    const placeholders = subjectSectionIds.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `SELECT hr.subject_section_id AS subjectSectionId,
              es.subject_name AS subjectName,
              DATE_FORMAT(hr.week_start_date, '%Y-%m-%d') AS week,
              hr.axis, hr.rating
       FROM holistic_ratings hr
       INNER JOIN \`subject-section\` ss ON ss.id = hr.subject_section_id
       INNER JOIN elem_subjects es ON es.id = ss.subject_id
       WHERE hr.subject_section_id IN (${placeholders}) AND hr.student_id = ? AND hr.term_number = ?`,
      [...subjectSectionIds, studentId, termNumber]
    );

    const byWeek = new Map();
    const subjectsById = new Map(subjectSectionRows.map((subject) => [
      String(subject.subjectSectionId),
      {
        subjectSectionId: String(subject.subjectSectionId),
        subjectName: subject.subjectName,
        weeks: new Map(),
      },
    ]));
    for (const r of rows) {
      if (!byWeek.has(r.week)) byWeek.set(r.week, []);
      byWeek.get(r.week).push({ axis: r.axis, rating: r.rating });

      const subject = subjectsById.get(String(r.subjectSectionId));
      if (subject) {
        if (!subject.weeks.has(r.week)) subject.weeks.set(r.week, []);
        subject.weeks.get(r.week).push({ axis: r.axis, rating: r.rating });
      }
    }

    const weeksAscending = Array.from(byWeek.keys()).sort();
    const weeklyEntries = weeksAscending.map((week) => {
      const { domainAverages, count } = averageDomainsFromRows(byWeek.get(week));
      return { week, domainAverages, evaluationCount: count };
    });

    const latest = weeklyEntries[weeklyEntries.length - 1];
    const current = latest ? {
      domainAverages: latest.domainAverages,
      evaluationCount: latest.evaluationCount,
      lastEvaluation: latest.week,
      riskLevel: riskLevelFromDomains(latest.domainAverages),
    } : emptyResponse.current;

    const history = weeklyEntries
      .slice(0, -1)
      .reverse()
      .map((entry) => ({
        label: entry.week,
        date: entry.week,
        domainAverages: entry.domainAverages,
      }));

    const subjects = Array.from(subjectsById.values()).map((subject) => {
      const subjectWeeks = Array.from(subject.weeks.keys()).sort();
      const latestWeek = subjectWeeks[subjectWeeks.length - 1];
      const latestRows = latestWeek ? subject.weeks.get(latestWeek) : null;
      const subjectCurrent = latestRows ? averageDomainsFromRows(latestRows) : null;
      return {
        subjectSectionId: subject.subjectSectionId,
        subjectName: subject.subjectName,
        current: {
          domainAverages: subjectCurrent?.domainAverages ?? emptyDomainAverages(),
          evaluationCount: subjectCurrent?.count ?? 0,
          lastEvaluation: latestWeek ?? null,
          riskLevel: riskLevelFromDomains(subjectCurrent?.domainAverages ?? emptyDomainAverages()),
        },
      };
    }).sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    return res.status(200).json({ success: true, data: { current, history, subjects } });
  } catch (error) {
    console.error("Error fetching student weekly evaluation:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

module.exports = {
  loadParentStudent,
  getStudentWeeklyEvaluation,
};

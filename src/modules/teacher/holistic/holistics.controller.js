const connection = require('../../../../config/db');
const { loadSubjectSection } = require('../gradebook/subjectGrading.controller');

async function getActiveTermNumber() {
  const [rows] = await connection.execute(
    `SELECT gp.term_number AS termNumber
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`
  );
  return rows.length > 0 ? rows[0].termNumber : 1;
}

function getCurrentWeekStartDate() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  const year = monday.getFullYear();
  const month = String(monday.getMonth() + 1).padStart(2, "0");
  const date = String(monday.getDate()).padStart(2, "0");
  return `${year}-${month}-${date}`;
}

function computeTrendFromRows(rows) {
  if (rows.length === 0) {
    return {
      weeksCount: 0,
      weeklyScores: [],
      pastAverage: null,
      recentAverage: null,
      currentWeekAverage: null,
      trend: "No Data",
    };
  }

  const byWeek = new Map();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(Number(r.rating));
  }

  const weeksAscending = Array.from(byWeek.keys()).sort();
  const weeklyAverages = weeksAscending.map((week) => {
    const vals = byWeek.get(week);
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  });

  const weeklyScores = weeksAscending.map((week, i) => ({
    week,
    score: weeklyAverages[i],
  }));

  const n = weeklyAverages.length;
  const currentWeekAverage = weeklyAverages[n - 1];

  if (n < 2) {
    return {
      weeksCount: n,
      weeklyScores,
      pastAverage: null,
      recentAverage: currentWeekAverage,
      currentWeekAverage,
      trend: "Insufficient Data",
    };
  }

  const pastCount = Math.floor(n / 2);
  const pastWeeks = weeklyAverages.slice(0, pastCount);
  const recentWeeks = weeklyAverages.slice(pastCount);

  const pastAverage = Math.round((pastWeeks.reduce((a, b) => a + b, 0) / pastWeeks.length) * 10) / 10;
  const recentAverage = Math.round((recentWeeks.reduce((a, b) => a + b, 0) / recentWeeks.length) * 10) / 10;

  const delta = recentAverage - pastAverage;
  const trend = delta > 0.15 ? "Improving" : delta < -0.15 ? "Declining" : "Stable";

  return { weeksCount: n, weeklyScores, pastAverage, recentAverage, currentWeekAverage, trend };
}

async function computeHolisticTrend(subjectSectionIds, studentId, termNumber) {
  if (subjectSectionIds.length === 0) {
    return computeTrendFromRows([]);
  }
  const placeholders = subjectSectionIds.map(() => "?").join(",");
  const [rows] = await connection.execute(
    `SELECT DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week, rating
     FROM holistic_ratings
     WHERE subject_section_id IN (${placeholders}) AND student_id = ? AND term_number = ?`,
    [...subjectSectionIds, studentId, termNumber]
  );
  return computeTrendFromRows(rows);
}

const getHolistic = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { allWeeks, termNumber } = req.query;

    if (allWeeks === "true") {
      let sql = `SELECT student_id, axis, rating, DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week
                 FROM holistic_ratings WHERE subject_section_id = ?`;
      const params = [subjectSectionId];
      if (termNumber) {
        sql += ` AND term_number = ?`;
        params.push(termNumber);
      }

      const [rows] = await connection.execute(sql, params);

      const weeksByStudent = new Map();
      for (const r of rows) {
        const sid = String(r.student_id);
        if (!weeksByStudent.has(sid)) weeksByStudent.set(sid, new Map());
        const studentWeeks = weeksByStudent.get(sid);
        if (!studentWeeks.has(r.week)) studentWeeks.set(r.week, {});
        studentWeeks.get(r.week)[r.axis] = Number(r.rating);
      }

      const data = {};
      for (const [sid, studentWeeks] of weeksByStudent) {
        const weeksAscending = Array.from(studentWeeks.keys()).sort();
        const weeks = weeksAscending.map((week) => {
          const axes = studentWeeks.get(week);
          const values = Object.values(axes);
          const average = values.length
            ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
            : null;
          return {
            weekStartDate: week,
            cognitive: axes.cognitive ?? null,
            emotional: axes.emotional ?? null,
            social: axes.social ?? null,
            behavioral: axes.behavioral ?? null,
            average,
          };
        });

        const trendRows = weeks
          .filter((w) => w.average !== null)
          .map((w) => ({ week: w.weekStartDate, rating: w.average }));
        const trend = computeTrendFromRows(trendRows);

        data[sid] = { weeks, trend };
      }

      return res.status(200).json({
        success: true,
        data,
        weekStartDate: getCurrentWeekStartDate(),
      });
    }

    const [rows] = await connection.execute(
      `SELECT student_id, axis, rating, DATE_FORMAT(week_start_date, '%Y-%m-%d') AS weekStartDate
       FROM holistic_ratings WHERE subject_section_id = ? AND week_start_date = ?`,
      [subjectSectionId, getCurrentWeekStartDate()]
    );

    const map = {};
    for (const r of rows) {
      const sid = String(r.student_id);
      map[sid] = map[sid] || {};
      map[sid][r.axis] = r.rating;
    }

    return res.status(200).json({
      success: true,
      data: map,
      weekStartDate: getCurrentWeekStartDate(),
    });
  } catch (error) {
    console.error("Error fetching holistic ratings:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const upsertHolistic = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, axis, value, weekStartDate: requestedWeekStartDate, termNumber: requestedTermNumber } = req.body;

    if (!studentId || !axis || !value) {
      return res.status(400).json({ success: false, message: "studentId, axis, and value are required." });
    }

    const weekStartDate = requestedWeekStartDate || getCurrentWeekStartDate();
    const termNumber = requestedTermNumber || (await getActiveTermNumber());

    await connection.execute(
      `INSERT INTO holistic_ratings (subject_section_id, student_id, week_start_date, term_number, axis, rating)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
      [subjectSectionId, studentId, weekStartDate, termNumber, axis, value]
    );

    return res.status(200).json({ success: true, weekStartDate, termNumber });
  } catch (error) {
    console.error("Error saving holistic rating:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getHolisticOverview = async (req, res) => {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { termNumber } = req.query;
    if (!termNumber) {
      return res.status(400).json({ success: false, message: "termNumber is required." });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId]
    );
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const [myStudents] = await connection.execute(
      `SELECT DISTINCT st.id,
              CONCAT(st.last_name, ', ', st.first_name, ' ', COALESCE(st.middle_name, '')) AS name,
              st.section_id
       FROM elem_students st
       INNER JOIN \`subject-section\` ss ON st.section_id = ss.section_id
       WHERE ss.teacher_id = ? AND ss.status = 'Active'
       ORDER BY st.last_name ASC, st.first_name ASC`,
      [teacherId]
    );

    if (myStudents.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const [advisoryRows] = await connection.execute(
      `SELECT section_id FROM classes WHERE class_adviser_id = ?`,
      [teacherId]
    );
    const advisorySectionIds = new Set(advisoryRows.map((r) => r.section_id));

    const studentSectionIds = [...new Set(myStudents.map((s) => s.section_id))];
    const sectionPlaceholders = studentSectionIds.map(() => "?").join(",");

    const [allSectionSubjects] = await connection.execute(
      `SELECT ss.id, ss.section_id, ss.teacher_id, es.subject_name AS subjectName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       WHERE ss.section_id IN (${sectionPlaceholders}) AND ss.status = 'Active'`,
      studentSectionIds
    );

    const mySubjectSectionsBySection = new Map();
    const allSubjectSectionIdsBySection = new Map();
    for (const row of allSectionSubjects) {
      if (!allSubjectSectionIdsBySection.has(row.section_id)) allSubjectSectionIdsBySection.set(row.section_id, []);
      allSubjectSectionIdsBySection.get(row.section_id).push(row.id);

      if (row.teacher_id === teacherId) {
        if (!mySubjectSectionsBySection.has(row.section_id)) mySubjectSectionsBySection.set(row.section_id, []);
        mySubjectSectionsBySection.get(row.section_id).push({ id: row.id, subjectName: row.subjectName });
      }
    }

    const allSubjectSectionIds = [...new Set(allSectionSubjects.map((r) => r.id))];
    if (allSubjectSectionIds.length === 0) {
      const results = myStudents.map((student) => ({
        studentId: String(student.id),
        studentName: student.name.trim(),
        isAdvisory: advisorySectionIds.has(student.section_id),
        subjects: [],
        overall: null,
      }));
      return res.status(200).json({ success: true, data: results });
    }

    const subjectPlaceholders = allSubjectSectionIds.map(() => "?").join(",");
    const [allRatings] = await connection.execute(
      `SELECT subject_section_id, student_id,
              DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week, rating
       FROM holistic_ratings
       WHERE subject_section_id IN (${subjectPlaceholders}) AND term_number = ?`,
      [...allSubjectSectionIds, termNumber]
    );

    const ratingsByKey = new Map();
    for (const r of allRatings) {
      const key = `${r.subject_section_id}:${r.student_id}`;
      if (!ratingsByKey.has(key)) ratingsByKey.set(key, []);
      ratingsByKey.get(key).push({ week: r.week, rating: r.rating });
    }

    const results = myStudents.map((student) => {
      const isAdvisory = advisorySectionIds.has(student.section_id);
      const mySubjects = mySubjectSectionsBySection.get(student.section_id) || [];

      const subjects = mySubjects.map((subj) => {
        const rows = ratingsByKey.get(`${subj.id}:${student.id}`) || [];
        const trend = computeTrendFromRows(rows);
        return { subjectSectionId: String(subj.id), subjectName: subj.subjectName, ...trend };
      });

      let overall = null;
      if (isAdvisory) {
        const allIds = allSubjectSectionIdsBySection.get(student.section_id) || [];
        const combinedRows = [];
        for (const id of allIds) {
          const rows = ratingsByKey.get(`${id}:${student.id}`);
          if (rows) combinedRows.push(...rows);
        }
        overall = computeTrendFromRows(combinedRows);
      }

      return {
        studentId: String(student.id),
        studentName: student.name.trim(),
        isAdvisory,
        subjects,
        overall,
      };
    });

    return res.status(200).json({ success: true, data: results });
  } catch (error) {
    console.error("Error fetching holistic overview:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};


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

const RISK_RANK = { NONE: 0, MEDIUM: 1, HIGH: 2 };

const DOMAIN_RECOMMENDATIONS = {
  cognitive: {
    Critical: "Schedule a one-on-one review of recent lessons; consider extra practice materials.",
    "Needs Improvement": "Check in on comprehension after key lessons this week.",
  },
  emotional: {
    Critical: "Reach out to the student directly and consider looping in the guidance counselor.",
    "Needs Improvement": "Watch for signs of low motivation or disengagement in class.",
  },
  social: {
    Critical: "Consider pairing with a peer buddy or small-group activities to build participation.",
    "Needs Improvement": "Encourage more group work to build collaboration skills.",
  },
  behavioral: {
    Critical: "Discuss attendance/discipline concerns with the student and, if needed, the parent.",
    "Needs Improvement": "Monitor attendance and classroom conduct closely this week.",
  },
};

function buildRisksAndRecommendations(domainAverages) {
  const risks = [];
  const recommendations = [];
  for (const [domain, avg] of Object.entries(domainAverages)) {
    const level = classifyDomain(avg);
    if (level === "Critical" || level === "Needs Improvement") {
      risks.push({ domain, score: avg, level });
      const message = DOMAIN_RECOMMENDATIONS[domain]?.[level];
      if (message) {
        recommendations.push({ domain, message, priority: level === "Critical" ? "High" : "Medium" });
      }
    }
  }
  return { risks, recommendations };
}

const getStudentHolisticProfile = async (req, res) => {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const { studentId } = req.params;
    const { termNumber } = req.query;
    if (!termNumber) {
      return res.status(400).json({ success: false, message: "termNumber is required." });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId]
    );
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const [studentRows] = await connection.execute(
      `SELECT id, CONCAT(last_name, ', ', first_name, ' ', COALESCE(middle_name, '')) AS name, section_id
       FROM elem_students WHERE id = ?`,
      [studentId]
    );
    if (studentRows.length === 0) {
      return res.status(404).json({ success: false, message: "Student not found." });
    }
    const student = studentRows[0];

    const [advisoryRows] = await connection.execute(
      `SELECT section_id FROM classes WHERE class_adviser_id = ?`,
      [teacherId]
    );
    const isAdvisory = advisoryRows.some((r) => r.section_id === student.section_id);

    let subjectRows;
    if (isAdvisory) {
      [subjectRows] = await connection.execute(
        `SELECT ss.id, es.subject_name AS subjectName
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects es ON ss.subject_id = es.id
         WHERE ss.section_id = ? AND ss.status = 'Active'`,
        [student.section_id]
      );
    } else {
      [subjectRows] = await connection.execute(
        `SELECT ss.id, es.subject_name AS subjectName
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects es ON ss.subject_id = es.id
         WHERE ss.teacher_id = ? AND ss.section_id = ? AND ss.status = 'Active'`,
        [teacherId, student.section_id]
      );
    }
    const subjectSectionIds = subjectRows.map((r) => r.id);

    const emptyProfile = {
      studentId: String(student.id),
      studentName: student.name.trim(),
      isAdvisory,
      overall: {
        domainAverages: { cognitive: null, emotional: null, social: null, behavioral: null },
        evaluationCount: 0,
        lastEvaluation: null,
      },
      highestRiskLevel: "NONE",
      subjects: [],
    };

    if (subjectSectionIds.length === 0) {
      return res.status(200).json({ success: true, data: emptyProfile });
    }

    const placeholders = subjectSectionIds.map(() => "?").join(",");

    const [overallAxisRows] = await connection.execute(
      `SELECT axis, AVG(rating) AS avgRating, COUNT(*) AS cnt, MAX(week_start_date) AS lastWeek
       FROM holistic_ratings
       WHERE subject_section_id IN (${placeholders}) AND student_id = ? AND term_number = ?
       GROUP BY axis`,
      [...subjectSectionIds, studentId, termNumber]
    );
    const overallDomainAverages = { cognitive: null, emotional: null, social: null, behavioral: null };
    let overallEvaluationCount = 0;
    let overallLastEvaluation = null;
    for (const r of overallAxisRows) {
      overallDomainAverages[r.axis] = Math.round(Number(r.avgRating) * 10) / 10;
      overallEvaluationCount += Number(r.cnt);
      if (!overallLastEvaluation || r.lastWeek > overallLastEvaluation) overallLastEvaluation = r.lastWeek;
    }

    const [subjectAxisRows] = await connection.execute(
      `SELECT subject_section_id, axis, AVG(rating) AS avgRating, COUNT(*) AS cnt, MAX(week_start_date) AS lastWeek
       FROM holistic_ratings
       WHERE subject_section_id IN (${placeholders}) AND student_id = ? AND term_number = ?
       GROUP BY subject_section_id, axis`,
      [...subjectSectionIds, studentId, termNumber]
    );

    const [subjectWeekRows] = await connection.execute(
      `SELECT subject_section_id, DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week, rating
       FROM holistic_ratings
       WHERE subject_section_id IN (${placeholders}) AND student_id = ? AND term_number = ?`,
      [...subjectSectionIds, studentId, termNumber]
    );
    const weekRowsBySubject = new Map();
    for (const r of subjectWeekRows) {
      if (!weekRowsBySubject.has(r.subject_section_id)) weekRowsBySubject.set(r.subject_section_id, []);
      weekRowsBySubject.get(r.subject_section_id).push({ week: r.week, rating: r.rating });
    }

    const bySubject = new Map();
    for (const id of subjectSectionIds) {
      bySubject.set(id, {
        domainAverages: { cognitive: null, emotional: null, social: null, behavioral: null },
        evaluationCount: 0,
        lastEvaluation: null,
      });
    }
    for (const r of subjectAxisRows) {
      const entry = bySubject.get(r.subject_section_id);
      if (!entry) continue;
      entry.domainAverages[r.axis] = Math.round(Number(r.avgRating) * 10) / 10;
      entry.evaluationCount += Number(r.cnt);
      if (!entry.lastEvaluation || r.lastWeek > entry.lastEvaluation) entry.lastEvaluation = r.lastWeek;
    }

    let highestRiskLevel = "NONE";
    const subjects = subjectRows.map((subj) => {
      const entry = bySubject.get(subj.id);
      const { risks, recommendations } = buildRisksAndRecommendations(entry.domainAverages);
      const riskLevel = riskLevelFromDomains(entry.domainAverages);
      if (RISK_RANK[riskLevel] > RISK_RANK[highestRiskLevel]) highestRiskLevel = riskLevel;

      const trend = computeTrendFromRows(weekRowsBySubject.get(subj.id) || []);

      return {
        subjectSectionId: String(subj.id),
        subjectName: subj.subjectName,
        domainAverages: entry.domainAverages,
        evaluationCount: entry.evaluationCount,
        lastEvaluation: entry.lastEvaluation,
        riskLevel,
        risks,
        recommendations,
        ...trend,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        studentId: String(student.id),
        studentName: student.name.trim(),
        isAdvisory,
        overall: {
          domainAverages: overallDomainAverages,
          evaluationCount: overallEvaluationCount,
          lastEvaluation: overallLastEvaluation,
        },
        highestRiskLevel,
        subjects,
      },
    });
  } catch (error) {
    console.error("Error fetching student holistic profile:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadSubjectSection,
  getHolistic,
  upsertHolistic,
  getHolisticOverview,
  getStudentHolisticProfile,
};
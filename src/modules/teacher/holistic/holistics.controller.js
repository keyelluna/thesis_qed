const connection = require('../../../../config/db');
const { loadSubjectSection } = require('../gradebook/subjectGrading.controller');
const { notifyWeeklyEvaluationIfComplete } = require('../../notification/notification.service');

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
    const { id: subjectSectionId, section_id: sectionId } = req.subjectSection;
    const { studentId, axis, value, weekStartDate: requestedWeekStartDate, termNumber: requestedTermNumber } = req.body;

    if (!studentId || !axis || !value) {
      return res.status(400).json({ success: false, message: "studentId, axis, and value are required." });
    }

    const weekStartDate =
      requestedWeekStartDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekStartDate)
        ? requestedWeekStartDate
        : getCurrentWeekStartDate();

    const termNumber = Math.min(3, Math.max(1, Number(requestedTermNumber) || (await getActiveTermNumber())));

    if (weekStartDate === getCurrentWeekStartDate() && [0, 6].includes(new Date().getDay())) {
      return res.status(423).json({ success: false, message: "Weekly holistic records are locked for the weekend. Recording opens Monday." });
    }

    if (sectionId) {
      const [studentCheck] = await connection.execute(
        `SELECT id FROM elem_students WHERE id = ? AND section_id = ?`,
        [studentId, sectionId]
      );
      if (studentCheck.length === 0) {
        return res.status(403).json({ success: false, message: "This student is not enrolled in your class." });
      }
    }

    await connection.execute(
      `INSERT INTO holistic_ratings (subject_section_id, student_id, week_start_date, term_number, axis, rating)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
      [subjectSectionId, studentId, weekStartDate, termNumber, axis, value]
    );

    // --- Weekly evaluation notification ---
    try {
      await notifyWeeklyEvaluationIfComplete({ studentId, weekStartDate, termNumber });
    } catch (notifErr) {
      console.error("Weekly evaluation notification error:", notifErr);
    }

    return res.status(200).json({ success: true, weekStartDate, termNumber });
  } catch (error) {
    console.error("Error saving holistic rating:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const STUDENT_NAME_SQL = `CONCAT(st.last_name, ', ', st.first_name, ' ', COALESCE(st.middle_name, ''))`;

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

    // ---- 1. Students in sections where this teacher teaches a subject ----
    const [taughtStudents] = await connection.execute(
      `SELECT DISTINCT st.id,
              ${STUDENT_NAME_SQL} AS name,
              st.section_id
       FROM elem_students st
       INNER JOIN \`subject-section\` ss ON st.section_id = ss.section_id
       WHERE ss.teacher_id = ? AND ss.status = 'Active' AND st.is_deleted = 0`,
      [teacherId]
    );

    // ---- 2. Students in classes this teacher ADVISES ----
    // Mirrors the Attendance page's roster logic, so every advisory
    // section shows up here even if the teacher teaches no subject in it.
    // A class with no section_id falls back to grade level + unassigned
    // students, exactly like getAdvisorySectionsList.
    const [advisoryClasses] = await connection.execute(
      `SELECT id AS classId, section_id, grade_level_id
       FROM classes WHERE class_adviser_id = ?`,
      [teacherId]
    );

    const advisoryStudents = [];
    for (const cls of advisoryClasses) {
      const [rows] = cls.section_id
        ? await connection.execute(
            `SELECT st.id, ${STUDENT_NAME_SQL} AS name, st.section_id
             FROM elem_students st
             WHERE st.section_id = ? AND st.is_deleted = 0`,
            [cls.section_id]
          )
        : await connection.execute(
            `SELECT st.id, ${STUDENT_NAME_SQL} AS name, st.section_id
             FROM elem_students st
             WHERE st.grade_level_id = ? AND st.section_id IS NULL AND st.is_deleted = 0`,
            [cls.grade_level_id]
          );
      advisoryStudents.push(...rows);
    }
    const advisoryStudentIds = new Set(advisoryStudents.map((s) => String(s.id)));

    // ---- 3. Merge both lists (dedupe by id) ----
    const studentsById = new Map();
    for (const s of [...taughtStudents, ...advisoryStudents]) {
      studentsById.set(String(s.id), s);
    }
    const myStudents = Array.from(studentsById.values()).sort((a, b) =>
      String(a.name).localeCompare(String(b.name))
    );

    if (myStudents.length === 0) {
      return res.status(200).json({ success: true, data: [] });
    }

    const isAdvisoryStudent = (student) => advisoryStudentIds.has(String(student.id));

    const emptyResults = () =>
      myStudents.map((student) => ({
        studentId: String(student.id),
        studentName: student.name.trim(),
        isAdvisory: isAdvisoryStudent(student),
        subjects: [],
        overall: null,
      }));

    const studentSectionIds = [...new Set(myStudents.map((s) => s.section_id).filter((id) => id !== null && id !== undefined))];

    // Nobody is in a real section (e.g. only unassigned advisory students)
    if (studentSectionIds.length === 0) {
      return res.status(200).json({ success: true, data: emptyResults() });
    }

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
      return res.status(200).json({ success: true, data: emptyResults() });
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
      const isAdvisory = isAdvisoryStudent(student);
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
    // Compare as strings so a number-vs-string mismatch can't make an
    // advisory student look non-advisory (that would list only the subjects
    // this teacher teaches instead of everything the student takes).
    const isAdvisory = advisoryRows.some(
      (r) => r.section_id != null && String(r.section_id) === String(student.section_id)
    );

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

const DOMAIN_AXES = ["cognitive", "emotional", "behavioral", "social"];

// rows: [{ week, axis, rating }] -> [{ weekStartDate, cognitive, ... }]
// Averages every rating of an axis within a week. Because each student has
// one rating per axis per week per subject, this equals "average across
// students", and pooling subjects (overall) is a true pooled average, not
// an average of averages.
function buildWeekPoints(rows) {
  const byWeek = new Map();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, {});
    const bucket = byWeek.get(r.week);
    if (!bucket[r.axis]) bucket[r.axis] = [];
    bucket[r.axis].push(Number(r.rating));
  }
  return Array.from(byWeek.keys())
    .sort()
    .map((week) => {
      const bucket = byWeek.get(week);
      const point = { weekStartDate: week };
      for (const axis of DOMAIN_AXES) {
        const vals = bucket[axis];
        point[axis] = vals && vals.length
          ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
          : null;
      }
      return point;
    });
}

const getDomainTrends = async (req, res) => {
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

    // Every class this teacher advises (same shape the Attendance page uses)
    const [classes] = await connection.execute(
      `SELECT c.id AS classId, c.section_id AS sectionId,
              gls.section_name AS sectionName, gl.grade_level AS gradeLevel
       FROM classes c
       LEFT JOIN grade_level_sections gls ON c.section_id = gls.id
       INNER JOIN grade_level gl ON c.grade_level_id = gl.id
       WHERE c.class_adviser_id = ?`,
      [teacherId]
    );

    if (classes.length === 0) {
      return res.status(200).json({
        success: true,
        data: { termNumber: Number(termNumber), sections: [] },
      });
    }

    const sectionIds = [...new Set(classes.map((c) => c.sectionId).filter((id) => id !== null && id !== undefined))];

    let subjectRows = [];
    let studentRows = [];
    let ratingRows = [];

    if (sectionIds.length > 0) {
      const sectionPh = sectionIds.map(() => "?").join(",");

      // Every ACTIVE subject in the section, whoever teaches it
      [subjectRows] = await connection.execute(
        `SELECT ss.id, ss.section_id AS sectionId, es.subject_name AS subjectName
         FROM \`subject-section\` ss
         INNER JOIN elem_subjects es ON ss.subject_id = es.id
         WHERE ss.section_id IN (${sectionPh}) AND ss.status = 'Active'
         ORDER BY es.subject_name ASC`,
        sectionIds
      );

      [studentRows] = await connection.execute(
        `SELECT id, section_id AS sectionId
         FROM elem_students
         WHERE section_id IN (${sectionPh}) AND is_deleted = 0`,
        sectionIds
      );

      if (subjectRows.length > 0) {
        const subjectIds = subjectRows.map((s) => s.id);
        const subjectPh = subjectIds.map(() => "?").join(",");
        [ratingRows] = await connection.execute(
          `SELECT subject_section_id AS subjectSectionId, student_id AS studentId, axis, rating,
                  DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week
           FROM holistic_ratings
           WHERE subject_section_id IN (${subjectPh}) AND term_number = ?`,
          [...subjectIds, termNumber]
        );
      }
    }

    const studentIdsBySection = new Map();
    for (const s of studentRows) {
      const key = String(s.sectionId);
      if (!studentIdsBySection.has(key)) studentIdsBySection.set(key, new Set());
      studentIdsBySection.get(key).add(String(s.id));
    }

    const ratingsBySubject = new Map();
    for (const r of ratingRows) {
      const key = String(r.subjectSectionId);
      if (!ratingsBySubject.has(key)) ratingsBySubject.set(key, []);
      ratingsBySubject.get(key).push(r);
    }

    const sections = classes.map((cls) => {
      const hasSection = cls.sectionId !== null && cls.sectionId !== undefined;
      const sectionSubjects = hasSection
        ? subjectRows.filter((s) => String(s.sectionId) === String(cls.sectionId))
        : [];
      const enrolled = hasSection
        ? studentIdsBySection.get(String(cls.sectionId)) || new Set()
        : new Set();

      const pooledRows = [];
      const subjects = sectionSubjects.map((subj) => {
        // Only count ratings for students currently enrolled in this section
        const rows = (ratingsBySubject.get(String(subj.id)) || []).filter((r) =>
          enrolled.has(String(r.studentId))
        );
        pooledRows.push(...rows);
        return {
          subjectSectionId: String(subj.id),
          subjectName: subj.subjectName,
          studentCount: new Set(rows.map((r) => String(r.studentId))).size,
          weeks: buildWeekPoints(rows),
        };
      });

      return {
        classId: String(cls.classId),
        sectionId: hasSection ? String(cls.sectionId) : null,
        sectionName: cls.sectionName?.trim() || cls.gradeLevel,
        gradeLevel: cls.gradeLevel,
        subjects,
        overallWeeks: buildWeekPoints(pooledRows),
      };
    });

    return res.status(200).json({
      success: true,
      data: { termNumber: Number(termNumber), sections },
    });
  } catch (error) {
    console.error("Error fetching domain trends:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadSubjectSection,
  getHolistic,
  upsertHolistic,
  getHolisticOverview,
  getStudentHolisticProfile,
  getDomainTrends,
};
const connection = require('../../../../config/db');

async function getActiveGradingPeriodId() {
  const [rows] = await connection.execute(
    `SELECT gp.id
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`
  );
  return rows.length > 0 ? rows[0].id : null;
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

async function loadSubjectSection(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res.status(401).json({ success: false, message: "Unauthorized: walang user ID na nakuha mula sa token." });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId]
    );
    if (teacherRows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const { subjectSectionId } = req.params;
    const [ssRows] = await connection.execute(
      `SELECT ss.id, ss.section_id, es.subject_name AS subjectName,
              gl.grade_level AS gradeLevel, gls.section_name AS sectionName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       INNER JOIN grade_level_sections gls ON ss.section_id = gls.id
       INNER JOIN grade_level gl ON es.grade_level_id = gl.id
       WHERE ss.id = ? AND ss.teacher_id = ?`,
      [subjectSectionId, teacherId]
    );
    if (ssRows.length === 0) {
      return res.status(403).json({ success: false, message: "You don't have access to this class." });
    }

    req.teacherId = teacherId;
    req.subjectSection = ssRows[0];
    next();
  } catch (error) {
    console.error("Error verifying subject-section access:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
}

const getGradingPeriods = async (req, res) => {
  try {
    const [rows] = await connection.execute(
      `SELECT gp.id, gp.term_number AS termNumber, gp.term_label AS termLabel, gp.is_active AS isActive
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`
    );
    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        id: String(r.id),
        termNumber: r.termNumber,
        label: r.termLabel,
        isActive: !!r.isActive,
      })),
    });
  } catch (error) {
    console.error("Error fetching grading periods:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getSubjectSectionInfo = async (req, res) => {
  try {
    const { section_id, subjectName, gradeLevel, sectionName } = req.subjectSection;

    const [students] = await connection.execute(
      `SELECT id, gender,
              CONCAT(last_name, ', ', first_name, ' ', COALESCE(middle_name, '')) AS name
       FROM elem_students
       WHERE section_id = ?
       ORDER BY last_name ASC, first_name ASC`,
      [section_id]
    );

    return res.status(200).json({
      success: true,
      data: {
        subjectName,
        gradeLevel,
        sectionName,
        roster: students.map((s) => ({
          id: String(s.id),
          name: s.name.trim(),
          gender: s.gender === "Female" ? "F" : "M",
        })),
      },
    });
  } catch (error) {
    console.error("Error fetching subject-section info:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// --- ATTENDANCE (term-scoped) ---

const getAttendance = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { allPeriods } = req.query;

    let sql = `
      SELECT student_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS date, status
      FROM attendance_records
      WHERE subject_section_id = ?
    `;
    const params = [subjectSectionId];

    let resolvedTermId = null;
    if (allPeriods !== "true") {
      resolvedTermId = req.query.term || (await getActiveGradingPeriodId());
      if (resolvedTermId) {
        sql += ` AND grading_period_id = ?`;
        params.push(resolvedTermId);
      }
    }

    const [rows] = await connection.execute(sql, params);

    const map = {};
    const presentCount = {};
    for (const r of rows) {
      const sid = String(r.student_id);
      map[sid] = map[sid] || {};
      map[sid][r.date] = r.status;
      if (r.status === "P") presentCount[sid] = (presentCount[sid] || 0) + 1;
    }

    return res.status(200).json({
      success: true,
      data: map,
      presentTotals: presentCount,
      termId: resolvedTermId ? String(resolvedTermId) : null,
    });
  } catch (error) {
    console.error("Error fetching attendance:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const upsertAttendance = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, date, term } = req.body;
    const status = req.body.status ?? null;

    if (!studentId || !date) {
      return res.status(400).json({ success: false, message: "studentId and date are required." });
    }

    const gradingPeriodId = term || (await getActiveGradingPeriodId());

    if (status === null) {
      await connection.execute(
        `DELETE FROM attendance_records
         WHERE subject_section_id = ? AND student_id = ? AND attendance_date = ?
           AND grading_period_id <=> ?`,
        [subjectSectionId, studentId, date, gradingPeriodId]
      );
    } else {
      await connection.execute(
        `INSERT INTO attendance_records (subject_section_id, student_id, attendance_date, status, grading_period_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status)`,
        [subjectSectionId, studentId, date, status, gradingPeriodId]
      );
    }

    return res.status(200).json({ success: true, termId: gradingPeriodId ? String(gradingPeriodId) : null });
  } catch (error) {
    console.error("Error saving attendance:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getItems = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { tab, term, allPeriods } = req.query;

    let sql = `
      SELECT id, tab, DATE_FORMAT(item_date, '%Y-%m-%d') AS date,
             activity_name AS activityName, topic, topic_id AS topicId,
             grading_period_id AS gradingPeriodId, format, exam_type AS examType,
             max_items AS maxItems
      FROM grade_items
      WHERE subject_section_id = ?
    `;

    const params = [subjectSectionId];

    if (tab) {
      sql += ` AND tab = ?`;
      params.push(tab);
    }

    if (allPeriods !== "true") {
      const termId = term || (await getActiveGradingPeriodId());
      if (termId) {
        sql += ` AND grading_period_id = ?`;
        params.push(termId);
      }
    }

    sql += ` ORDER BY item_date ASC`;

    const [rows] = await connection.execute(sql, params);

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        id: String(r.id),
        topicId: r.topicId !== null ? String(r.topicId) : null,
        gradingPeriodId: r.gradingPeriodId !== null ? String(r.gradingPeriodId) : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching grade items:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const addItem = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { tab, date, activityName, topic, format, maxItems, topicId, term, examType } = req.body;

    if (!tab || !date || !topic || !maxItems) {
      return res.status(400).json({
        success: false,
        message: "tab, date, topic, and maxItems are required.",
      });
    }

    const safeActivityName = activityName || topic;
    const safeFormat = format || "Activity";
    const gradingPeriodId = term || (await getActiveGradingPeriodId());

    const [dupe] = await connection.execute(
      `SELECT id FROM grade_items
       WHERE subject_section_id = ? AND tab = ? AND item_date = ?
         AND grading_period_id <=> ? AND topic_id <=> ? AND activity_name = ? AND max_items = ?
         AND created_at >= (NOW() - INTERVAL 5 SECOND)
       LIMIT 1`,
      [subjectSectionId, tab, date, gradingPeriodId, topicId || null, safeActivityName, maxItems]
    );
    if (dupe.length > 0) {
      return res.status(201).json({ success: true, id: String(dupe[0].id) });
    }

    const [result] = await connection.execute(
      `INSERT INTO grade_items
         (subject_section_id, grading_period_id, tab, item_date, activity_name, topic, topic_id, format, exam_type, max_items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [subjectSectionId, gradingPeriodId, tab, date, safeActivityName, topic, topicId || null, safeFormat, examType || null, maxItems]
    );

    return res.status(201).json({ success: true, id: String(result.insertId) });
  } catch (error) {
    console.error("Error creating grade item:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const updateItem = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { itemId } = req.params;
    const { date, activityName, topic, topicId, format, maxItems } = req.body;

    const fields = [];
    const params = [];
    if (date) { fields.push("item_date = ?"); params.push(date); }
    if (activityName) { fields.push("activity_name = ?"); params.push(activityName); }
    if (topic) { fields.push("topic = ?"); params.push(topic); }
    if (topicId !== undefined) { fields.push("topic_id = ?"); params.push(topicId || null); }
    if (format) { fields.push("format = ?"); params.push(format); }
    if (maxItems) { fields.push("max_items = ?"); params.push(maxItems); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    params.push(itemId, subjectSectionId);
    await connection.execute(
      `UPDATE grade_items SET ${fields.join(", ")} WHERE id = ? AND subject_section_id = ?`,
      params
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error updating grade item:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const deleteItem = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { itemId } = req.params;

    await connection.execute(`DELETE FROM grade_scores WHERE item_id = ?`, [itemId]);
    const [result] = await connection.execute(
      `DELETE FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Item not found." });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error deleting grade item:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getScores = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;

    const [rows] = await connection.execute(
      `SELECT gs.student_id, gs.item_id, gs.score
       FROM grade_scores gs
       INNER JOIN grade_items gi ON gs.item_id = gi.id
       WHERE gi.subject_section_id = ?`,
      [subjectSectionId]
    );

    const map = {};
    for (const r of rows) {
      const sid = String(r.student_id);
      map[sid] = map[sid] || {};
      map[sid][String(r.item_id)] = r.score === null ? null : Number(r.score);
    }

    return res.status(200).json({ success: true, data: map });
  } catch (error) {
    console.error("Error fetching scores:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const upsertScore = async (req, res) => {
  try {
    const { studentId, itemId } = req.body;
    const value = req.body.value ?? null;

    if (!studentId || !itemId) {
      return res.status(400).json({ success: false, message: "studentId and itemId are required." });
    }

    await connection.execute(
      `INSERT INTO grade_scores (item_id, student_id, score)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE score = VALUES(score)`,
      [itemId, studentId, value]
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error saving score:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getHolistic = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const requestedWeek = /^\d{4}-\d{2}-\d{2}$/.test(req.query.weekStartDate || "")
      ? req.query.weekStartDate
      : getCurrentWeekStartDate();
    const termNumber = Math.min(3, Math.max(1, Number(req.query.term) || 1));

    const [rows] = await connection.execute(
      `SELECT student_id, axis, rating, DATE_FORMAT(week_start_date, '%Y-%m-%d') AS weekStartDate
       FROM holistic_ratings
       WHERE subject_section_id = ? AND week_start_date = ? AND term_number = ?`,
      [subjectSectionId, requestedWeek, termNumber]
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
      weekStartDate: requestedWeek,
      termNumber,
      locked: requestedWeek < getCurrentWeekStartDate() || [0, 6].includes(new Date().getDay()),
    });
  } catch (error) {
    console.error("Error fetching holistic ratings:", error.code, error.sqlMessage || error.message);

    if (error.code === "ER_NO_SUCH_TABLE") {
      return res.status(200).json({
        success: true,
        data: {},
        weekStartDate: getCurrentWeekStartDate(),
      });
    }

    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const upsertHolistic = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, axis, value, termNumber } = req.body;

    if (!studentId || !axis || !value) {
      return res.status(400).json({ success: false, message: "studentId, axis, and value are required." });
    }

    if ([0, 6].includes(new Date().getDay())) {
      return res.status(423).json({ success: false, message: "Weekly holistic records are locked for the weekend. Recording opens Monday." });
    }
    const weekStartDate = getCurrentWeekStartDate();
    const safeTermNumber = Math.min(3, Math.max(1, Number(termNumber) || 1));

    await connection.execute(
      `INSERT INTO holistic_ratings (subject_section_id, student_id, week_start_date, term_number, axis, rating)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
      [subjectSectionId, studentId, weekStartDate, safeTermNumber, axis, value]
    );

    return res.status(200).json({ success: true, weekStartDate });
  } catch (error) {
    console.error("Error saving holistic rating:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadSubjectSection,
  getGradingPeriods,
  getSubjectSectionInfo,
  getAttendance,
  upsertAttendance,
  getItems,
  addItem,
  updateItem,
  deleteItem,
  getScores,
  upsertScore,
  getHolistic,
  upsertHolistic,
};
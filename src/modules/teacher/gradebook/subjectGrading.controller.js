const connection = require("../../../../config/db");
const {
  recalcStudentSubject,
  recalcAllStudentsForSubject,
} = require("../../shared/grades/gradeCache.service");
const {
  notifyMissedActivity, notifyMissingForItem, notifyLowGradeScore
} = require("../../notification/notification.service");

async function getActiveGradingPeriodId() {
  const [rows] = await connection.execute(
    `SELECT gp.id
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`,
  );
  return rows.length > 0 ? rows[0].id : null;
}

async function getActiveTermNumber() {
  const [rows] = await connection.execute(
    `SELECT gp.term_number AS termNumber
     FROM grading_periods gp
     INNER JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1 AND gp.is_active = 1
     LIMIT 1`,
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

async function loadSubjectSection(req, res, next) {
  try {
    const authId = req.user?.userId;
    if (!authId) {
      return res
        .status(401)
        .json({
          success: false,
          message: "Unauthorized: walang user ID na nakuha mula sa token.",
        });
    }

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ?`,
      [authId],
    );
    if (teacherRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const { subjectSectionId } = req.params;

    const [ssRows] = await connection.execute(
      `SELECT ss.id, ss.section_id, es.subject_name AS subjectName,
              es.grade_level_id AS gradeLevelId,
              gl.grade_level AS gradeLevel, gls.section_name AS sectionName,
              c.class_adviser_id AS adviserId,
              CONCAT(advT.first_name, ' ', advT.last_name) AS adviserName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       LEFT JOIN grade_level_sections gls ON ss.section_id = gls.id
       LEFT JOIN classes c
         ON (ss.section_id IS NOT NULL AND c.section_id = ss.section_id)
         OR (ss.section_id IS NULL AND c.section_id IS NULL AND c.grade_level_id = es.grade_level_id)
       LEFT JOIN teacher_table advT ON c.class_adviser_id = advT.id
       INNER JOIN grade_level gl ON es.grade_level_id = gl.id
       WHERE ss.id = ? AND ss.teacher_id = ?`,
      [subjectSectionId, teacherId],
    );
    if (ssRows.length === 0) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You don't have access to this class.",
        });
    }

    req.teacherId = teacherId;
    req.subjectSection = ssRows[0];
    next();
  } catch (error) {
    console.error("Error verifying subject-section access:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
}

const getSubjectSectionInfo = async (req, res) => {
  try {
    const {
      section_id,
      gradeLevelId,
      subjectName,
      gradeLevel,
      sectionName,
      adviserId,
      adviserName,
    } = req.subjectSection;

    const [students] = section_id
      ? await connection.execute(
          `SELECT id, gender,
                  CONCAT(last_name, ', ', first_name, ' ', COALESCE(middle_name, '')) AS name
           FROM elem_students
           WHERE section_id = ?
           ORDER BY last_name ASC, first_name ASC`,
          [section_id],
        )
      : await connection.execute(
          `SELECT id, gender,
                  CONCAT(last_name, ', ', first_name, ' ', COALESCE(middle_name, '')) AS name
           FROM elem_students
           WHERE grade_level_id = ? AND is_deleted = 0
           ORDER BY last_name ASC, first_name ASC`,
          [gradeLevelId],
        );

    const isOwnAdvisory = !!(adviserId && adviserId === req.teacherId);

    return res.status(200).json({
      success: true,
      data: {
        subjectName,
        gradeLevel,
        sectionName: sectionName || null,
        roster: students.map((s) => ({
          id: String(s.id),
          name: s.name.trim(),
          gender: s.gender === "Female" ? "F" : "M",
        })),
        isOwnAdvisory,
        adviserName: adviserName || null,
      },
    });
  } catch (error) {
    console.error("Error fetching subject-section info:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
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
        gradingPeriodId:
          r.gradingPeriodId !== null ? String(r.gradingPeriodId) : null,
      })),
    });
  } catch (error) {
    console.error("Error fetching grade items:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const addItem = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const {
      tab,
      date,
      activityName,
      topic,
      format,
      maxItems,
      topicId,
      term,
      examType,
    } = req.body;

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
      [
        subjectSectionId,
        tab,
        date,
        gradingPeriodId,
        topicId || null,
        safeActivityName,
        maxItems,
      ],
    );
    if (dupe.length > 0) {
      return res.status(201).json({ success: true, id: String(dupe[0].id) });
    }

    const [result] = await connection.execute(
      `INSERT INTO grade_items
         (subject_section_id, grading_period_id, tab, item_date, activity_name, topic, topic_id, format, exam_type, max_items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subjectSectionId,
        gradingPeriodId,
        tab,
        date,
        safeActivityName,
        topic,
        topicId || null,
        safeFormat,
        examType || null,
        maxItems,
      ],
    );

    return res.status(201).json({ success: true, id: String(result.insertId) });
  } catch (error) {
    console.error("Error creating grade item:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const updateItem = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { itemId } = req.params;
    const { date, activityName, topic, topicId, format, maxItems } = req.body;

    const [beforeRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId, exam_type AS examType, max_items AS maxItems
       FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId],
    );
    if (beforeRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Item not found." });
    }
    const before = beforeRows[0];

    const fields = [];
    const params = [];
    if (date) {
      fields.push("item_date = ?");
      params.push(date);
    }
    if (activityName) {
      fields.push("activity_name = ?");
      params.push(activityName);
    }
    if (topic) {
      fields.push("topic = ?");
      params.push(topic);
    }
    if (topicId !== undefined) {
      fields.push("topic_id = ?");
      params.push(topicId || null);
    }
    if (format) {
      fields.push("format = ?");
      params.push(format);
    }
    if (maxItems) {
      fields.push("max_items = ?");
      params.push(maxItems);
    }

    if (fields.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Nothing to update." });
    }

    params.push(itemId, subjectSectionId);
    await connection.execute(
      `UPDATE grade_items SET ${fields.join(", ")} WHERE id = ? AND subject_section_id = ?`,
      params,
    );

    const maxItemsChanged =
      maxItems && Number(maxItems) !== Number(before.maxItems);
    if (maxItemsChanged) {
      await recalcAllStudentsForSubject(
        subjectSectionId,
        before.gradingPeriodId,
      );
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error updating grade item:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const deleteItem = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { itemId } = req.params;

    const [itemRows] = await connection.execute(
      `SELECT grading_period_id AS gradingPeriodId
       FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId],
    );

    await connection.execute(`DELETE FROM grade_scores WHERE item_id = ?`, [
      itemId,
    ]);
    const [result] = await connection.execute(
      `DELETE FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId],
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Item not found." });
    }

    if (itemRows.length) {
      await recalcAllStudentsForSubject(
        subjectSectionId,
        itemRows[0].gradingPeriodId,
      );
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error deleting grade item:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
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
      [subjectSectionId],
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
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const upsertScore = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, itemId } = req.body;
    const value = req.body.value === undefined || req.body.value === "" ? null : req.body.value;

    if (!studentId || !itemId) {
      return res.status(400).json({ success: false, message: "studentId and itemId are required." });
    }

    const [itemCheck] = await connection.execute(
      `SELECT id FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId]
    );
    if (itemCheck.length === 0) {
      return res.status(403).json({ success: false, message: "This item does not belong to your class." });
    }

    await connection.execute(
      `INSERT INTO grade_scores (item_id, student_id, score)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE score = VALUES(score)`,
      [itemId, studentId, value]
    );

    const [itemRows] = await connection.execute(
      `SELECT subject_section_id AS subjectSectionId, grading_period_id AS gradingPeriodId, topic_id AS topicId
       FROM grade_items WHERE id = ?`,
      [itemId]
    );
    if (itemRows.length && itemRows[0].gradingPeriodId) {
      await recalcStudentSubject(studentId, itemRows[0].subjectSectionId, itemRows[0].gradingPeriodId);
    }

     try {
      if (value !== null) {
        await connection.execute(
          `DELETE FROM notifications
           WHERE student_id = ? AND grade_item_id = ? AND title = 'Missed Activity'`,
          [studentId, itemId]
        );

        if (itemRows.length && itemRows[0].topicId) {
          await notifyLowGradeScore({ studentId, itemId });
        }
      }

      await notifyMissingForItem(itemId);
    } catch (notifErr) {
      console.error("Notification error:", notifErr);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error saving score:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const notifyMissing = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { itemId } = req.params;

    const [itemCheck] = await connection.execute(
      `SELECT id FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId],
    );
    if (itemCheck.length === 0) {
      return res
        .status(403)
        .json({
          success: false,
          message: "This item does not belong to your class.",
        });
    }

    const result = await notifyMissingForItem(itemId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Error notifying missing:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const getHolistic = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const requestedWeek = /^\d{4}-\d{2}-\d{2}$/.test(
      req.query.weekStartDate || "",
    )
      ? req.query.weekStartDate
      : getCurrentWeekStartDate();
    const termNumber = Math.min(3, Math.max(1, Number(req.query.term) || 1));

    const [rows] = await connection.execute(
      `SELECT student_id, axis, rating, DATE_FORMAT(week_start_date, '%Y-%m-%d') AS weekStartDate
       FROM holistic_ratings
       WHERE subject_section_id = ? AND week_start_date = ? AND term_number = ?`,
      [subjectSectionId, requestedWeek, termNumber],
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
      locked:
        requestedWeek < getCurrentWeekStartDate() ||
        [0, 6].includes(new Date().getDay()),
    });
  } catch (error) {
    console.error(
      "Error fetching holistic ratings:",
      error.code,
      error.sqlMessage || error.message,
    );

    if (error.code === "ER_NO_SUCH_TABLE") {
      return res.status(200).json({
        success: true,
        data: {},
        weekStartDate: getCurrentWeekStartDate(),
      });
    }

    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const upsertHolistic = async (req, res) => {
  try {
    const { id: subjectSectionId, section_id: sectionId } = req.subjectSection;
    const {
      studentId,
      axis,
      value,
      weekStartDate: requestedWeekStartDate,
      termNumber: requestedTermNumber,
    } = req.body;

    if (!studentId || !axis || !value) {
      return res
        .status(400)
        .json({
          success: false,
          message: "studentId, axis, and value are required.",
        });
    }

    const weekStartDate =
      requestedWeekStartDate &&
      /^\d{4}-\d{2}-\d{2}$/.test(requestedWeekStartDate)
        ? requestedWeekStartDate
        : getCurrentWeekStartDate();

    const termNumber = Math.min(
      3,
      Math.max(1, Number(requestedTermNumber) || (await getActiveTermNumber())),
    );

    if (
      weekStartDate === getCurrentWeekStartDate() &&
      [0, 6].includes(new Date().getDay())
    ) {
      return res
        .status(423)
        .json({
          success: false,
          message:
            "Weekly holistic records are locked for the weekend. Recording opens Monday.",
        });
    }

    if (sectionId) {
      const [studentCheck] = await connection.execute(
        `SELECT id FROM elem_students WHERE id = ? AND section_id = ?`,
        [studentId, sectionId],
      );
      if (studentCheck.length === 0) {
        return res
          .status(403)
          .json({
            success: false,
            message: "This student is not enrolled in your class.",
          });
      }
    }

    await connection.execute(
      `INSERT INTO holistic_ratings (subject_section_id, student_id, week_start_date, term_number, axis, rating)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
      [subjectSectionId, studentId, weekStartDate, termNumber, axis, value],
    );

    return res.status(200).json({ success: true, weekStartDate, termNumber });
  } catch (error) {
    console.error("Error saving holistic rating:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const getGradeSubmissionStatus = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { gradingPeriodId } = req.query;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    const [rows] = await connection.execute(
      `SELECT DATE_FORMAT(submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt
       FROM subject_grade_submissions
       WHERE subject_section_id = ? AND grading_period_id = ?`,
      [subjectSectionId, gradingPeriodId],
    );

    return res.status(200).json({
      success: true,
      data: {
        submitted: rows.length > 0,
        submittedAt: rows[0]?.submittedAt ?? null,
      },
    });
  } catch (error) {
    console.error("Error fetching subject grade submission status:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

const submitSubjectGrades = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const teacherId = req.teacherId;
    const { gradingPeriodId } = req.body;

    if (!gradingPeriodId) {
      return res
        .status(400)
        .json({ success: false, message: "gradingPeriodId is required." });
    }

    await connection.execute(
      `INSERT INTO subject_grade_submissions (subject_section_id, grading_period_id, submitted_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE submitted_by = VALUES(submitted_by), submitted_at = CURRENT_TIMESTAMP`,
      [subjectSectionId, gradingPeriodId, teacherId],
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error submitting subject grades:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadSubjectSection,
  getSubjectSectionInfo,
  getItems,
  addItem,
  updateItem,
  deleteItem,
  getScores,
  upsertScore,
  notifyMissing,
  getHolistic,
  upsertHolistic,
  getGradeSubmissionStatus,
  submitSubjectGrades,
};

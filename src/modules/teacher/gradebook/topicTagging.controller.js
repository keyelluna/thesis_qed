const connection = require('../../../../config/db');
const { loadSubjectSection } = require('./subjectGrading.controller');

const ACTIVE_SY_ID = `(SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)`;

const rosterFilter = (alias) =>
  `${alias}.is_deleted = 0 AND ${alias}.status <> 'graduated' AND ${alias}.current_school_year_id = ${ACTIVE_SY_ID}`;

const getTopics = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;

    const [rows] = await connection.execute(
      `SELECT lt.id, lt.topic_name AS topicName, lt.description,
              lt.mastery_threshold_percent AS masteryThreshold,
              lt.developing_threshold_percent AS developingThreshold
       FROM learning_topics lt
       INNER JOIN \`subject-section\` ss ON lt.subject_section_id = ss.id
       WHERE lt.subject_section_id = ?
         AND ss.school_year_id = ${ACTIVE_SY_ID}
       ORDER BY lt.topic_name ASC`,
      [subjectSectionId]
    );

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({ ...r, id: String(r.id) })),
    });
  } catch (error) {
    console.error("Error fetching topics:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const createTopic = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { topicName } = req.body;
    const description = req.body.description ?? null;
    const masteryThreshold = req.body.masteryThreshold ?? 80;
    const developingThreshold = req.body.developingThreshold ?? 60;

    if (!topicName) {
      return res.status(400).json({ success: false, message: "topicName is required." });
    }

    const [ssCheck] = await connection.execute(
      `SELECT id FROM \`subject-section\`
       WHERE id = ? AND school_year_id = ${ACTIVE_SY_ID}`,
      [subjectSectionId]
    );
    if (ssCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: "This class is not part of the current school year.",
      });
    }

    const [result] = await connection.execute(
      `INSERT INTO learning_topics
         (subject_section_id, topic_name, description, mastery_threshold_percent, developing_threshold_percent)
       VALUES (?, ?, ?, ?, ?)`,
      [subjectSectionId, topicName, description, masteryThreshold, developingThreshold]
    );

    return res.status(201).json({ success: true, id: String(result.insertId) });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "A topic with this name already exists for this class." });
    }
    console.error("Error creating topic:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};


function classifyMastery(percent, itemsScored, masteryThreshold, developingThreshold, minItemsBeforeFlag) {
  if (percent === null || itemsScored === 0) return "No Data";
  if (itemsScored < minItemsBeforeFlag) return "Insufficient Data";
  if (percent >= masteryThreshold) return "Mastered";
  if (percent >= developingThreshold) return "Developing";
  return "Needs Intervention";
}

const getTopicMastery = async (req, res) => {
  try {
    const { section_id, id: subjectSectionId } = req.subjectSection;
    const { topicId } = req.params;

    const [topicRows] = await connection.execute(
      `SELECT lt.mastery_threshold_percent AS masteryThreshold,
              lt.developing_threshold_percent AS developingThreshold,
              lt.min_items_before_flag AS minItemsBeforeFlag
       FROM learning_topics lt
       INNER JOIN \`subject-section\` ss ON lt.subject_section_id = ss.id
       WHERE lt.id = ? AND lt.subject_section_id = ?
         AND ss.school_year_id = ${ACTIVE_SY_ID}`,
      [topicId, subjectSectionId]
    );
    if (topicRows.length === 0) {
      return res.status(404).json({ success: false, message: "Topic not found." });
    }
    const { masteryThreshold, developingThreshold, minItemsBeforeFlag } = topicRows[0];

    const [rows] = await connection.execute(
      `SELECT
          st.id AS studentId,
          CONCAT(st.last_name, ', ', st.first_name) AS studentName,
          AVG(gs.score / gi.max_items * 100) AS avgPercent,
          COUNT(gs.id) AS itemsScored
       FROM elem_students st
       LEFT JOIN grade_scores gs ON gs.student_id = st.id
       LEFT JOIN grade_items gi ON gs.item_id = gi.id AND gi.topic_id = ?
       WHERE st.section_id = ? AND ${rosterFilter("st")}
       GROUP BY st.id, st.last_name, st.first_name
       ORDER BY st.last_name ASC`,
      [topicId, section_id]
    );

    const data = rows.map((r) => {
      const percent = r.avgPercent !== null ? Number(r.avgPercent) : null;
      return {
        studentId: String(r.studentId),
        studentName: r.studentName,
        averagePercent: percent !== null ? Math.round(percent * 10) / 10 : null,
        itemsScored: r.itemsScored,
        status: classifyMastery(percent, r.itemsScored, masteryThreshold, developingThreshold, minItemsBeforeFlag),
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("Error computing topic mastery:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};


const getStudentTopicProgress = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { topicId, studentId } = req.params;

    const [rows] = await connection.execute(
      `SELECT
          gi.id AS itemId,
          DATE_FORMAT(gi.item_date, '%Y-%m-%d') AS date,
          gi.activity_name AS activityName,
          gi.max_items AS maxItems,
          gs.score
       FROM grade_items gi
       INNER JOIN \`subject-section\` ss ON gi.subject_section_id = ss.id
       LEFT JOIN grade_scores gs ON gs.item_id = gi.id AND gs.student_id = ?
       WHERE gi.subject_section_id = ? AND gi.topic_id = ?
         AND ss.school_year_id = ${ACTIVE_SY_ID}
       ORDER BY gi.item_date ASC`,
      [studentId, subjectSectionId, topicId]
    );

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        itemId: String(r.itemId),
        date: r.date,
        activityName: r.activityName,
        maxItems: r.maxItems,
        score: r.score === null ? null : Number(r.score),
        percent: r.score === null ? null : Math.round((Number(r.score) / r.maxItems) * 1000) / 10,
      })),
    });
  } catch (error) {
    console.error("Error fetching student topic progress:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const getInterventions = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, topicId } = req.query;

    let sql = `
      SELECT
        iv.id, iv.student_id AS studentId, iv.topic_id AS topicId,
        lt.topic_name AS topicName, iv.activity_name AS activityName,
        DATE_FORMAT(iv.intervention_date, '%Y-%m-%d') AS date,
        iv.notes, iv.status
      FROM interventions iv
      INNER JOIN learning_topics lt ON iv.topic_id = lt.id
      INNER JOIN \`subject-section\` ss ON iv.subject_section_id = ss.id
      INNER JOIN elem_students s ON iv.student_id = s.id
      WHERE iv.subject_section_id = ?
        AND ss.school_year_id = ${ACTIVE_SY_ID}
        AND ${rosterFilter("s")}
    `;
    const params = [subjectSectionId];

    if (studentId) {
      sql += ` AND iv.student_id = ?`;
      params.push(studentId);
    }
    if (topicId) {
      sql += ` AND iv.topic_id = ?`;
      params.push(topicId);
    }
    sql += ` ORDER BY iv.intervention_date DESC`;

    const [rows] = await connection.execute(sql, params);

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({ ...r, id: String(r.id), studentId: String(r.studentId), topicId: String(r.topicId) })),
    });
  } catch (error) {
    console.error("Error fetching interventions:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const createIntervention = async (req, res) => {
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, topicId, activityName, date } = req.body;
    const notes = req.body.notes ?? null;

    if (!studentId || !topicId || !activityName || !date) {
      return res.status(400).json({
        success: false,
        message: "studentId, topicId, activityName, and date are required.",
      });
    }

    const [studentCheck] = await connection.execute(
      `SELECT s.id FROM elem_students s
       WHERE s.id = ? AND ${rosterFilter("s")}`,
      [studentId]
    );
    if (studentCheck.length === 0) {
      return res.status(403).json({
        success: false,
        message: "This student is not enrolled in the current school year.",
      });
    }

    const [topicCheck] = await connection.execute(
      `SELECT lt.id FROM learning_topics lt
       INNER JOIN \`subject-section\` ss ON lt.subject_section_id = ss.id
       WHERE lt.id = ? AND lt.subject_section_id = ?
         AND ss.school_year_id = ${ACTIVE_SY_ID}`,
      [topicId, subjectSectionId]
    );
    if (topicCheck.length === 0) {
      return res.status(404).json({ success: false, message: "Topic not found." });
    }

    const [result] = await connection.execute(
      `INSERT INTO interventions (student_id, topic_id, subject_section_id, activity_name, intervention_date, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [studentId, topicId, subjectSectionId, activityName, date, notes]
    );

    return res.status(201).json({ success: true, id: String(result.insertId) });
  } catch (error) {
    console.error("Error creating intervention:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

const updateInterventionStatus = async (req, res) => {
  try {
    const { interventionId } = req.params;
    const { status } = req.body;

    if (!["Ongoing", "Completed"].includes(status)) {
      return res.status(400).json({ success: false, message: "status must be 'Ongoing' or 'Completed'." });
    }

    await connection.execute(
      `UPDATE interventions SET status = ? WHERE id = ?`,
      [status, interventionId]
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error updating intervention:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  loadSubjectSection, 
  getTopics,
  createTopic,
  getTopicMastery,
  getStudentTopicProgress,
  getInterventions,
  createIntervention,
  updateInterventionStatus,
};
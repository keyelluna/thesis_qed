const { runGradeSubmission } = require('../../shared/grades/gradeSubmissionTransaction.service');
const { studentBelongsToSubject } = require('./subjectStudent.authorization');
const { requireTeacherStudentIdentity } = require('../../admin/student-record/studentRecord.authorization');
const connection = require("../../../../config/db");
const {
  recalcStudentSubject,
  recalcAllStudentsForSubject,
} = require("../../shared/grades/gradeCache.service");
const {
  notifyMissedActivity, notifyMissingForItem, notifyLowGradeScore, notifySubjectGradeSubmission
} = require("../../notification/notification.service");
const { resolveGradeTemplateForPeriod } = require("../../shared/grades/gradeTemplateResolution.service");
const { normalizeExaminations } = require("../../shared/grades/gradeTemplateConfig.service");

// Filter para sa current (active) school year lang.
// ACTIVE_SY_ID ay subquery na nagbabalik ng ID ng active na school year.
const ACTIVE_SY_ID = `(SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)`;

// Roster filter (alias: s = elem_students): hindi isasama ang graduated
// at ang mga estudyanteng wala sa current school year.
const ROSTER_FILTER = `s.is_deleted = 0 AND s.status <> 'graduated' AND s.current_school_year_id = ${ACTIVE_SY_ID}`;

async function pinTemplateToGradingPeriod(subjectSectionId, gradingPeriodId) {
  if (!gradingPeriodId) return;
  await resolveGradeTemplateForPeriod(subjectSectionId, gradingPeriodId, {
    pinIfEmpty: true,
    assignmentSource: "first_assessment",
  });
}

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

    let authorized=false;
    requireTeacherStudentIdentity(req,res,()=>{authorized=true;});
    if(!authorized)return;

    const [teacherRows] = await connection.execute(
      `SELECT id FROM teacher_table WHERE user_id = ? AND is_deleted = 0`,
      [authId],
    );
    if (teacherRows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Teacher record not found." });
    }
    const teacherId = teacherRows[0].id;

    const { subjectSectionId } = req.params;

    // Subject-section ng active school year lang ang papayagan.
    // Pati ang adviser (classes) ay kukunin lang mula sa active school year.
    const [ssRows] = await connection.execute(
      `SELECT ss.id, ss.section_id, es.subject_name AS subjectName,
              es.grade_level_id AS gradeLevelId, es.is_graded AS isGraded,
              gl.grade_level AS gradeLevel, gls.section_name AS sectionName,
              c.class_adviser_id AS adviserId,
              CONCAT(advT.first_name, ' ', advT.last_name) AS adviserName
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON ss.subject_id = es.id
       LEFT JOIN grade_level_sections gls ON ss.section_id = gls.id
       LEFT JOIN classes c
         ON (
              (ss.section_id IS NOT NULL AND c.section_id = ss.section_id)
              OR (ss.section_id IS NULL AND c.section_id IS NULL AND c.grade_level_id = es.grade_level_id)
            )
            AND c.school_year_id = ${ACTIVE_SY_ID}
       LEFT JOIN teacher_table advT ON c.class_adviser_id = advT.id
       INNER JOIN grade_level gl ON es.grade_level_id = gl.id
       WHERE ss.id = ? AND ss.teacher_id = ?
         AND ss.school_year_id = ${ACTIVE_SY_ID}`,
      [subjectSectionId, teacherId],
    );
    if (ssRows.length === 0) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You don't have access to this class in the current school year.",
        });
    }

    req.teacherId = teacherId;
    req.subjectSection = ssRows[0];
    // Non-graded subjects support holistic evaluation only.
    const assessmentPath = /^\/[^/]+\/(items|scores|submission|topics|interventions)(\/|$)/.test(req.path);
    if (Number(req.subjectSection.isGraded) === 0 && assessmentPath) {
      return res.status(403).json({ success: false, message: "Assessments and grades are unavailable for non-graded subjects." });
    }
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
          `SELECT s.id, s.gender,
                  CONCAT(s.last_name, ', ', s.first_name, ' ', COALESCE(s.middle_name, '')) AS name
           FROM elem_students s
           WHERE s.section_id = ? AND ${ROSTER_FILTER}
           ORDER BY s.last_name ASC, s.first_name ASC`,
          [section_id],
        )
      : await connection.execute(
          `SELECT s.id, s.gender,
                  CONCAT(s.last_name, ', ', s.first_name, ' ', COALESCE(s.middle_name, '')) AS name
           FROM elem_students s
           WHERE s.grade_level_id = ? AND ${ROSTER_FILTER}
           ORDER BY s.last_name ASC, s.first_name ASC`,
          [gradeLevelId],
        );

    const isOwnAdvisory = !!(adviserId && adviserId === req.teacherId);

    return res.status(200).json({
      success: true,
      data: {
        subjectName,
        isGraded: Number(req.subjectSection.isGraded) !== 0,
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
             activity_name AS activityName, topic, topic_id AS topicId, template_domain_id AS templateDomainId,
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
  let db,committed=false,commitAttempted=false;
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
      templateDomainId,
      term,
      examType,
    } = req.body;

    if (!tab || !date || !topic || !maxItems) {
      return res.status(400).json({
        success: false,
        message: "tab, date, topic, and maxItems are required.",
      });
    }

    const gradingPeriodId = term || (await getActiveGradingPeriodId());
    if (!gradingPeriodId) return res.status(400).json({ success: false, message: "gradingPeriodId is required." });
    await pinTemplateToGradingPeriod(subjectSectionId, gradingPeriodId);
    const [periodRows] = await connection.execute(
      `SELECT term_number AS termNumber FROM grading_periods WHERE id = ? LIMIT 1`,
      [gradingPeriodId],
    );
    const termNumber = Number(periodRows[0]?.termNumber || 1);
    const resolvedTemplate = await resolveGradeTemplateForPeriod(subjectSectionId, gradingPeriodId, { pinIfEmpty: false });
    let structure = resolvedTemplate.template?.structure;
    structure = structure?.termConfigurations?.[String(termNumber)]
      ? { ...structure, ...structure.termConfigurations[String(termNumber)] }
      : structure;
    const group = tab === "writtenWorks" ? structure?.ww : tab === "performanceTask" ? structure?.pt : null;
    if (tab === "exams") {
      const examinations = normalizeExaminations(structure, structure?.examWeightPercent);
      if (!examinations.enabled) return res.status(400).json({ success: false, message: "This pinned grade template has no Examination section." });
      const accepted = examinations.components.some((component) => component.key.toUpperCase() === "ALL" || component.key.toUpperCase() === String(examType || "").toUpperCase());
      if (!accepted) return res.status(400).json({ success: false, message: "Choose an examination component supported by the pinned grade template." });
    }
    if (group?.domains?.length > 1 && !templateDomainId) {
      return res.status(400).json({ success: false, message: "A template domain is required for this assessment item." });
    }
    if (templateDomainId && !group?.domains?.some((domain) => domain.id === templateDomainId)) {
      return res.status(400).json({ success: false, message: "Choose a valid template domain for this assessment item." });
    }

    const safeActivityName = activityName || topic;
    const safeFormat = format || "Activity";
    db=await connection.getConnection();await db.beginTransaction();
    await db.execute('SELECT id FROM \u0060subject-section\u0060 WHERE id = ? FOR UPDATE',[subjectSectionId]);
    const [dupe] = await db.execute(
      `SELECT id FROM grade_items
       WHERE subject_section_id = ? AND tab = ? AND item_date = ?
         AND grading_period_id <=> ? AND topic_id <=> ? AND template_domain_id <=> ? AND activity_name = ? AND max_items = ?
         AND created_at >= (NOW() - INTERVAL 5 SECOND)
       LIMIT 1`,
      [
        subjectSectionId,
        tab,
        date,
        gradingPeriodId,
        topicId || null,
        templateDomainId || null,
        safeActivityName,
        maxItems,
      ],
    );
    if (dupe.length > 0) {
      commitAttempted=true;await db.commit();committed=true;
      return res.status(201).json({ success: true, id: String(dupe[0].id) });
    }

    if(group?.domains?.length){
      const domain=group.domains.length===1?group.domains[0]:group.domains.find(entry=>entry.id===templateDomainId);
      if(Array.isArray(domain?.scoreColumns)){
        const params=[subjectSectionId,gradingPeriodId,tab];
        let sql='SELECT COUNT(*) AS used FROM grade_items WHERE subject_section_id=? AND grading_period_id=? AND tab=?';
        if(group.domains.length>1){sql+=' AND template_domain_id=?';params.push(domain.id);}
        const [[count]]=await db.execute(sql,params);
        require('./assessmentCapacity.service').requireAvailableSlot(domain,count.used);
      }
    }
    const [result] = await db.execute(
      `INSERT INTO grade_items
         (subject_section_id, grading_period_id, tab, item_date, activity_name, topic, topic_id, template_domain_id, format, exam_type, max_items)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        subjectSectionId,
        gradingPeriodId,
        tab,
        date,
        safeActivityName,
        topic,
        topicId || null,
        templateDomainId || null,
        safeFormat,
        examType || null,
        maxItems,
      ],
    );

    commitAttempted=true;await db.commit();committed=true;
    return res.status(201).json({ success: true, id: String(result.insertId) });
  } catch (error) {
    if(commitAttempted){db?.destroy();db=null;return res.status(503).json({success:false,outcome:'uncertain',message:'Item creation could not be confirmed. Refresh the class before adding again.'});}
    if(db&&!committed)try{await db.rollback();}catch{db.destroy();db=null;}
    console.error("Error creating grade item:", error);
    return res
      .status(error.statusCode || 500)
      .json({ success: false, message: error.statusCode ? error.message : "Internal server error." });
  }
  finally {db?.release();}
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
  let db;
  let inTransaction = false;
  let commitAttempted = false;
  let discard = false;
  let status = 200;
  let body = { success: true };
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { itemId } = req.params;
    db = await connection.getConnection();
    try {
      await db.beginTransaction();
      inTransaction = true;
    } catch (error) {
      discard = true; // START TRANSACTION acknowledgement may also be lost.
      throw error;
    }
    // Serialize deletions for this subject before taking any consistent-read
    // snapshot, so two different item deletions cannot rebuild from stale peers.
    const [subjects] = await db.execute('SELECT id FROM `subject-section` WHERE id = ? FOR UPDATE', [subjectSectionId]);
    if (!subjects.length) {
      const error = new Error('Item not found.'); error.statusCode = 404; throw error;
    }
    // Fail closed on nontransactional/missing tables; never rely on FK cascades.
    const tables = ['subject-section', 'grade_scores', 'grade_items', 'subject_grade_cache', 'advisory_overall_grades'];
    const [engines] = await db.execute(
      `SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?, ?)`, tables,
    );
    if (tables.some(name => !engines.some(row => row.tableName === name && row.engine?.toUpperCase() === 'INNODB'))) {
      throw new Error('Assessment deletion requires InnoDB grading tables.');
    }
    const [itemRows] = await db.execute(
      `SELECT grading_period_id AS gradingPeriodId
       FROM grade_items WHERE id = ? AND subject_section_id = ? FOR UPDATE`,
      [itemId, subjectSectionId],
    );
    if (!itemRows.length) {
      const error = new Error('Item not found.'); error.statusCode = 404; throw error;
    }
    await db.execute(`DELETE FROM grade_scores WHERE item_id = ?`, [
      itemId,
    ]);
    const [result] = await db.execute(
      `DELETE FROM grade_items WHERE id = ? AND subject_section_id = ?`,
      [itemId, subjectSectionId],
    );
    if (result.affectedRows === 0) {
      const error = new Error('Item not found.'); error.statusCode = 404; throw error;
    }
    await recalcAllStudentsForSubject(subjectSectionId, itemRows[0].gradingPeriodId, db);
    commitAttempted = true;
    await db.commit();
    inTransaction = false;
  } catch (error) {
    console.error("Error deleting grade item:", error);
    if (commitAttempted) {
      // A rejected COMMIT acknowledgement cannot establish whether it committed.
      // Discard the socket; do not replay or claim a rollback proved failure.
      discard = true;
      status = 503;
      body = { success: false, outcome: 'uncertain', message: 'Assessment deletion could not be confirmed. Refresh this class before trying again.' };
    } else {
      if (inTransaction) {
        try { await db.rollback(); }
        catch (rollbackError) { discard = true; console.error('Assessment deletion rollback failed:', rollbackError); }
      }
      status = error.statusCode === 404 ? 404 : 500;
      body = { success: false, message: status === 404 ? 'Item not found.' : 'Internal server error.' };
    }
  } finally {
    if (db) {
      try { if (discard) db.destroy(); else db.release(); }
      catch (cleanupError) {
        console.error('Assessment deletion connection cleanup failed:', cleanupError);
        if (!discard) { try { db.destroy(); } catch (destroyError) { console.error('Assessment deletion connection destruction failed:', destroyError); } }
      }
    }
  }
  // Response delivery is outside the transaction error path: a lost response
  // after a successful commit must never trigger rollback or another deletion.
  return res.status(status).json(body);
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

const upsertScore = async (req, res, batch = {}) => {
  let db, inTransaction = false, commitAttempted = false, discard = false;
  let status = 200, body = { success: true }, notification;
  try {
    const { id: subjectSectionId } = req.subjectSection;
    const { studentId, itemId } = req.body;
    const normalize = raw => raw === undefined || raw === null || raw === '' ? null
      : typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    const value = normalize(req.body.value);
    const conditional = Object.hasOwn(req.body, 'expectedValue');
    const expected = normalize(req.body.expectedValue);
    const reject = (code, message, outcome) => { const error = new Error(message); error.statusCode = code; error.outcome = outcome; throw error; };
    if (!studentId || !itemId) reject(400, 'studentId and itemId are required.');
    if ((value !== null && (!Number.isFinite(value) || value < 0)) || (conditional && expected !== null && (!Number.isFinite(expected) || expected < 0))) reject(400, 'Score must be a finite, non-negative number or blank.');

    db = batch.db || await connection.getConnection();
    try { if (!batch.db) await db.beginTransaction(); inTransaction = true; }
    catch (error) { discard = true; throw error; }
    // Match deletion's lock order. Lock the student before snapshot reads so
    // score edits in different subjects also serialize advisory recalculation.
    const [subjects] = await db.execute('SELECT id FROM `subject-section` WHERE id = ? FOR UPDATE', [subjectSectionId]);
    if (!subjects.length) reject(403, 'This item does not belong to your class.');
    const [students] = await db.execute('SELECT id FROM elem_students WHERE id = ? FOR UPDATE', [studentId]);
    const [items] = await db.execute(`SELECT id, grading_period_id AS gradingPeriodId, topic_id AS topicId, max_items AS maxItems
      FROM grade_items WHERE id = ? AND subject_section_id = ? FOR UPDATE`, [itemId, subjectSectionId]);
    if (!items.length) reject(403, 'This item does not belong to your class.');
    if (!students.length || !(await studentBelongsToSubject(studentId, req.subjectSection, db))) reject(403, 'This student is not enrolled in your class.');
    const tables = ['subject-section', 'elem_students', 'grade_items', 'grade_scores', 'subject_grade_cache', 'advisory_overall_grades'];
    const [engines] = await db.execute(`SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?, ?, ?, ?)`, tables);
    if (tables.some(name => !engines.some(row => row.tableName === name && row.engine?.toUpperCase() === 'INNODB'))) throw new Error('Score saving requires InnoDB grading tables.');
    const [indexes] = await db.execute(`SELECT INDEX_NAME AS indexName, COLUMN_NAME AS columnName FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'grade_scores' AND NON_UNIQUE = 0 ORDER BY INDEX_NAME, SEQ_IN_INDEX`);
    const keys = new Map();
    for (const row of indexes) { if (!keys.has(row.indexName)) keys.set(row.indexName, []); keys.get(row.indexName).push(String(row.columnName).toLowerCase()); }
    if (![...keys.values()].some(columns => columns.length === 2 && columns.includes('item_id') && columns.includes('student_id'))) throw new Error('Score saving requires a unique assessment/student key.');
    const item = items[0];
    if (!item.gradingPeriodId) reject(400, 'This assessment has no grading period.');
    if (!Number.isFinite(Number(item.maxItems)) || Number(item.maxItems) <= 0 || (value !== null && value > Number(item.maxItems))) reject(400, 'Score must not exceed the assessment highest possible score.');
    const [scores] = await db.execute('SELECT score FROM grade_scores WHERE item_id = ? AND student_id = ? FOR UPDATE', [itemId, studentId]);
    const previous = scores.length && scores[0].score !== null ? Number(scores[0].score) : null;
    if (conditional && previous !== expected) reject(409, 'This score changed since it was loaded. Reload this class before saving again.', 'conflict');
    await db.execute(
      `INSERT INTO grade_scores (item_id, student_id, score)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE score = VALUES(score)`,
      [itemId, studentId, value]
    );

    if(batch.db)batch.recalculate.set(studentId+':'+item.gradingPeriodId,[studentId,subjectSectionId,item.gradingPeriodId]);
    else await recalcStudentSubject(studentId, subjectSectionId, item.gradingPeriodId, db);
    commitAttempted = true;
    if (!batch.db) await db.commit(); inTransaction = false;
    if (!scores.length || previous !== value) notification = { studentId, itemId, value, topicId: item.topicId };
  } catch (error) {
    console.error("Error saving score:", error);
    if (commitAttempted) {
      discard = true; status = 503;
      body = { success: false, outcome: 'uncertain', message: 'Score saving could not be confirmed. Reload this class to check the stored score before saving again.' };
    } else {
      if (inTransaction && !batch.db) { try { await db.rollback(); } catch (rollbackError) { discard = true; console.error('Score rollback failed:', rollbackError); } }
      status = [400, 403, 409].includes(error.statusCode) ? error.statusCode : 500;
      body = { success: false, message: status === 500 ? 'Internal server error.' : error.message, outcome: error.outcome || 'not_saved' };
    }
  } finally {
    if (db && !batch.db) { try { if (discard) db.destroy(); else db.release(); } catch (cleanupError) { console.error('Score connection cleanup failed:', cleanupError); if (!discard) { try { db.destroy(); } catch (destroyError) { console.error('Score connection destruction failed:', destroyError); } } } }
  }
  // Acknowledge the committed grade before optional notification reads/delivery.
  const response = res.status(status).json(body);
  // Notifications are secondary and use only committed, current score state.
  // No delivery runs for rollback/unknown commit; durable delivery is separate.
  if (notification && !batch.db) {
    const delivery = (async () => {
    const { studentId, itemId, value, topicId } = notification;
    try {
      if (value !== null) {
        await connection.execute(`DELETE FROM notifications WHERE student_id = ? AND grade_item_id = ? AND title = 'Missed Activity'
          AND EXISTS (SELECT 1 FROM grade_scores WHERE item_id = ? AND student_id = ? AND score IS NOT NULL)`, [studentId, itemId, itemId, studentId]);
        if (topicId) await notifyLowGradeScore({ studentId, itemId });
      }
      await notifyMissingForItem(itemId);
    } catch (error) { console.error('Post-commit score notification failed:', error); }
    })();
    if (globalThis.process?.env?.VERCEL === '1') require('@vercel/functions').waitUntil(delivery);
    await delivery;
  }
  return response;
};


const upsertScores = async (req,res) => {
 const edits=req.body?.edits;
 if(!Array.isArray(edits)||!edits.length||edits.length>1000||edits.some(e=>!e||!e.studentId||!e.itemId||!Object.hasOwn(e,'expectedValue'))||new Set(edits.map(e=>e.studentId+':'+e.itemId)).size!==edits.length)return res.status(400).json({success:false,outcome:'not_saved',message:'Choose unique valid score edits.'});
 let db,commitAttempted=false,discard=false,phase='acquire';
 try {
  db=await connection.getConnection();phase='begin';try{await db.beginTransaction();}catch(error){discard=true;throw error;}
  const metadata=new Map(),transaction=Object.assign(Object.create(db),{execute(sql,args=[]){
   const reusable=/^\s*SELECT\b/i.test(sql)&&!/grade_scores|subject_grade_cache|advisory_overall_grades/i.test(sql);
   if(!reusable)return db.execute(sql,args);
   const key=JSON.stringify([sql,args]);if(!metadata.has(key))metadata.set(key,db.execute(sql,args));return metadata.get(key);
  }}),context={db:transaction,recalculate:new Map()};
  phase='validate-and-write';
  for(const edit of [...edits].sort((a,b)=>Number(a.studentId)-Number(b.studentId)||Number(a.itemId)-Number(b.itemId))){
   const reply={code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
   await upsertScore({...req,body:edit},reply,context);
   if(reply.code!==200)throw Object.assign(new Error(reply.body.message),{status:reply.code,outcome:reply.body.outcome});
  }
  phase='recalculate';
  for(const args of context.recalculate.values())await recalcStudentSubject(...args,transaction);
  phase='commit';commitAttempted=true;await db.commit();
  db.release();db=null;
  const response=res.json({success:true,count:edits.length});
  const delivery=(async()=>{try{
   for(const edit of edits)if(edit.value!==null){await connection.execute("DELETE FROM notifications WHERE student_id = ? AND grade_item_id = ? AND title = 'Missed Activity' AND EXISTS (SELECT 1 FROM grade_scores WHERE item_id = ? AND student_id = ? AND score IS NOT NULL)",[edit.studentId,edit.itemId,edit.itemId,edit.studentId]);await notifyLowGradeScore({studentId:edit.studentId,itemId:edit.itemId});}
   for(const itemId of new Set(edits.map(edit=>edit.itemId)))await notifyMissingForItem(itemId);
  }catch(error){console.error('Post-commit batch notification failed:',error.code||error.name);}})();
  if(globalThis.process?.env?.VERCEL==='1')require('@vercel/functions').waitUntil(delivery);await delivery;
  return response;
 }catch(error){
  console.error(JSON.stringify({event:'score_batch_failed',phase,code:error.code||'INTERNAL_ERROR',requestId:res.getHeader?.('X-Request-ID'),commitAttempted}));
  if(res.headersSent)return;
  discard=discard||commitAttempted;
  if(db&&!commitAttempted)try{await db.rollback();}catch{discard=true;}
  return res.status(commitAttempted?503:error.status||500).json({success:false,outcome:commitAttempted?'uncertain':error.outcome||'not_saved',message:commitAttempted?'Score saving could not be confirmed. Reload this class before saving again.':error.status?error.message:'Scores were not saved. Please retry.'});
 }finally{if(db){if(discard)db.destroy();else db.release();}}
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
    const { id: subjectSectionId } = req.subjectSection;
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

    if (!(await studentBelongsToSubject(studentId,req.subjectSection))) {
      return res.status(403).json({success:false,message:"This student is not enrolled in your class."});
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
      `SELECT DATE_FORMAT(submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt,
              (SELECT CAST(MAX(h.id) AS CHAR) FROM grade_submission_history h WHERE h.submission_type = 'subject' AND h.subject_section_id = subject_grade_submissions.subject_section_id AND h.grading_period_id = subject_grade_submissions.grading_period_id) AS submissionVersion
       FROM subject_grade_submissions
       WHERE subject_section_id = ? AND grading_period_id = ?`,
      [subjectSectionId, gradingPeriodId],
    );

    return res.status(200).json({
      success: true,
      data: {
        submitted: rows.length > 0,
        submittedAt: rows[0]?.submittedAt ?? null,
        submissionVersion: rows[0]?.submissionVersion ?? null,
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
  const { id: subjectSectionId } = req.subjectSection;
  const { gradingPeriodId } = req.body;
  const result = await runGradeSubmission(req, 'subject', async db => {
    // Submission publishes the Term Grades produced by the template version
    // pinned to this period. Never reinterpret an unpinned historical period
    // using whatever version happens to be active now.
    const resolved = await resolveGradeTemplateForPeriod(subjectSectionId, gradingPeriodId, { pinIfEmpty: false, db });
    const baseStructure = resolved.template?.structure;
    const structure = baseStructure?.termConfigurations?.[String(resolved.termNumber)]
      ? { ...baseStructure, ...baseStructure.termConfigurations[String(resolved.termNumber)] }
      : baseStructure;
    const transmutationTable = structure?.transmutationTable || [];
    if (!transmutationTable.length) {
      const error = new Error("The template assigned to this grading period must include transmutation rules before Term Grades can be submitted."); error.statusCode = 400; throw error;
    }

    // Graduated / hindi-current-school-year na estudyante ay hindi kasama sa
    // pagbibilang, para hindi nila ma-block ang submission.
    const [incompleteRows] = await db.execute(
      `SELECT COUNT(*) AS incompleteCount
       FROM elem_students s
       INNER JOIN \`subject-section\` ss ON ss.id = ?
       INNER JOIN elem_subjects es ON es.id = ss.subject_id
       LEFT JOIN subject_grade_cache c
         ON c.student_id = s.id AND c.subject_section_id = ss.id AND c.grading_period_id = ?
       WHERE ${ROSTER_FILTER}
         AND ((ss.section_id IS NOT NULL AND s.section_id = ss.section_id)
           OR (ss.section_id IS NULL AND s.section_id IS NULL AND s.grade_level_id = es.grade_level_id))
         AND (c.is_complete IS NULL OR c.is_complete = 0 OR c.average IS NULL)`,
      [subjectSectionId, gradingPeriodId],
    );
    if (Number(incompleteRows[0]?.incompleteCount || 0) > 0) {
      const error = new Error("Every enrolled student must have complete scores and an official Term Grade before submission."); error.statusCode = 400; throw error;
    }


  });
  if (result.notification) {
    try { await notifySubjectGradeSubmission({ subjectSectionId, gradingPeriodId, submittedBy: req.teacherId }); }
    catch (error) { console.error('Post-commit subject submission notification failed:', error); result.body.notificationDelivery = 'failed'; }
  }
  return res.status(result.status).json(result.body);
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
  upsertScores,
  notifyMissing,
  getHolistic,
  upsertHolistic,
  getGradeSubmissionStatus,
  submitSubjectGrades,
};

const { getIO } = require('../../../socket.js');
const db = require('../../../config/db.js');
const { sendGradeVisibilityEmail } = require('../../services/mailer.service.js')

const sendNotification = async ({
  userId,
  studentId = null,
  gradeItemId = null,
  refKey = null,
  title,
  message,
  type = 'info',
}) => {
  let studentName = null;

  if (studentId) {
    const [rows] = await db.query(
      `SELECT CONCAT(first_name, ' ', last_name) AS name FROM elem_students WHERE id = ?`,
      [studentId]
    );
    studentName = rows[0]?.name ?? null;
  }

  const finalMessage = message;

  const [result] = await db.query(
    `INSERT INTO notifications
       (user_id, student_id, grade_item_id, ref_key, title, message, type, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, false, NOW())`,
    [userId, studentId, gradeItemId, refKey, title, finalMessage, type]
  );

  const notification = {
    id: result.insertId,
    userId,
    studentId,
    studentName,
    refKey,
    title,
    message: finalMessage,
    type,
    isRead: false,
    createdAt: new Date().toISOString(),
  };

  try {
    getIO().to(`user:${userId}`).emit('notification:new', notification);
  } catch (err) {
    console.error('Socket emit failed:', err.message);
  }

  return notification;
};

const TAB_LABEL = {
  writtenWorks: "a written work",
  performanceTask: "a performance task",
  exams: "an examination",
};

const notifyMissedActivity = async ({ studentId, itemId }) => {
  const [rows] = await db.query(
    `SELECT gi.tab AS tab, es.first_name AS firstName, pt.user_id AS userId
     FROM grade_items gi
     JOIN elem_students es ON es.id = ?
     JOIN parent_student ps ON ps.student_id = es.id
     JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
     WHERE gi.id = ?`,
    [studentId, itemId]
  );

  let sent = 0;

  for (const row of rows) {
    if (!row.userId) continue;

    const [existing] = await db.query(
      `SELECT id FROM notifications
       WHERE user_id = ? AND student_id = ? AND grade_item_id = ? AND title = 'Missed Activity'
       LIMIT 1`,
      [row.userId, studentId, itemId]
    );
    if (existing.length) continue;

    await sendNotification({
      userId: row.userId,
      studentId,
      gradeItemId: itemId,
      title: 'Missed Activity',
      message: `${row.firstName} missed ${TAB_LABEL[row.tab] ?? 'an activity'}.`,
      type: 'warning',
    });
    sent++;
  }

  return sent;
};

const notifyMissingForItem = async (itemId) => {
  const [students] = await db.query(
    `SELECT es.id AS studentId
     FROM grade_items gi
     JOIN \`subject-section\` ss ON ss.id = gi.subject_section_id
     JOIN elem_subjects sub ON sub.id = ss.subject_id
     JOIN elem_students es
       ON es.is_deleted = 0
      AND (
            (ss.section_id IS NOT NULL AND es.section_id = ss.section_id)
         OR (ss.section_id IS NULL AND es.grade_level_id = sub.grade_level_id)
          )
     LEFT JOIN grade_scores gs ON gs.item_id = gi.id AND gs.student_id = es.id
     WHERE gi.id = ? AND gs.score IS NULL`,
    [itemId]
  );

  let sent = 0;
  for (const { studentId } of students) {
    sent += await notifyMissedActivity({ studentId, itemId });
  }

  return { missing: students.length, notified: sent };
};

function formatWeek(weekStartDate) {
  const d = new Date(`${weekStartDate}T00:00:00`);
  const month = d
    .toLocaleDateString('en-US', { month: 'short' })
    .replace(/^Sep$/, 'Sept');
  return `${month} ${d.getDate()}`;
}

const notifyWeeklyEvaluationIfComplete = async ({ studentId, weekStartDate, termNumber }) => {
  const [subjects] = await db.query(
    `SELECT ss.id, COUNT(DISTINCT hr.axis) AS axes
     FROM elem_students es
     JOIN \`subject-section\` ss ON ss.status = 'Active'
     JOIN school_year sy ON sy.id = ss.school_year_id AND sy.is_active = 1
     JOIN elem_subjects sub ON sub.id = ss.subject_id
     LEFT JOIN holistic_ratings hr
       ON hr.subject_section_id = ss.id
      AND hr.student_id = es.id
      AND hr.week_start_date = ?
      AND hr.term_number = ?
     WHERE es.id = ?
       AND sub.isGraded = 1
       AND (
             (ss.section_id IS NOT NULL AND ss.section_id = es.section_id)
          OR (ss.section_id IS NULL AND sub.grade_level_id = es.grade_level_id)
           )
     GROUP BY ss.id`,
    [weekStartDate, termNumber, studentId]
  );

  const isComplete =
    subjects.length > 0 && subjects.every((s) => Number(s.axes) === 4);
  if (!isComplete) return 0;

  const [rows] = await db.query(
    `SELECT es.first_name AS firstName, pt.user_id AS userId
     FROM elem_students es
     JOIN parent_student ps ON ps.student_id = es.id
     JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
     WHERE es.id = ?`,
    [studentId]
  );

  const refKey = `holistic:${weekStartDate}`;
  let sent = 0;

  for (const row of rows) {
    if (!row.userId) continue;

    const [existing] = await db.query(
      `SELECT id FROM notifications
       WHERE user_id = ? AND student_id = ? AND ref_key = ?
       LIMIT 1`,
      [row.userId, studentId, refKey]
    );
    if (existing.length) continue;

    await sendNotification({
      userId: row.userId,
      studentId,
      refKey,
      title: 'Weekly Evaluation',
      message: `${row.firstName}'s weekly evaluation for the week of ${formatWeek(weekStartDate)} is ready.`,
      type: 'info',
    });
    sent++;
  }

  return sent;
};

const notifyAbsence = async ({ studentId, date }) => {
  const [rows] = await db.query(
    `SELECT es.first_name AS firstName, pt.user_id AS userId
     FROM elem_students es
     JOIN parent_student ps ON ps.student_id = es.id
     JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
     WHERE es.id = ?`,
    [studentId]
  );

  const refKey = `attendance:${date}`;
  let sent = 0;

  for (const row of rows) {
    if (!row.userId) continue;

    const [existing] = await db.query(
      `SELECT id FROM notifications
       WHERE user_id = ? AND student_id = ? AND ref_key = ?
       LIMIT 1`,
      [row.userId, studentId, refKey]
    );
    if (existing.length) continue;

    await sendNotification({
      userId: row.userId,
      studentId,
      refKey,
      title: "Absent",
      message: `${row.firstName} was marked absent on ${formatWeek(date)}.`,
      type: "error",
    });
    sent++;
  }

  return sent;
};

const notifyGradeVisibility = async ({ studentId, gradingPeriodId }) => {
  const [rows] = await db.query(
    `SELECT es.first_name AS firstName, pt.user_id AS userId, pt.email_address AS parentEmail,
            gp.term_label AS termLabel
     FROM elem_students es
     JOIN parent_student ps ON ps.student_id = es.id
     JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
     JOIN grading_periods gp ON gp.id = ?
     WHERE es.id = ?`,
    [gradingPeriodId, studentId]
  );

  const refKey = `grades:${gradingPeriodId}`;
  let sent = 0;

  for (const row of rows) {
    if (!row.userId) continue;

    const [existing] = await db.query(
      `SELECT id FROM notifications
       WHERE user_id = ? AND student_id = ? AND ref_key = ?
       LIMIT 1`,
      [row.userId, studentId, refKey]
    );
    if (existing.length) continue;

    await sendNotification({
      userId: row.userId,
      studentId,
      refKey,
      title: "Grades Released",
      message: `${row.firstName}'s grades are now available to view.`,
      type: "success",
    });

    if (row.parentEmail) {
      try {
        await sendGradeVisibilityEmail({
          to: row.parentEmail,
          studentId, 
          studentFirstName: row.firstName,
          termLabel: row.termLabel,
        });
      } catch (emailErr) {
        console.error(`Grade visibility email error (student ${studentId}):`, emailErr);
      }
    }

    sent++;
  }

  return sent;
};

const notifyLowGradeScore = async ({ studentId, itemId }) => {
  const [rows] = await db.query(
    `SELECT
       gi.max_items AS maxItems,
       gs.score AS score,
       lt.topic_name AS topicName,
       lt.developing_threshold_percent AS threshold,
       es.first_name AS firstName,
       pt.user_id AS userId
     FROM grade_items gi
     INNER JOIN grade_scores gs ON gs.item_id = gi.id AND gs.student_id = ?
     INNER JOIN learning_topics lt ON lt.id = gi.topic_id
     INNER JOIN elem_students es ON es.id = ?
     INNER JOIN parent_student ps ON ps.student_id = es.id
     INNER JOIN parent_table pt ON pt.id = ps.parent_id AND pt.is_deleted = 0
     WHERE gi.id = ? AND gs.score IS NOT NULL`,
    [studentId, studentId, itemId]
  );

  if (rows.length === 0) return 0; 

  const { maxItems, score, topicName, threshold } = rows[0];
  if (!maxItems) return 0;

  const percentage = (Number(score) / Number(maxItems)) * 100;
  if (percentage > threshold) return 0;

  const refKey = `lowgrade:${itemId}:${studentId}`;
  let sent = 0;

  for (const row of rows) {
    if (!row.userId) continue;

    const [existing] = await db.query(
      `SELECT id FROM notifications
       WHERE user_id = ? AND student_id = ? AND ref_key = ?
       LIMIT 1`,
      [row.userId, studentId, refKey]
    );
    if (existing.length) continue; 

    await sendNotification({
      userId: row.userId,
      studentId,
      gradeItemId: itemId,
      refKey,
      title: 'Low Score Alert',
      message: `${row.firstName} scored ${percentage.toFixed(0)}% in "${topicName}", which needs improvement.`,
      type: 'warning',
    });
    sent++;
  }

  return sent;
};

// ==================== TEACHER'S NOTIF =======================

const notifySubjectGradeSubmission = async ({ subjectSectionId, gradingPeriodId, submittedBy }) => {
  const [rows] = await db.query(
    `SELECT
       tt.first_name AS teacherFirstName,
       tt.last_name AS teacherLastName,
       sub.subject_name AS subjectName,
       adviser.user_id AS adviserUserId
     FROM \`subject-section\` ss
     JOIN elem_subjects sub ON sub.id = ss.subject_id
     JOIN teacher_table tt ON tt.id = ss.teacher_id
     JOIN classes c ON c.section_id = ss.section_id
     JOIN teacher_table adviser ON adviser.id = c.class_adviser_id
     WHERE ss.id = ?`,
    [subjectSectionId]
  );

  if (rows.length === 0) return 0;

  const { teacherFirstName, teacherLastName, subjectName, adviserUserId } = rows[0];
  if (!adviserUserId) return 0;

  // walang dedupe check — bawat submit/resubmit ay bagong notification
  await sendNotification({
    userId: adviserUserId,
    refKey: `gradesubmit:${subjectSectionId}:${gradingPeriodId}:${Date.now()}`,
    title: 'Grade Submission',
    message: `${teacherFirstName} ${teacherLastName} has submitted grades for ${subjectName}.`,
    type: 'info',
  });

  return 1;
};

module.exports = {
  sendNotification,
  notifyMissedActivity,
  notifyMissingForItem,
  notifyWeeklyEvaluationIfComplete,
  notifyAbsence,
  notifyGradeVisibility,
  notifyLowGradeScore,
  notifySubjectGradeSubmission,
};
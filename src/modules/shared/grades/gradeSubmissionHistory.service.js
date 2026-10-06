const connection = require("../../../../config/db");

let tableReady;

async function ensureGradeSubmissionHistoryTable() {
  if (!tableReady) {
    tableReady = connection.execute(`
      CREATE TABLE IF NOT EXISTS grade_submission_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        submission_type ENUM('subject', 'advisory') NOT NULL,
        section_id BIGINT NULL,
        grade_level_id BIGINT NULL,
        subject_section_id BIGINT NULL,
        grading_period_id BIGINT NOT NULL,
        submitted_by BIGINT NOT NULL,
        submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_grade_history_section (section_id, grading_period_id, submitted_at),
        INDEX idx_grade_history_grade (grade_level_id, grading_period_id, submitted_at),
        INDEX idx_grade_history_subject (subject_section_id, grading_period_id, submitted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `).then(() => true).catch((error) => {
      tableReady = null;
      throw error;
    });
  }
  return tableReady;
}

async function recordSubjectGradeSubmission({ subjectSectionId, gradingPeriodId, teacherId }) {
  await ensureGradeSubmissionHistoryTable();
  await connection.execute(
    `INSERT INTO grade_submission_history
      (submission_type, subject_section_id, grading_period_id, submitted_by)
     VALUES ('subject', ?, ?, ?)`,
    [subjectSectionId, gradingPeriodId, teacherId],
  );
}

async function recordAdvisoryGradeSubmission({ sectionId, gradeLevelId, gradingPeriodId, teacherId }) {
  await ensureGradeSubmissionHistoryTable();
  await connection.execute(
    `INSERT INTO grade_submission_history
      (submission_type, section_id, grade_level_id, grading_period_id, submitted_by)
     VALUES ('advisory', ?, ?, ?, ?)`,
    [sectionId ?? null, gradeLevelId, gradingPeriodId, teacherId],
  );
}

async function getAdvisorySubmissionHistory({ sectionId, gradeLevelId, gradingPeriodId }) {
  await ensureGradeSubmissionHistoryTable();

  const subjectSectionSql = sectionId
    ? `SELECT ss.id
       FROM \`subject-section\` ss
       INNER JOIN elem_subjects es ON es.id = ss.subject_id
       WHERE ss.status = 'Active'
         AND (ss.section_id = ? OR (ss.section_id IS NULL AND es.grade_level_id = ?))`
    : `SELECT ss.id
       FROM \`subject-section\` ss
       WHERE ss.status = 'Active' AND ss.section_id IS NULL AND ss.subject_id IN (
         SELECT id FROM elem_subjects WHERE grade_level_id = ?
       )`;

  const [rows] = await connection.execute(
    `SELECT h.id,
            h.submission_type AS type,
            CASE WHEN h.submission_type = 'subject' THEN es.subject_name ELSE 'Advisory gradebook' END AS label,
            CONCAT(t.first_name, ' ', t.last_name) AS submittedByName,
            DATE_FORMAT(h.submitted_at, '%Y-%m-%dT%H:%i:%sZ') AS submittedAt
     FROM grade_submission_history h
     LEFT JOIN \`subject-section\` ss ON ss.id = h.subject_section_id
     LEFT JOIN elem_subjects es ON es.id = ss.subject_id
     LEFT JOIN teacher_table t ON t.id = h.submitted_by
     WHERE h.grading_period_id = ?
       AND (
         (h.submission_type = 'advisory' AND ${sectionId ? "h.section_id = ?" : "h.section_id IS NULL AND h.grade_level_id = ?"})
         OR (h.submission_type = 'subject' AND h.subject_section_id IN (${subjectSectionSql}))
       )
     ORDER BY h.submitted_at DESC, h.id DESC
     LIMIT 50`,
    sectionId
      ? [gradingPeriodId, sectionId, sectionId, gradeLevelId]
      : [gradingPeriodId, gradeLevelId, gradeLevelId],
  );

  return rows;
}

module.exports = {
  ensureGradeSubmissionHistoryTable,
  recordSubjectGradeSubmission,
  recordAdvisoryGradeSubmission,
  getAdvisorySubmissionHistory,
};

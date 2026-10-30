const connection = require('../../../../config/db');
const { recordSubjectGradeSubmission, recordAdvisoryGradeSubmission } = require('./gradeSubmissionHistory.service');
const { recalcOverallAverage } = require('./gradeCache.service');

const reject = (code, message, outcome = 'not_saved') => { const error = new Error(message); error.statusCode = code; error.outcome = outcome; throw error; };
const validId = value => (typeof value === 'number' || typeof value === 'string') && /^[1-9][0-9]*$/.test(String(value));
// The existing monotonically increasing history ID supplies a comparison token,
// not a new idempotency key. No DDL or nested connection is allowed here.
async function submissionVersion(db, kind, column, value, period) {
  const [rows] = await db.execute(
    `SELECT id FROM grade_submission_history WHERE submission_type = ? AND ${column} = ? ${kind === 'advisory' && column === 'grade_level_id' ? 'AND section_id IS NULL' : ''} AND grading_period_id = ? ORDER BY id DESC LIMIT 1`,
    [kind, value, period]);
  return rows.length ? String(rows[0].id) : null;
}
async function runGradeSubmission(req, kind, validate = async () => {}) {
  let db, active = false, commitAttempted = false, discard = false;
  let status = 200, body = { success: true }, notification = false;
  try {
    const { gradingPeriodId: period, expectedSubmissionVersion: expected } = req.body;
    const conditional = Object.hasOwn(req.body, 'expectedSubmissionVersion');
    if (!validId(period)) reject(400, 'A valid gradingPeriodId is required.');
    if (conditional && expected !== null && !validId(expected)) reject(400, 'Invalid submission version.');
    if (!validId(req.teacherId)) reject(403, 'Teacher assignment is required.');
    db = await connection.getConnection();
    try { await db.beginTransaction(); active = true; } catch (error) { discard = true; throw error; }
    // Keep eligibility current without opening an early consistent-read snapshot.
    // This year lock also prevents a coordinated year switch until completion.
    const [years] = await db.execute('SELECT id FROM school_year WHERE is_active = 1 ORDER BY id DESC LIMIT 1 FOR UPDATE');
    if (!years.length) reject(403, 'A current school year is required for submission.');
    const yearId = years[0].id;
    let scope;
    if (kind === 'subject') {
      const [rows] = await db.execute(`SELECT ss.id, ss.section_id AS sectionId, es.grade_level_id AS gradeLevelId, ss.school_year_id AS schoolYearId
        FROM \`subject-section\` ss INNER JOIN elem_subjects es ON es.id = ss.subject_id
        WHERE ss.id = ? AND ss.teacher_id = ? AND ss.school_year_id = ? AND es.is_graded = 1 FOR UPDATE`,
        [req.subjectSection.id, req.teacherId, yearId]);
      if (!rows.length) reject(403, 'You do not own this subject in the current school year.');
      scope = rows[0];
    } else {
      const [rows] = await db.execute(`SELECT c.id, c.section_id AS sectionId, c.grade_level_id AS gradeLevelId, c.school_year_id AS schoolYearId
        FROM classes c WHERE c.id = ? AND c.class_adviser_id = ? AND c.status = 'Active'
        AND c.school_year_id = ? FOR UPDATE`,
        [req.advisorySection.classId, req.teacherId, yearId]);
      if (!rows.length) reject(403, 'You do not advise this class in the current school year.');
      scope = rows[0];
      // Serialize even if multiple legacy class rows reference the same scope.
      await db.execute(scope.sectionId ? 'SELECT id FROM grade_level_sections WHERE id = ? FOR UPDATE' : 'SELECT id FROM grade_level WHERE id = ? FOR UPDATE', [scope.sectionId || scope.gradeLevelId]);
    }
    const [periods] = await db.execute('SELECT id FROM grading_periods WHERE id = ? AND school_year_id = ? AND term_number BETWEEN 1 AND 3 FOR UPDATE', [period, scope.schoolYearId]);
    if (!periods.length) reject(400, 'The grading period must belong to this class school year and be Term 1, 2, or 3.');
    // Inactive periods in the same current year remain eligible for deliberate
    // resubmission, matching the existing term picker and prerequisites.
    const tables = ['school_year','grading_periods','subject-section','classes','elem_students','grade_submissions','subject_grade_submissions','grade_submission_history','subject_grade_cache','advisory_overall_grades', 'grade_level_sections', 'grade_level'];
    const [engines] = await db.execute(`SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')})`, tables);
    if (tables.some(name => !engines.some(row => row.tableName === name && row.engine?.toUpperCase() === 'INNODB'))) throw Error('Submission requires existing InnoDB submission, history and grading tables.');
    const table = kind === 'subject' ? 'subject_grade_submissions' : 'grade_submissions';
    const column = kind === 'subject' ? 'subject_section_id' : scope.sectionId ? 'section_id' : 'grade_level_id';
    const value = kind === 'subject' ? req.subjectSection.id : scope.sectionId || scope.gradeLevelId;
    const [indexes] = await db.execute(`SELECT INDEX_NAME AS indexName, COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0 ORDER BY INDEX_NAME, SEQ_IN_INDEX`, [table]);
    const keys = new Map();
    for (const row of indexes) { if (!keys.has(row.indexName)) keys.set(row.indexName, []); keys.get(row.indexName).push(row.columnName); }
    if (![...keys.values()].some(cols => cols.length === 2 && cols.includes(column) && cols.includes('grading_period_id'))) throw Error('Submission requires an existing unique class/period key.');
    // Match F09/F10 subject -> student lock order. All student locks precede
    // consistent cache/history reads and are shared by both submission paths.
    const [students] = await db.execute(`SELECT id FROM elem_students WHERE ${scope.sectionId ? 'section_id = ?' : 'section_id IS NULL AND grade_level_id = ?'} AND is_deleted = 0 AND status <> 'graduated' AND current_school_year_id = ? ORDER BY id FOR UPDATE`, [scope.sectionId || scope.gradeLevelId, scope.schoolYearId]);
    const [existing] = await db.execute(`SELECT submitted_by FROM ${table} WHERE ${column} = ? AND grading_period_id = ? FOR UPDATE`, [value, period]);
    const version = await submissionVersion(db, kind, column, value, period);
    if (conditional && (expected === null ? null : String(expected)) !== version) reject(409, 'Submission state changed. Reload this class to check its submission status and history before submitting again.', 'conflict');
    // Legacy clients have no evidence of a deliberate resubmission. Keep an
    // already submitted operation a no-op rather than creating duplicate history.
    if (!existing.length || conditional) {
      await validate(db);
      await db.execute(`INSERT INTO ${table} (${column}, grading_period_id, submitted_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE submitted_by = VALUES(submitted_by), submitted_at = CURRENT_TIMESTAMP`, [value, period, req.teacherId]);
      const history = { subjectSectionId: req.subjectSection?.id, sectionId: scope.sectionId, gradeLevelId: scope.gradeLevelId, gradingPeriodId: period, teacherId: req.teacherId };
      await (kind === 'subject' ? recordSubjectGradeSubmission : recordAdvisoryGradeSubmission)(history, db);
      for (const student of students) await recalcOverallAverage(student.id, period, db);
      notification = true;
    } else body.alreadySubmitted = true;
    commitAttempted = true;
    await db.commit(); active = false;
  } catch (error) {
    notification = false;
    console.error('Grade submission failed:', error);
    if (commitAttempted) {
      discard = true; status = 503;
      body = { success: false, outcome: 'uncertain', message: 'Grade submission could not be confirmed. Reload this class to check submission status and history before submitting again.' };
    } else {
      if (active) { try { await db.rollback(); } catch (rollbackError) { discard = true; console.error('Submission rollback failed:', rollbackError); } }
      status = [400,403,409].includes(error.statusCode) ? error.statusCode : 500;
      body = { success: false, outcome: error.outcome || 'not_saved', message: status === 500 ? 'Grade submission was not saved. Please try again.' : error.message };
    }
  } finally {
    if (db) { try { if (discard) db.destroy(); else db.release(); } catch (error) { console.error('Submission cleanup failed:', error); if (!discard) { try { db.destroy(); } catch (destroyError) { console.error('Submission destruction failed:', destroyError); } } } }
  }
  return { status, body, notification };
}
module.exports = { runGradeSubmission, submissionVersion };

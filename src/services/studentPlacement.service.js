const MAX_ASSIGNMENT_BATCH = 200;

function fail(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  throw error;
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// All placement writers acquire this lock before sections/classes/students.
// The transition already locks these same active-year rows before promoting.
async function lockActiveYear(conn, expectedId) {
  const [years] = await conn.query('SELECT id, school_year FROM school_year WHERE is_active = 1 ORDER BY id FOR UPDATE');
  if (years.length !== 1) fail(409, 'Exactly one active school year is required. Refresh or configure the academic year.');
  if (expectedId !== undefined && Number(years[0].id) !== expectedId) fail(409, 'The active school year changed. Refresh and select students again.');
  return years[0];
}

async function lockTarget(conn, schoolYearId, gradeLevelId, sectionId) {
  const [sections] = await conn.query('SELECT id, section_name, grade_level_id, school_year_id, is_active FROM grade_level_sections WHERE id = ? FOR UPDATE', [sectionId]);
  const section = sections[0];
  if (!section || !Number(section.is_active) || Number(section.grade_level_id) !== gradeLevelId || Number(section.school_year_id) !== schoolYearId) {
    fail(409, 'Choose an active section in this grade and school year.');
  }
  const [classes] = await conn.query("SELECT id FROM classes WHERE section_id = ? AND grade_level_id = ? AND school_year_id = ? AND status = 'Active' ORDER BY id FOR UPDATE", [sectionId, gradeLevelId, schoolYearId]);
  if (classes.length !== 1) fail(409, 'The section needs one active class in the selected grade and school year.');
  return section;
}

function validateBatch(body) {
  const { schoolYearId, gradeLevelId, sectionId, studentIds } = body ?? {};
  if (![schoolYearId, gradeLevelId, sectionId].every(positiveId) || !Array.isArray(studentIds) || studentIds.length < 1 || studentIds.length > MAX_ASSIGNMENT_BATCH || !studentIds.every(positiveId)) {
    fail(400, `Use positive integer IDs and select 1–${MAX_ASSIGNMENT_BATCH} students.`);
  }
  if (new Set(studentIds).size !== studentIds.length) fail(400, 'Duplicate student IDs are not allowed.');
  return { schoolYearId, gradeLevelId, sectionId, studentIds: [...studentIds].sort((a, b) => a - b) };
}

async function assignStudents(conn, body) {
  const input = validateBatch(body);
  const { schoolYearId, gradeLevelId, sectionId, studentIds } = input;
  const year = await lockActiveYear(conn, schoolYearId);
  const [grades] = await conn.query('SELECT id, grade_level FROM grade_level WHERE id = ?', [gradeLevelId]);
  if (!grades.length) fail(400, 'Grade level not found.');
  const section = await lockTarget(conn, schoolYearId, gradeLevelId, sectionId);
  const placeholders = studentIds.map(() => '?').join(',');
  const [students] = await conn.query(`SELECT id, grade_level_id, section_id, current_school_year_id, is_deleted, status FROM elem_students WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`, studentIds);
  if (students.length !== studentIds.length) fail(404, 'One or more selected students no longer exist. Refresh the list.');
  if (students.some(s => Number(s.is_deleted) !== 0 || s.status === 'graduated' || s.section_id !== null || Number(s.grade_level_id) !== gradeLevelId || Number(s.current_school_year_id) !== schoolYearId)) {
    fail(409, 'One or more students changed or are already assigned. Refresh and select unassigned students again.');
  }
  const [result] = await conn.query(`UPDATE elem_students SET section_id = ? WHERE id IN (${placeholders}) AND section_id IS NULL AND current_school_year_id = ? AND grade_level_id = ? AND is_deleted = 0 AND status <> 'graduated'`, [sectionId, ...studentIds, schoolYearId, gradeLevelId]);
  if (result.affectedRows !== studentIds.length) fail(409, 'The selected students changed. No assignments were saved.');
  return { assignedCount: studentIds.length, schoolYear: { id: schoolYearId, label: year.school_year }, gradeLevel: { id: gradeLevelId, label: grades[0].grade_level }, section: { id: sectionId, label: section.section_name } };
}

module.exports = { MAX_ASSIGNMENT_BATCH, positiveId, fail, lockActiveYear, lockTarget, validateBatch, assignStudents };

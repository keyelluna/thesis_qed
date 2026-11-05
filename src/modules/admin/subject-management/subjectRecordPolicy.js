const LOCK_MESSAGE = 'Grade level, section, and school year cannot be changed after academic records exist. Create a new assignment instead.';
// Weight/template configuration alone is not an academic record.
function recordsExistSql(assignment) {
  return '(' + ['grade_items', 'grade_scores', 'subject_grade_cache', 'subject_grade_submissions', 'holistic_ratings'].map(table => table === 'grade_scores'
    ? `EXISTS (SELECT 1 FROM grade_scores rs JOIN grade_items ri ON ri.id=rs.item_id WHERE ri.subject_section_id=${assignment})`
    : `EXISTS (SELECT 1 FROM ${table} r WHERE r.subject_section_id=${assignment})`).join(' OR ') + ')';
}
async function hasRecords(db, id, subjectId, shared = false) {
  if(shared) await db.query('SELECT id FROM `subject-section` WHERE subject_id=? ORDER BY id FOR UPDATE',[subjectId]);
  const [rows] = await db.query(`SELECT EXISTS (SELECT 1 FROM \`subject-section\` protected_assignment WHERE ${shared ? 'protected_assignment.subject_id' : 'protected_assignment.id'}=? AND ${recordsExistSql('protected_assignment.id')}) AS locked`, [shared ? subjectId : id]);
  return Boolean(Number(rows[0]?.locked));
}
module.exports = {LOCK_MESSAGE, recordsExistSql, hasRecords};

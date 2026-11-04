// One-time repair: preview by default. Never run automatically in an API request.
// From the backend folder: node src/modules/teacher/holistic/repairHolisticTerms.js
// Apply a reviewed preview: add --apply --school-year-id=7 (use the reviewed year ID).
async function repairHolisticTerms(db, { apply = false, schoolYearId } = {}) {
  if (apply && (!Number.isInteger(schoolYearId) || schoolYearId <= 0)) throw new Error('Applying requires an explicit --school-year-id from the preview.');
  let transaction = false;
  try {
    if (apply) { await db.beginTransaction(); transaction = true; }
    const [rows] = await db.execute(`SELECT hr.subject_section_id AS subjectSectionId, hr.student_id AS studentId,
      DATE_FORMAT(hr.week_start_date, '%Y-%m-%d') AS weekStartDate, hr.axis, hr.rating,
      hr.term_number AS oldTerm, gp.term_number AS newTerm, ss.school_year_id AS schoolYearId
      FROM holistic_ratings hr INNER JOIN \`subject-section\` ss ON ss.id = hr.subject_section_id
      INNER JOIN school_year sy ON sy.id = ss.school_year_id
      INNER JOIN grading_periods gp ON gp.school_year_id = ss.school_year_id
        AND hr.week_start_date >= gp.start_date
        AND DATE_ADD(hr.week_start_date, INTERVAL 4 DAY) <= gp.end_date
      WHERE WEEKDAY(hr.week_start_date) = 0 AND hr.term_number <> gp.term_number AND ${schoolYearId ? 'sy.id = ?' : 'sy.is_active = 1'}
      ORDER BY ss.school_year_id, hr.subject_section_id, hr.student_id, hr.week_start_date, hr.axis${apply ? ' FOR UPDATE' : ''}`, schoolYearId ? [schoolYearId] : []);
    const changes = [], conflicts = [], seen = new Set();
    for (const row of rows) {
      const key = [row.subjectSectionId,row.studentId,row.weekStartDate,row.oldTerm,row.axis].join(':');
      if (seen.has(key)) { conflicts.push({ ...row, reason: 'Overlapping configured term dates' }); continue; }
      seen.add(key);
      const [existing] = await db.execute(`SELECT rating FROM holistic_ratings WHERE subject_section_id = ? AND student_id = ? AND week_start_date = ? AND term_number = ? AND axis = ?${apply ? ' FOR UPDATE' : ''}`,
        [row.subjectSectionId,row.studentId,row.weekStartDate,row.newTerm,row.axis]);
      if (existing.length) conflicts.push({ ...row, reason: 'The correct term already has a rating; manual review required' });
      else changes.push(row);
    }
    if (apply && conflicts.length) throw new Error('Repair stopped without changes: conflicting ratings or term dates require manual review.');
    if (apply) {
      for (const row of changes) {
        const [result] = await db.execute(`UPDATE holistic_ratings SET term_number = ? WHERE subject_section_id = ? AND student_id = ? AND week_start_date = ? AND term_number = ? AND axis = ? AND rating = ?`,
          [row.newTerm,row.subjectSectionId,row.studentId,row.weekStartDate,row.oldTerm,row.axis,row.rating]);
        if (result.affectedRows !== 1) throw new Error('A rating changed during review. Repair rolled back; run a new preview.');
      }
      await db.commit(); transaction = false;
    }
    return { mode: apply ? 'applied' : 'preview-only', changes, conflicts, note: 'Only complete Monday-Friday weeks inside one configured term are candidates. Boundary weeks are left for manual review.' };
  } catch (error) { if (transaction) await db.rollback(); throw error; }
}
module.exports = { repairHolisticTerms };
if (require.main === module) {
  require('dotenv').config({ quiet: true });
  const pool = require('../../../../config/db');
  const apply = process.argv.includes('--apply');
  const value = process.argv.find(arg => arg.startsWith('--school-year-id='))?.split('=')[1];
  const schoolYearId = value === undefined ? undefined : Number(value);
  (async () => {
    let db;
    try {
      if (value !== undefined && (!Number.isInteger(schoolYearId) || schoolYearId <= 0)) throw new Error('Invalid school year ID.');
      db = await pool.getConnection();
      console.log(JSON.stringify(await repairHolisticTerms(db, {apply,schoolYearId}), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
    finally { db?.release(); await pool.end(); }
  })();
}

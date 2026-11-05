// Dropout declarations are enrollment events, never deletion of academic history.
function activeOnDateSql(student, year, date) {
  return `NOT EXISTS (SELECT 1 FROM student_dropout_events academic_dropout WHERE academic_dropout.student_id = ${student} AND academic_dropout.school_year_id = ${year} AND academic_dropout.reversed_at IS NULL AND academic_dropout.effective_date <= ${date})`;
}
function eligibleForPeriodSql(student, period) {
  return `NOT EXISTS (SELECT 1 FROM student_dropout_events academic_dropout JOIN grading_periods dropout_period ON dropout_period.school_year_id = academic_dropout.school_year_id WHERE dropout_period.id = ${period} AND academic_dropout.student_id = ${student} AND academic_dropout.reversed_at IS NULL AND academic_dropout.effective_date <= dropout_period.end_date)`;
}
function dropoutDateSql(student, year) {
  return `(SELECT DATE_FORMAT(MIN(academic_dropout.effective_date),'%Y-%m-%d') FROM student_dropout_events academic_dropout WHERE academic_dropout.student_id = ${student} AND academic_dropout.school_year_id = ${year} AND academic_dropout.reversed_at IS NULL)`;
}
async function periodDropouts(db, period) {
  const [rows] = await db.execute(`SELECT d.student_id AS studentId, DATE_FORMAT(d.effective_date,'%Y-%m-%d') AS effectiveDate, d.reason FROM student_dropout_events d JOIN grading_periods gp ON gp.school_year_id = d.school_year_id WHERE gp.id = ? AND d.reversed_at IS NULL AND d.effective_date <= gp.end_date`, [period]);
  return new Map(rows.map(row => [String(row.studentId), {effectiveDate:row.effectiveDate,eventType:row.reason==='Transferred out'?'transfer':'dropout'}]));
}
async function assertPeriodWriteAllowed(db, student, period) {
  const dropped = await periodDropouts(db, period);
  if (dropped.has(String(student))) throw Object.assign(new Error((dropped.get(String(student))?.eventType==='transfer'?'Transferred Out':'Dropped')+' for this term. Reverse the declaration before changing scores.'), {statusCode:409});
}
async function saveHolisticRating(pool, {subjectSectionId, studentId, weekStartDate, termNumber, axis, value}) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    // Serialize with declaration/reversal, which locks this same student row.
    await db.execute('SELECT id FROM elem_students WHERE id = ? FOR UPDATE', [studentId]);
    const [rows] = await db.execute(`SELECT d.id FROM student_dropout_events d JOIN \`subject-section\` ss ON ss.school_year_id=d.school_year_id WHERE ss.id=? AND d.student_id=? AND d.reversed_at IS NULL AND d.effective_date<=DATE_ADD(?, INTERVAL 4 DAY) LIMIT 1`, [subjectSectionId,studentId,weekStartDate]);
    if(rows.length) throw Object.assign(new Error('Holistic evaluation is locked from the student departure week onward. Earlier records remain available.'),{statusCode:409});
    await db.execute(`INSERT INTO holistic_ratings (subject_section_id, student_id, week_start_date, term_number, axis, rating) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,[subjectSectionId,studentId,weekStartDate,termNumber,axis,value]);
    await db.commit();
  } catch(error) { await db.rollback(); throw error; } finally { db.release(); }
}
async function studentDroppedPeriods(db, studentId, yearId) {
 const [rows]=await db.execute(`SELECT gp.id, d.reason FROM grading_periods gp JOIN student_dropout_events d ON d.school_year_id=gp.school_year_id AND d.student_id=? AND d.reversed_at IS NULL AND d.effective_date<=gp.end_date WHERE gp.school_year_id=?`,[studentId,yearId]);
 return new Map(rows.map(row=>[String(row.id),row.reason==='Transferred out'?'transfer':'dropout']));
}
function withdrawalTypeSql(student,year){return `(SELECT CASE WHEN academic_dropout.reason='Transferred out' THEN 'transfer' ELSE 'dropout' END FROM student_dropout_events academic_dropout WHERE academic_dropout.student_id=${student} AND academic_dropout.school_year_id=${year} AND academic_dropout.reversed_at IS NULL LIMIT 1)`;}
module.exports={withdrawalTypeSql,studentDroppedPeriods,activeOnDateSql,eligibleForPeriodSql,dropoutDateSql,periodDropouts,assertPeriodWriteAllowed,saveHolisticRating};

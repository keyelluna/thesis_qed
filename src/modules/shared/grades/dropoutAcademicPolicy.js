// Dropout declarations are enrollment events, never deletion of academic history.
function activeOnDateSql(student, year, date, term) {
  const joinCutoff=term?`LEAST(${date}, (SELECT MAX(enrollment_gp.end_date) FROM grading_periods enrollment_gp WHERE enrollment_gp.school_year_id=${year} AND enrollment_gp.term_number=${term}))`:date;
  return `NOT EXISTS (SELECT 1 FROM student_transfer_ins enrollment_join WHERE enrollment_join.student_id=${student} AND enrollment_join.school_year_id=${year} AND enrollment_join.joined_date>${joinCutoff}) AND NOT EXISTS (SELECT 1 FROM student_dropout_events academic_dropout WHERE academic_dropout.student_id = ${student} AND academic_dropout.school_year_id = ${year} AND academic_dropout.reversed_at IS NULL AND academic_dropout.effective_date <= ${date})`;
}
function eligibleForPeriodSql(student, period) {
  return `NOT EXISTS (SELECT 1 FROM grading_periods dropout_period WHERE dropout_period.id=${period} AND (EXISTS (SELECT 1 FROM student_dropout_events academic_dropout WHERE academic_dropout.student_id=${student} AND academic_dropout.school_year_id=dropout_period.school_year_id AND academic_dropout.reversed_at IS NULL AND academic_dropout.effective_date<=dropout_period.end_date) OR EXISTS (SELECT 1 FROM student_transfer_ins enrollment_join WHERE enrollment_join.student_id=${student} AND enrollment_join.school_year_id=dropout_period.school_year_id AND enrollment_join.joined_date>dropout_period.end_date)))`;
}
function joinedDateSql(student,year){return `(SELECT DATE_FORMAT(enrollment_join.joined_date,'%Y-%m-%d') FROM student_transfer_ins enrollment_join WHERE enrollment_join.student_id=${student} AND enrollment_join.school_year_id=${year} LIMIT 1)`;}
async function periodNotEnrolled(db,period){
 const [rows]=await db.execute(`SELECT ti.student_id AS studentId, DATE_FORMAT(ti.joined_date,'%Y-%m-%d') AS joinedDate FROM student_transfer_ins ti JOIN grading_periods gp ON gp.school_year_id=ti.school_year_id WHERE gp.id=? AND ti.joined_date>gp.end_date`,[period]);
 return new Map(rows.map(row=>[String(row.studentId),row.joinedDate]));
}
async function studentNotEnrolledPeriods(db,student,year){
 const [rows]=await db.execute(`SELECT gp.id FROM grading_periods gp JOIN student_transfer_ins ti ON ti.school_year_id=gp.school_year_id AND ti.student_id=? AND ti.joined_date>gp.end_date WHERE gp.school_year_id=?`,[student,year]);return new Set(rows.map(row=>String(row.id)));
}
function dropoutDateSql(student, year) {
  return `(SELECT DATE_FORMAT(MIN(academic_dropout.effective_date),'%Y-%m-%d') FROM student_dropout_events academic_dropout WHERE academic_dropout.student_id = ${student} AND academic_dropout.school_year_id = ${year} AND academic_dropout.reversed_at IS NULL)`;
}
async function periodDropouts(db, period) {
  const [rows] = await db.execute(`SELECT d.student_id AS studentId, DATE_FORMAT(d.effective_date,'%Y-%m-%d') AS effectiveDate, d.reason FROM student_dropout_events d JOIN grading_periods gp ON gp.school_year_id = d.school_year_id WHERE gp.id = ? AND d.reversed_at IS NULL AND d.effective_date <= gp.end_date`, [period]);
  return new Map(rows.map(row => [String(row.studentId), {effectiveDate:row.effectiveDate,eventType:row.reason==='Transferred out'?'transfer':'dropout'}]));
}
async function assertPeriodWriteAllowed(db, student, period) {
  const notEnrolled=await periodNotEnrolled(db,period);
  if(notEnrolled.has(String(student)))throw Object.assign(new Error("Not enrolled in this term. The term ended before the student joined."),{statusCode:409});
  const dropped = await periodDropouts(db, period);
  if (dropped.has(String(student))) throw Object.assign(new Error((dropped.get(String(student))?.eventType==='transfer'?'Transferred Out':'Dropped')+' for this term. Reverse the declaration before changing scores.'), {statusCode:409});
}
async function saveHolisticRating(pool, {subjectSectionId, studentId, weekStartDate, termNumber, axis, value}) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    await db.execute('SELECT id FROM `subject-section` WHERE id = ? FOR UPDATE', [subjectSectionId]);
    // Serialize with declaration/reversal, which locks this same student row.
    await db.execute('SELECT id FROM elem_students WHERE id = ? FOR UPDATE', [studentId]);
    const [notJoined]=await db.execute(`SELECT ti.student_id FROM student_transfer_ins ti JOIN \`subject-section\` ss ON ss.school_year_id=ti.school_year_id WHERE ss.id=? AND ti.student_id=? AND ti.joined_date>LEAST(DATE_ADD(?, INTERVAL 4 DAY),(SELECT MAX(gp.end_date) FROM grading_periods gp WHERE gp.school_year_id=ss.school_year_id AND gp.term_number=?)) LIMIT 1`,[subjectSectionId,studentId,weekStartDate,termNumber]);
    if(notJoined.length)throw Object.assign(new Error('Not enrolled during this week. Holistic recording starts in the joining week.'),{statusCode:409});
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
module.exports={joinedDateSql,periodNotEnrolled,studentNotEnrolledPeriods,withdrawalTypeSql,studentDroppedPeriods,activeOnDateSql,eligibleForPeriodSql,dropoutDateSql,periodDropouts,assertPeriodWriteAllowed,saveHolisticRating};

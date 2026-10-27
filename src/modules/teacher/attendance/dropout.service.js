const fs = require('node:fs');
const path = require('node:path');
const pool = require('../../../../config/db');
let ready;
function ensureDropoutTable() {
 if (!ready) ready=pool.query(fs.readFileSync(path.join(__dirname,'../../../../scripts/2026-10-27-student-dropout-events.sql'),'utf8')).catch(error=>{ready=null;throw error;});
 return ready;
}
const REASONS=['Prolonged absence','Personal or family circumstances','Health concerns','Financial difficulties','Other'];
const isoDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
function fail(status,message){throw Object.assign(new Error(message),{status});}
function consecutiveAbsences(marks,terms,asOf,holidays=[]) {
 const excluded=new Set(holidays);let count=0,since=null;
 if (!isoDate(asOf)) return {count,since};
 const cursor=new Date(asOf+'T12:00:00Z'),earliest=terms.map(t=>t.startDate).sort()[0];
 for(let n=0;earliest&&n<1500;n++,cursor.setUTCDate(cursor.getUTCDate()-1)){
  const date=cursor.toISOString().slice(0,10);if(date<earliest)break;
  if([0,6].includes(cursor.getUTCDay())||excluded.has(date)||!terms.some(t=>date>=t.startDate&&date<=t.endDate))continue;
  if(marks[date]!=='A')break;
  count++;since=date;
 }
 return {count,since};
}
async function activeDropouts(db,classId,yearId){
 const [rows]=await db.execute(`SELECT d.id,d.student_id AS studentId,DATE_FORMAT(d.last_attended,'%Y-%m-%d') AS lastAttended,
 DATE_FORMAT(d.effective_date,'%Y-%m-%d') AS effectiveDate,d.reason,d.remarks,
 DATE_FORMAT(d.declared_at,'%Y-%m-%d') AS declaredAt,
 CONCAT_WS(' ',t.first_name,NULLIF(t.middle_name,''),t.last_name) AS declaredByName,
 CONCAT_WS(', ',NULLIF(s.last_name,''),NULLIF(TRIM(CONCAT_WS(' ',s.first_name,NULLIF(s.middle_name,''))),'')) AS studentName
 FROM student_dropout_events d
 LEFT JOIN teacher_table t ON t.user_id=d.declared_by
 LEFT JOIN elem_students s ON s.id=d.student_id
 WHERE d.class_id=? AND d.school_year_id=? AND d.reversed_at IS NULL
 ORDER BY d.effective_date DESC,d.id DESC`,[classId,yearId]);
 return rows.map(row=>({...row,id:String(row.id),studentId:String(row.studentId)}));
}
async function assertAttendanceAllowed(db,studentId,yearId,date){
 const [rows]=await db.execute('SELECT id FROM student_dropout_events WHERE student_id=? AND school_year_id=? AND reversed_at IS NULL AND effective_date<=? LIMIT 1',[studentId,yearId,date]);
 if(rows.length)fail(409,'Attendance is locked from the effective dropout date. Reverse the declaration before editing this date.');
}
module.exports={ensureDropoutTable,REASONS,isoDate,fail,consecutiveAbsences,activeDropouts,assertAttendanceAllowed};

const pool=require('../../../../config/db');
const {isoDate,fail}=require('./dropout.service');
const {notifyAttendanceComplete}=require('../../notification/notification.service');
async function markPresent(req,res){
 let conn,committed=false;
 try {
  const classId=Number(req.params.classId),{date,termId,studentIds}=req.body??{};
  if(!Number.isSafeInteger(classId)||classId<=0||!isoDate(date)||!Array.isArray(studentIds)||!studentIds.length||studentIds.length>1000||studentIds.some(id=>!/^\d+$/.test(String(id))||!Number.isSafeInteger(Number(id))||Number(id)<=0)||!Number.isSafeInteger(Number(termId))||Number(termId)<=0)fail(400,'Choose a valid class, open term, date and student selection.');
  const ids=[...new Set(studentIds.map(Number))].sort((a,b)=>a-b);
  conn=await pool.getConnection();await conn.beginTransaction();
  const [classes]=await conn.execute(`SELECT c.id,c.school_year_id AS yearId,c.grade_level_id AS gradeId,c.section_id AS sectionId,t.id AS teacherId,DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today
   FROM classes c JOIN school_year sy ON sy.id=c.school_year_id AND sy.is_active=1
   JOIN teacher_table t ON t.id=c.class_adviser_id AND t.user_id=? AND t.is_deleted=0 AND LOWER(t.status)='active'
   WHERE c.id=? AND c.status='Active' FOR UPDATE`,[req.user.userId,classId]);
  const cls=classes[0];if(!cls)fail(403,'Only the current class adviser can mark this class.');
  if(date!==cls.today)fail(400,'Mark All Present is available only for today.');
  const [terms]=await conn.execute('SELECT id FROM grading_periods WHERE id=? AND school_year_id=? AND is_active=1 AND ? BETWEEN DATE(start_date) AND DATE(end_date)',[termId,cls.yearId,date]);
  if(!terms.length)fail(409,'The active grading period changed. Refresh attendance before saving.');
  const placeholders=ids.map(()=>'?').join(',');
  const [students]=await conn.execute(`SELECT id FROM elem_students WHERE id IN (${placeholders}) AND current_school_year_id=? AND grade_level_id=? AND section_id <=> ? AND is_deleted=0 AND status<>'graduated' ORDER BY id FOR UPDATE`,[...ids,cls.yearId,cls.gradeId,cls.sectionId]);
  if(students.length!==ids.length)fail(409,'The class roster changed. Refresh attendance before saving. No selected records were changed.');
  const [dropouts]=await conn.execute(`SELECT id FROM student_dropout_events WHERE student_id IN (${placeholders}) AND school_year_id=? AND reversed_at IS NULL AND effective_date<=?`,[...ids,cls.yearId,date]);
  if(dropouts.length)fail(409,'A selected student has a dropout declaration. Refresh attendance before saving. No selected records were changed.');
  const [notJoined]=await conn.execute(`SELECT student_id FROM student_transfer_ins WHERE student_id IN (${placeholders}) AND school_year_id=? AND joined_date>?`,[...ids,cls.yearId,date]);
  if(notJoined.length)fail(409,'A selected student has not joined yet. Refresh attendance.');
  const [existing]=await conn.execute(`SELECT grading_period_id AS termId FROM advisory_attendance_records WHERE class_id=? AND attendance_date=? AND student_id IN (${placeholders}) FOR UPDATE`,[classId,date,...ids]);
  if(existing.some(row=>Number(row.termId)!==Number(termId)))fail(409,'Existing attendance belongs to another term. Refresh attendance before saving.');
  const values=ids.map(()=>'(?,?,?,?,?,?,?)').join(',');
  await conn.execute(`INSERT INTO advisory_attendance_records (section_id,class_id,grading_period_id,student_id,attendance_date,status,recorded_by) VALUES ${values}
   ON DUPLICATE KEY UPDATE status=VALUES(status),recorded_by=VALUES(recorded_by)`,ids.flatMap(id=>[cls.sectionId,classId,termId,id,date,'P',cls.teacherId]));
  await conn.commit();committed=true;conn.release();conn=null;
  // Acknowledge the committed marks before doing optional notification reads.
  res.json({success:true,studentIds:ids.map(String),count:ids.length});
  try{await notifyAttendanceComplete({classId,date});}catch(error){console.error('Attendance-complete notification failed:',error.code||error.name);}
 }catch(error){
  if(!error.status)console.error('Bulk attendance save failed:',error.code||error.name);
  if(!res.headersSent)res.status(error.status||500).json({message:error.status?error.message:'Attendance could not be saved. Retry the selection.'});
 }finally{if(conn){if(!committed)await conn.rollback();conn.release();}}
}
module.exports={markPresent};

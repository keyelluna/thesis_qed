const pool=require('../../../../config/db');
const {REASONS,isoDate,fail,consecutiveAbsences,activeDropouts}=require('./dropout.service');
async function context(db,req,lock=false){
 const [classes]=await db.execute(`SELECT c.id,c.school_year_id AS yearId,c.grade_level_id AS gradeId,c.section_id AS sectionId,
 sy.school_year AS schoolYearLabel, DATE_FORMAT(CURDATE(),'%Y-%m-%d') AS today
 FROM classes c JOIN school_year sy ON sy.id=c.school_year_id AND sy.is_active=1
 JOIN teacher_table t ON t.id=c.class_adviser_id AND t.user_id=? AND t.is_deleted=0 AND LOWER(t.status)='active'
 WHERE c.id=? AND c.status='Active' ${lock?'FOR UPDATE':''}`,[req.user.userId,req.params.classId]);
 if(!classes.length)fail(403,'Only the current class adviser may manage dropout declarations.');
 return classes[0];
}
async function student(db,ctx,id){
 const [rows]=await db.execute(`SELECT id FROM elem_students WHERE id=? AND current_school_year_id=? AND grade_level_id=?
 AND section_id <=> ? AND is_deleted=0 AND status<>'graduated' FOR UPDATE`,[id,ctx.yearId,ctx.gradeId,ctx.sectionId]);
 if(!rows.length)fail(404,'Student is not in this advisory class for the active school year.');
}
async function lastAttendance(db,ctx,classId,studentId){
 const [rows]=await db.execute(`SELECT DATE_FORMAT(MAX(a.attendance_date),'%Y-%m-%d') AS date FROM advisory_attendance_records a
 JOIN grading_periods gp ON gp.id=a.grading_period_id AND gp.school_year_id=?
 WHERE a.class_id=? AND a.student_id=? AND a.status IN ('P','L') AND a.attendance_date<=?`,[ctx.yearId,classId,studentId,ctx.today]);
 return rows[0]?.date??null;
}
function errorResponse(res,error){if(!error.status)console.error('Dropout operation failed:',error.code||error.name);return res.status(error.status||503).json({message:error.status?error.message:'Dropout records are temporarily unavailable. Please retry.'});}
async function getState(req,res){
 try{
 const ctx=await context(pool,req);
 const [terms]=await pool.execute("SELECT DATE_FORMAT(start_date,'%Y-%m-%d') AS startDate,DATE_FORMAT(end_date,'%Y-%m-%d') AS endDate FROM grading_periods WHERE school_year_id=?",[ctx.yearId]);
 const [holidays]=await pool.execute("SELECT DATE_FORMAT(date,'%Y-%m-%d') AS date FROM school_calendar WHERE school_year_id=? AND type='holiday'",[ctx.yearId]);
 const [records]=await pool.execute(`SELECT a.student_id AS studentId, DATE_FORMAT(a.attendance_date,'%Y-%m-%d') AS date,a.status FROM advisory_attendance_records a JOIN grading_periods gp ON gp.id=a.grading_period_id AND gp.school_year_id=? WHERE a.class_id=? AND a.attendance_date<=? ORDER BY a.attendance_date`,[ctx.yearId,ctx.id,ctx.today]);
 const transferIns=await require('./transferIn.service').classTransferIns(pool,ctx);
 const joined=new Map(transferIns.map(t=>[t.studentId,t.joinedDate]));
 const eligibleRecords=records.filter(r=>!joined.has(String(r.studentId))||r.date>=joined.get(String(r.studentId)));
 const dates=eligibleRecords.map(r=>r.date).filter(date=>![0,6].includes(new Date(date+'T12:00:00Z').getUTCDay())&&!holidays.some(h=>h.date===date));
 const asOf=dates.sort().at(-1)??null,marks={};
 for(const r of eligibleRecords){marks[r.studentId]??={};marks[r.studentId][r.date]=r.status;}
 const students={};for(const [id,studentMarks] of Object.entries(marks)){
 const presentDates=Object.keys(studentMarks).filter(d=>['P','L'].includes(studentMarks[d])).sort();
 students[id]={lastAttended:presentDates.at(-1)??null,risk:consecutiveAbsences(studentMarks,terms,asOf,holidays.map(h=>h.date))};
 }
 const dropouts=await activeDropouts(pool,ctx.id,ctx.yearId);
 res.set('Cache-Control','no-store').json({success:true,data:{classId:String(ctx.id),schoolYearId:String(ctx.yearId),today:ctx.today,asOf,students,dropouts,transferIns}});
 }catch(error){return errorResponse(res,error);}
}
async function declare(req,res){
 let db;
 try{
 const id=Number(req.params.studentId),{effectiveDate,reason,remarks=''}=req.body??{};
 if(!Number.isSafeInteger(id)||id<=0||!isoDate(effectiveDate)||!REASONS.includes(reason)||typeof remarks!=='string'||remarks.trim().length>1000||(reason==='Other'&&!remarks.trim()))fail(400,'Choose an effective date and a reason. Other requires remarks (maximum 1,000 characters).');
 db=await pool.getConnection();await db.beginTransaction();const ctx=await context(db,req,true);await student(db,ctx,id);
 const [bounds]=await db.execute("SELECT DATE_FORMAT(MIN(start_date),'%Y-%m-%d') AS startDate,DATE_FORMAT(MAX(end_date),'%Y-%m-%d') AS endDate FROM grading_periods WHERE school_year_id=?",[ctx.yearId]);
 if(!bounds[0]?.startDate||effectiveDate<bounds[0].startDate||effectiveDate>bounds[0].endDate||effectiveDate>ctx.today)fail(400,'Effective date must fall within the active school year and cannot be in the future.');
 const transfers=await require('./transferIn.service').classTransferIns(db,ctx);
 const joined=transfers.find(t=>t.studentId===String(id));if(joined&&effectiveDate<joined.joinedDate)fail(400,'Effective date cannot precede the date the student joined.');
 const existing=await activeDropouts(db,ctx.id,ctx.yearId);if(existing.some(d=>d.studentId===String(id)))fail(409,'This student already has an active dropout declaration.');
 const last=await lastAttendance(db,ctx,ctx.id,id);
 if(last&&effectiveDate<=last)fail(409,'Effective date must be after the last recorded present or late attendance ('+last+'). Existing attendance has not been changed.');
 await db.execute('INSERT INTO student_dropout_events (student_id,class_id,school_year_id,last_attended,effective_date,reason,remarks,declared_by) VALUES (?,?,?,?,?,?,?,?)',[id,ctx.id,ctx.yearId,last,effectiveDate,reason,remarks.trim(),req.user.userId]);
 await db.commit();res.status(201).json({success:true});
 }catch(error){if(db)await db.rollback();if(error.code==='ER_DUP_ENTRY')return res.status(409).json({message:'This student already has an active dropout declaration.'});return errorResponse(res,error);}finally{db?.release();}
}
async function reverse(req,res){
 let db;try{
 const {reason}=req.body??{};const id=Number(req.params.studentId),declarationId=Number(req.body?.declarationId);
 if(!Number.isSafeInteger(id)||id<=0||!Number.isSafeInteger(declarationId)||declarationId<=0||typeof reason!=='string'||!reason.trim()||reason.trim().length>1000)fail(400,'A reversal reason and the current declaration are required.');
 db=await pool.getConnection();await db.beginTransaction();const ctx=await context(db,req,true);await student(db,ctx,id);
 const [result]=await db.execute(`UPDATE student_dropout_events SET reversed_by=?,reversed_at=CURRENT_TIMESTAMP,reversal_reason=? WHERE id=? AND student_id=? AND class_id=? AND school_year_id=? AND reversed_at IS NULL`,[req.user.userId,reason.trim(),declarationId,id,ctx.id,ctx.yearId]);
 if(result.affectedRows!==1)fail(409,'This declaration changed or was already reversed. Refresh attendance.');
 await db.commit();res.json({success:true});
 }catch(error){if(db)await db.rollback();return errorResponse(res,error);}finally{db?.release();}
}
module.exports={getState,declare,reverse};

const pool=require('../../../../config/db');
const fs=require('node:fs'),path=require('node:path');
let ready;
function ensureTransferInTable(){
 if(!ready)ready=pool.query(fs.readFileSync(path.join(__dirname,'../../../../scripts/2026-10-27-student-transfer-ins.sql'),'utf8')).catch(error=>{ready=null;throw error;});
 return ready;
}
async function classTransferIns(db,ctx){
 const [rows]=await db.execute(`SELECT s.id AS studentId,DATE_FORMAT(t.joined_date,'%Y-%m-%d') AS joinedDate,
 CONCAT_WS(', ',s.last_name,TRIM(CONCAT_WS(' ',s.first_name,NULLIF(s.middle_name,'')))) AS studentName
 FROM elem_students s JOIN student_transfer_ins t ON t.student_id=s.id AND t.school_year_id=s.current_school_year_id
 WHERE s.current_school_year_id=? AND s.grade_level_id=? AND s.section_id <=> ? AND s.is_deleted=0 AND s.status<>'graduated'
 ORDER BY t.joined_date,s.last_name,s.first_name`,[ctx.yearId,ctx.gradeId,ctx.sectionId]);
 return rows.map(row=>({...row,studentId:String(row.studentId)}));
}
module.exports={ensureTransferInTable,classTransferIns};

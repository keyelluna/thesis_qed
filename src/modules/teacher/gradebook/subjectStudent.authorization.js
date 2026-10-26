const connection = require('../../../../config/db');
// Match the existing subject roster: named section, or the whole grade for a
// sectionless subject. Ownership of subjectSection is checked by middleware.
async function studentBelongsToSubject(studentId, subjectSection, db = connection) {
 const section=subjectSection.section_id;
 const scope=section==null?'s.grade_level_id = ?':'s.section_id = ?';
 const target=section==null?subjectSection.gradeLevelId:section;
 const [rows]=await db.execute(`SELECT s.id FROM elem_students s
   WHERE s.id = ? AND ${scope} AND s.is_deleted = 0 AND s.status <> 'graduated'
     AND s.current_school_year_id = (SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)`,[studentId,target]);
 return rows.length>0;
}
module.exports={studentBelongsToSubject};

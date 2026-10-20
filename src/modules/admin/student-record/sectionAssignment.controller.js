const pool = require('../../../../config/db');
const { assignStudents, validateBatch, positiveId, fail } = require('../../../services/studentPlacement.service');

exports.assign = async (req, res) => {
  let conn;
  try {
    validateBatch(req.body);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const data = await assignStudents(conn, req.body);
    await conn.commit();
    return res.json({ success: true, message: `${data.assignedCount} students assigned successfully.`, data });
  } catch (error) {
    if (conn) await conn.rollback();
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Section assignment failed. Refresh before retrying.' });
  } finally { if (conn) conn.release(); }
};

exports.read = async (req, res) => {
  let conn;
  try {
    const gradeId = req.query.gradeLevelId === undefined ? null : Number(req.query.gradeLevelId);
    if (gradeId !== null && !positiveId(gradeId)) fail(400, 'A valid grade level is required.');
    // A single snapshot keeps year, counts and directory consistent during transition.
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [years] = await conn.query('SELECT id, school_year FROM school_year WHERE is_active = 1 ORDER BY id');
    if (years.length !== 1) fail(409, 'Exactly one active school year is required. Configure the academic year first.');
    const year = years[0];
    const [grades] = await conn.query('SELECT id, grade_level FROM grade_level ORDER BY id');
    if (gradeId !== null && !grades.some(g => Number(g.id) === gradeId)) fail(400, 'Grade level not found.');
    const [sections] = await conn.query(`SELECT sec.id, sec.section_name, sec.grade_level_id, c.id AS class_id
      FROM grade_level_sections sec JOIN classes c ON c.section_id = sec.id
      AND c.grade_level_id = sec.grade_level_id AND c.school_year_id = sec.school_year_id AND c.status = 'Active'
      WHERE sec.school_year_id = ? AND sec.is_active = 1 ORDER BY sec.grade_level_id, sec.section_name`, [year.id]);
    const [rows] = await conn.query(`SELECT s.id, s.student_number, s.first_name, s.last_name, s.middle_name, s.gender,
      s.grade_level_id, gl.grade_level, s.section_id, sec.section_name,
      CASE WHEN s.section_id IS NULL THEN 'Unassigned'
        WHEN sec.id IS NOT NULL AND sec.is_active = 1 AND sec.school_year_id = s.current_school_year_id
          AND sec.grade_level_id = s.grade_level_id AND EXISTS (SELECT 1 FROM classes c
            WHERE c.section_id = sec.id AND c.school_year_id = s.current_school_year_id
              AND c.grade_level_id = s.grade_level_id AND c.status = 'Active') THEN 'Assigned'
        ELSE 'Needs review' END AS assignment_status
      FROM elem_students s LEFT JOIN grade_level gl ON gl.id = s.grade_level_id
      LEFT JOIN grade_level_sections sec ON sec.id = s.section_id
      WHERE s.current_school_year_id = ? AND s.is_deleted = 0 AND s.status <> 'graduated'
      ORDER BY s.grade_level_id, s.gender, s.last_name, s.first_name, s.id`, [year.id]);
    const counts = { assigned: 0, unassigned: 0, needsReview: 0 };
    for (const row of rows) counts[row.assignment_status === 'Assigned' ? 'assigned' : row.assignment_status === 'Unassigned' ? 'unassigned' : 'needsReview']++;
    await conn.commit();
    return res.json({ success: true, data: { schoolYear: { id: year.id, label: year.school_year }, grades, sections: sections.filter(s => gradeId === null || Number(s.grade_level_id) === gradeId), students: rows.filter(s => gradeId === null || Number(s.grade_level_id) === gradeId), counts } });
  } catch (error) {
    if (conn) await conn.rollback();
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : 'Unable to load section assignments.' });
  } finally { if (conn) conn.release(); }
};

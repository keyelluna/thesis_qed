const connection = require("../../../../config/db");
const { lockActiveYear, fail } = require('../../../services/studentPlacement.service');
const Teacher = require("../../../models/teacher.model");

exports.getGrade = async (req, res) => {
  try {
    const [rows] = await connection.query(
      "SELECT id, grade_level FROM grade_level ORDER BY grade_level ASC",
    );
    res.status(200).json(rows);
  } catch (error) {
    console.error("Error fetching grade levels:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

async function saveSection(req, res, editing) {
 let conn;
 try {
  const { gradeLevel, sectionName } = req.body;
  if (typeof sectionName !== 'string' || !sectionName.trim() || sectionName.trim().length > 20) fail(400, 'Enter a section name of 1–20 characters.');
  conn = await connection.getConnection(); await conn.beginTransaction();
  const year = await lockActiveYear(conn); let grade = Number(gradeLevel);
  if (editing) {
   const [rows] = await conn.query('SELECT id, grade_level_id FROM grade_level_sections WHERE id = ? AND school_year_id = ? FOR UPDATE', [req.params.id, year.id]);
   if (!rows.length) fail(409, 'Only active-year sections can be edited.');
   grade = Number(rows[0].grade_level_id);
  }
  const [grades] = await conn.query('SELECT id FROM grade_level WHERE id = ?', [grade]);
  if (!grades.length) fail(400, 'Choose a valid grade level.');
  const [duplicates] = await conn.query('SELECT id FROM grade_level_sections WHERE grade_level_id = ? AND school_year_id = ? AND LOWER(TRIM(section_name)) = LOWER(?) AND id <> ?', [grade, year.id, sectionName.trim(), editing ? req.params.id : 0]);
  if (duplicates.length) fail(409, 'This section name already exists in this grade and school year.');
  let id = Number(req.params?.id);
  if (editing) await conn.query('UPDATE grade_level_sections SET section_name = ? WHERE id = ?', [sectionName.trim(), id]);
  else { const [r] = await conn.query('INSERT INTO grade_level_sections (grade_level_id, section_name, school_year_id) VALUES (?, ?, ?)', [grade, sectionName.trim(), year.id]); id = r.insertId; }
  await conn.commit(); return res.status(editing ? 200 : 201).json({ status: 'success', message: 'Section saved.', data: { id, grade_level_id: grade, section_name: sectionName.trim(), school_year_id: year.id } });
 } catch (error) { if (conn) await conn.rollback(); return res.status(error.statusCode || 500).json({ status: 'fail', message: error.statusCode ? error.message : 'Unable to save section.' }); }
 finally { if (conn) conn.release(); }
}
exports.createSection = (req, res) => saveSection(req, res, false);
exports.updateSection = (req, res) => saveSection(req, res, true);

exports.getSectionsByGradeLevel = async (req, res) => {
  try {
    const { gradeLevel } = req.params;

    const [rows] = await connection.execute(
      `SELECT id, grade_level_id, section_name
       FROM grade_level_sections
       WHERE grade_level_id = ? AND is_active = 1 AND school_year_id = (SELECT id FROM school_year WHERE is_active = 1 LIMIT 1)
       ORDER BY section_name ASC`,
      [gradeLevel],
    );

    return res.status(200).json({
      status: "success",
      message:
        rows.length > 0
          ? "Sections retrieved successfully."
          : `No sections found for Grade ${gradeLevel}`,
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching sections:", error);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

exports.getTeachers = async (req, res) => {
  try {
    await Teacher.ensureAvatarKeyColumn();
    const [rows] = await connection.execute(
      `SELECT id, user_id, first_name, last_name, middle_name, email_address, contact_number, gender, avatar_key
       FROM teacher_table
       WHERE is_deleted = 0 AND status = 'active'
       ORDER BY last_name ASC`,
    );

    return res.status(200).json({
      status: "success",
      message:
        rows.length > 0
          ? "Teachers retrieved successfully."
          : "No teachers found.",
      data: rows,
    });
  } catch (error) {
    console.error("Error fetching teachers:", error);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

async function removeSection(req, res, permanent) {
 let conn;
 try {
  conn = await connection.getConnection(); await conn.beginTransaction();
  const year = await lockActiveYear(conn);
  const [sections] = await conn.query('SELECT id FROM grade_level_sections WHERE id = ? AND school_year_id = ? FOR UPDATE', [req.params.id, year.id]);
  if (!sections.length) fail(409, 'Only sections belonging to the active school year can be removed.');
  const [students] = await conn.query('SELECT id FROM elem_students WHERE section_id = ? LIMIT 1', [req.params.id]);
  if (students.length) fail(409, 'This section has student records and cannot be removed.');
  if (permanent) {
   const [history] = await conn.query('SELECT student_id FROM student_year_records WHERE section_id = ? LIMIT 1', [req.params.id]);
   const [classes] = await conn.query('SELECT id FROM classes WHERE section_id = ? LIMIT 1', [req.params.id]);
   const [subjects] = await conn.query('SELECT id FROM `subject-section` WHERE section_id = ? LIMIT 1', [req.params.id]);
   if (history.length || classes.length || subjects.length) fail(409, 'This section has class or historical records. Preserve it instead of deleting it.');
   await conn.query('DELETE FROM grade_level_sections WHERE id = ?', [req.params.id]);
  } else await conn.query('UPDATE grade_level_sections SET is_active = 0 WHERE id = ?', [req.params.id]);
  await conn.commit(); return res.json({ status: 'success', message: permanent ? 'Section deleted successfully.' : 'Section removed.' });
 } catch (error) {
  if (conn) await conn.rollback();
  return res.status(error.statusCode || 500).json({ status: 'fail', message: error.statusCode ? error.message : 'Unable to remove section.' });
 } finally { if (conn) conn.release(); }
}
exports.deactivateSection = (req, res) => removeSection(req, res, false);
exports.deleteSection = (req, res) => removeSection(req, res, true);

exports.getSectionIdsUsedByClasses = async (req, res) => {
  try {
    const [rows] = await connection.execute(
      `SELECT DISTINCT section_id FROM classes WHERE section_id IS NOT NULL`,
    );
    return res.status(200).json({
      status: "success",
      message: "Fetched.",
      data: rows.map((r) => r.section_id),
    });
  } catch (error) {
    console.error("Error fetching used section ids:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error.",
    });
  }
};

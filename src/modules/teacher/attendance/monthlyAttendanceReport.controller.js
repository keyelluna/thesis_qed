const pool = require('../../../../config/db');
const { aggregateReport, reportingMonths, fail } = require('./monthlyAttendanceReport.service');
function requireTeacher(req, res, next) {
  if (String(req.user?.role).toUpperCase() !== 'TEACHER') return res.status(403).json({ message: 'Teacher access is required.' });
  next();
}
async function getMonthlyReport(req, res) {
  let conn;
  try {
    const classId = Number(req.params.classId), yearId = Number(req.query.schoolYearId), month = req.query.month;
    if (![classId, yearId].every(n => Number.isSafeInteger(n) && n > 0) || typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900 || Number(month.slice(0, 4)) > 9998) fail(400, 'Select a valid class, school year, and month.');
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [classes] = await conn.execute(
      `SELECT c.id AS classId, c.section_id AS sectionId, c.grade_level_id AS gradeId, c.school_year_id AS schoolYearId,
        sy.school_year AS schoolYearLabel, gl.grade_level AS gradeLevel, sec.section_name AS sectionName,
        CONCAT_WS(' ', t.first_name, NULLIF(t.middle_name, ''), t.last_name) AS adviserName
       FROM classes c JOIN school_year sy ON sy.id = c.school_year_id AND sy.is_active = 1
       JOIN teacher_table t ON t.id = c.class_adviser_id AND t.user_id = ? AND t.is_deleted = 0 AND LOWER(t.status) = 'active'
       JOIN grade_level gl ON gl.id = c.grade_level_id LEFT JOIN grade_level_sections sec ON sec.id = c.section_id
       WHERE c.id = ? AND c.status = 'Active' LIMIT 1`, [req.user.userId, classId]);
    const schoolClass = classes[0];
    if (!schoolClass) fail(403, 'You are not the adviser of an active class in the selected school year. Historical reporting is not available.');
    if (Number(schoolClass.schoolYearId) !== yearId) fail(403, 'The class does not belong to the selected active school year.');
    const [terms] = await conn.execute("SELECT DATE_FORMAT(start_date, '%Y-%m-%d') AS startDate, DATE_FORMAT(end_date, '%Y-%m-%d') AS endDate FROM grading_periods WHERE school_year_id = ?", [yearId]);
    const months = reportingMonths(terms);
    if (!months.includes(month)) fail(400, 'Select a month within this school year’s grading periods.');
    const [roster] = await conn.execute(
      `SELECT s.id, s.gender, CONCAT_WS(' ', s.first_name, NULLIF(s.middle_name, ''), s.last_name) AS name
       FROM elem_students s WHERE s.current_school_year_id = ? AND s.grade_level_id = ?
       AND s.section_id <=> ? AND s.is_deleted = 0 AND s.status <> 'graduated' ORDER BY s.id`, [yearId, schoolClass.gradeId, schoolClass.sectionId]);
    const [year, monthNumber] = month.split('-').map(Number);
    const nextMonth = monthNumber === 12 ? String(year + 1) + '-01-01' : String(year) + '-' + String(monthNumber + 1).padStart(2, '0') + '-01';
    const [records] = await conn.execute(
      `SELECT a.student_id AS studentId, DATE_FORMAT(a.attendance_date, '%Y-%m-%d') AS date, a.status
       FROM advisory_attendance_records a JOIN grading_periods gp ON gp.id = a.grading_period_id AND gp.school_year_id = ?
       WHERE a.class_id = ? AND a.attendance_date >= ? AND a.attendance_date < ? ORDER BY a.attendance_date, a.student_id`, [yearId, classId, month + '-01', nextMonth]);
    const [principals] = await conn.execute("SELECT CONCAT_WS(' ', first_name, NULLIF(middle_name, ''), last_name) AS name, role AS designation FROM principal_table WHERE is_deleted = 0 AND LOWER(status) = 'active' ORDER BY id");
    const principal = principals.length === 1 ? principals[0] : null;
    const data = { ...aggregateReport(roster, records, month), classId: String(classId), schoolYearId: String(yearId), schoolYearLabel: schoolClass.schoolYearLabel,
      gradeSection: [schoolClass.gradeLevel, schoolClass.sectionName].filter(Boolean).join(' - '), month, months,
      adviserName: schoolClass.adviserName || '', principalName: principal?.name || '', principalDesignation: principal?.designation || '',
      principalSource: principal ? 'system' : 'manual' };
    await conn.commit();
    res.set('Cache-Control', 'no-store').json({ success: true, data });
  } catch (error) {
    if (conn) await conn.rollback();
    if (!error.statusCode) console.error('Monthly attendance report read failed:', error.code || error.name);
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : 'Unable to load the monthly attendance report.' });
  } finally { conn?.release(); }
}
module.exports = { requireTeacher, getMonthlyReport };

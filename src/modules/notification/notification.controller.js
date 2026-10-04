const connection = require('../../../config/db');
const { getAdvisoryGradeSheetPath } = require('./notification.service'); 

exports.getNotifications = async (req, res, next) => {
  try {
    const { userId } = req.params;

    const [notifs] = await connection.query(
      `SELECT n.id, n.user_id, n.title, n.message, n.type, n.student_id, n.ref_key,
              n.is_read, n.created_at,
              c.grade_level_id AS gradeLevelId, c.section_id AS sectionId,
              gl.grade_level AS gradeLevel,
              CONCAT(s.first_name, ' ', s.last_name) AS student_name
       FROM notifications n
       LEFT JOIN elem_students s ON n.student_id = s.id
       LEFT JOIN classes c ON n.ref_key LIKE 'advisory-grades:%'
         AND c.id = CAST(SUBSTRING_INDEX(SUBSTRING_INDEX(n.ref_key, ':', 2), ':', -1) AS UNSIGNED)
       LEFT JOIN grade_level gl ON gl.id = c.grade_level_id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC`,
      [userId]
    );

    res.json({ success: true, data: notifs.map(({ gradeLevelId, sectionId, gradeLevel, ...n }) => ({
      ...n,
      target_path: getAdvisoryGradeSheetPath({
        gradeLevelId, sectionId, gradeLevel,
        gradingPeriodId: n.ref_key?.startsWith('advisory-grades:') ? n.ref_key.split(':')[2] : null,
      }),
    })) });
  } catch (err) {
    next(err); 
  }
}

exports.markAsRead = async (req, res, next) => {
  try {
    const { id } = req.params;

    await connection.query(
      `UPDATE notifications SET is_read = true WHERE id = ?`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

exports.markAllAsRead = async (req, res, next) => {
  try {
    const { userId } = req.params;

    await connection.query(
      `UPDATE notifications SET is_read = true WHERE user_id = ? AND is_read = false`,
      [userId]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

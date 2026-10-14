const connection = require('../../../config/db');
const { requireStudentIdentity } = require('../admin/student-record/studentRecord.authorization');

function requireParent(req, res, next) {
  requireStudentIdentity(req, res, () => {
    if (req.studentIdentity.role !== 'PARENT') return res.status(403).json({ success: false, message: 'Parent access is required.' });
    next();
  });
}

async function requireLinkedChild(req, res, next) {
  requireParent(req, res, async () => {
    try {
      const studentId = req.params.studentId;
      if (typeof studentId !== 'string' || !/^[1-9]\d*$/.test(studentId)) return res.status(403).json({ success: false, message: 'Student access is not authorized.' });
      const [parents] = await connection.query('SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0 LIMIT 1', [req.studentIdentity.userId]);
      if (!parents.length) return res.status(403).json({ success: false, message: 'Parent access is required.' });
      const [links] = await connection.query('SELECT 1 FROM parent_student WHERE parent_id = ? AND student_id = ? LIMIT 1', [parents[0].id, studentId]);
      if (!links.length) return res.status(403).json({ success: false, message: "You don't have access to this student's records." });
      next();
    } catch {
      res.status(500).json({ success: false, message: 'Unable to verify student access.' });
    }
  });
}
module.exports = { requireParent, requireLinkedChild };

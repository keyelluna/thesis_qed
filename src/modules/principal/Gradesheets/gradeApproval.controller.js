const { loadApprovalRecords, withGradeSnapshot } = require('../../shared/grades/principalGradeApproval.service');

const validId = value => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));

async function handleApproval(req, res) {
  const isWrite = req.method === 'POST';
  const { gradingPeriodId, gradeLevelId, sectionId = null, students } = isWrite ? req.body ?? {} : req.query;
  if (!validId(gradingPeriodId) || !validId(gradeLevelId) || (sectionId !== null && !validId(sectionId))) {
    return res.status(400).json({ message: 'Select a valid class and term.' });
  }
  if (isWrite && (!Array.isArray(students) || !students.length || students.length > 500 ||
    students.some(entry => !entry || !validId(entry.studentId) ||
      typeof entry.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) ||
    new Set(students.map(entry => String(entry.studentId))).size !== students.length)) {
    return res.status(400).json({ message: 'Select valid student grades to approve.' });
  }

  try {
    const result = await withGradeSnapshot(async db => {
      // Serialize approval writes for a term before taking the grade snapshot.
      if (isWrite) {
        await db.execute('SELECT id FROM grading_periods WHERE id = ? FOR UPDATE', [gradingPeriodId]);
      }
      const [principals] = await db.execute(
        "SELECT id FROM principal_table WHERE user_id = ? AND is_deleted = 0 AND LOWER(status) = 'active'",
        [req.user.userId]
      );
      if (!principals.length) return { status: 403, body: { message: 'An active principal account is required.' } };
      const records = await loadApprovalRecords(db, gradingPeriodId, { gradeLevelId, sectionId });
      if (!isWrite) return { status: 200, body: { data: records } };

      const byStudent = new Map(records.map(record => [record.studentId, record]));
      if (students.some(entry => {
        const record = byStudent.get(String(entry.studentId));
        return !record?.ready || record.fingerprint !== entry.fingerprint;
      })) return { status: 409, body: { message: 'Some grades are no longer ready or have changed. Refresh and review the current grades.' } };

      const ordered = [...students].sort((a, b) => Number(a.studentId) - Number(b.studentId));
      for (const entry of ordered) {
        await db.execute(
          `INSERT INTO principal_grade_approvals (student_id, grading_period_id, grade_fingerprint, approved_by)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE grade_fingerprint = VALUES(grade_fingerprint),
             approved_by = VALUES(approved_by), approved_at = CURRENT_TIMESTAMP`,
          [entry.studentId, gradingPeriodId, entry.fingerprint, req.user.userId]
        );
      }
      return { status: 200, body: { approvedCount: ordered.length } };
    });
    res.set('Cache-Control', 'private, no-store');
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('Principal grade approval failed:', error.code ?? error.name);
    return res.status(500).json({ message: 'Could not process grade approvals. Refresh the grade sheet before trying again.' });
  }
}

module.exports = { handleApproval };

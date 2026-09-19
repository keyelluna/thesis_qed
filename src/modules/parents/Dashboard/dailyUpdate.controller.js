const connection = require("../../../../config/db");

const STATUS_MESSAGES = {
  P: (name) => `${name} is present for today.`,
  A: (name) => `${name} is absent today.`,
  L: (name) => `${name} arrived late today.`,
  E: (name) => `${name} is excused for today.`,
};

const formatTime = (dateValue) => {
  if (!dateValue) return null;
  const date = new Date(dateValue);
  return date.toLocaleTimeString("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
};

const getParentRecordFromToken = async (req) => {
  const authId = req.user?.userId;
  if (!authId) return null;

  const [rows] = await connection.query(
    `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
    [authId]
  );

  return rows[0] || null;
};

exports.getDailyUpdate = async (req, res) => {
  const { studentId } = req.params;

  if (!studentId) {
    return res.status(400).json({ message: "studentId is required." });
  }

  try {
    const parent = await getParentRecordFromToken(req);
    if (!parent) {
      return res.status(403).json({ message: "Parent account not found." });
    }

    const [ownershipRows] = await connection.query(
      `SELECT 1 FROM parent_student WHERE parent_id = ? AND student_id = ?`,
      [parent.id, studentId]
    );

    if (ownershipRows.length === 0) {
      return res
        .status(403)
        .json({ message: "You do not have access to this student." });
    }

    const [studentRows] = await connection.query(
      `SELECT id, first_name, last_name
       FROM elem_students
       WHERE id = ? AND is_deleted = 0`,
      [studentId]
    );

    if (studentRows.length === 0) {
      return res.status(404).json({ message: "Student not found." });
    }

    const student = studentRows[0];
    const studentName = `${student.first_name} ${student.last_name}`;

    const [attendanceRows] = await connection.query(
      `SELECT id, status, attendance_date, updated_at
       FROM advisory_attendance_records
       WHERE student_id = ? AND attendance_date = CURDATE()
       ORDER BY updated_at DESC
       LIMIT 1`,
      [studentId]
    );

    if (attendanceRows.length === 0) {
      return res.status(200).json({
        id: `${student.id}-none`,
        studentId: String(student.id),
        studentName,
        time: null,
        message: `No attendance record yet for ${studentName} today.`,
      });
    }

    const record = attendanceRows[0];
    const buildMessage = STATUS_MESSAGES[record.status];
    const message = buildMessage
      ? buildMessage(studentName)
      : `${studentName}'s attendance status today is "${record.status}".`;

    const dailyUpdate = {
      id: String(record.id),
      studentId: String(student.id),
      studentName,
      time: formatTime(record.updated_at),
      message,
    };

    return res.status(200).json(dailyUpdate);
  } catch (error) {
    console.error("getDailyUpdate error:", error);
    return res.status(500).json({ message: "Failed to fetch daily update." });
  }
};

exports.getDailyUpdatesForParent = async (req, res) => {
  try {
    const parent = await getParentRecordFromToken(req);
    if (!parent) {
      return res.status(403).json({ message: "Parent account not found." });
    }

    const [rows] = await connection.query(
      `SELECT
         s.id AS studentId,
         s.first_name,
         s.last_name,
         aar.id AS recordId,
         aar.status,
         aar.updated_at
       FROM parent_student ps
       JOIN elem_students s ON s.id = ps.student_id AND s.is_deleted = 0
       LEFT JOIN advisory_attendance_records aar
         ON aar.student_id = s.id AND aar.attendance_date = CURDATE()
       WHERE ps.parent_id = ?`,
      [parent.id]
    );

    const dailyUpdates = rows.map((row) => {
      const studentName = `${row.first_name} ${row.last_name}`;
      const buildMessage = STATUS_MESSAGES[row.status];
      const message = row.status
        ? buildMessage
          ? buildMessage(studentName)
          : `${studentName}'s attendance status today is "${row.status}".`
        : `No attendance record yet for ${studentName} today.`;

      return {
        id: row.recordId ? String(row.recordId) : `${row.studentId}-none`,
        studentId: String(row.studentId),
        studentName,
        time: formatTime(row.updated_at),
        message,
      };
    });

    return res.status(200).json(dailyUpdates);
  } catch (error) {
    console.error("getDailyUpdatesForParent error:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch daily updates." });
  }
};
const connection = require("../../../../../config/db");
const { getLowGradeTopicsForStudent } = require("../../../shared/grades/lowGradeTopics.service");

exports.getLowGradeTopics = async (req, res) => {
  const { studentId } = req.params;
  const parentUserId = req.user?.userId;

  if (!parentUserId) {
    return res.status(401).json({ message: "Unauthorized." });
  }

  if (!studentId) {
    return res.status(400).json({ message: "studentId is required." });
  }

  try {
    const [parentRows] = await connection.query(
      `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
      [parentUserId]
    );
    if (parentRows.length === 0) {
      return res.status(404).json({ message: "Parent record not found." });
    }
    const parentId = parentRows[0].id;

    const [linkRows] = await connection.query(
      `SELECT 1 FROM parent_student WHERE parent_id = ? AND student_id = ? LIMIT 1`,
      [parentId, studentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({ message: "You don't have access to this student's records." });
    }
    const rows = await getLowGradeTopicsForStudent(studentId);

    return res.status(200).json({ lowGradeTopics: rows });
  } catch (error) {
    console.error("Error fetching low grade topics:", error);
    return res.status(500).json({ message: "Failed to fetch low grade topics." });
  }
};
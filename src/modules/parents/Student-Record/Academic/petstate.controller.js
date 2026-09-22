const connection = require("../../../../../config/db");
const { getLowGradeTopicsForStudent } = require("../../../shared/grades/lowGradeTopics.service");

async function verifyParentAccess(parentUserId, studentId) {
  const [parentRows] = await connection.query(
    `SELECT id FROM parent_table WHERE user_id = ? AND is_deleted = 0`,
    [parentUserId]
  );
  if (parentRows.length === 0) return { ok: false, status: 404, message: "Parent record not found." };

  const parentId = parentRows[0].id;
  const [linkRows] = await connection.query(
    `SELECT 1 FROM parent_student WHERE parent_id = ? AND student_id = ? LIMIT 1`,
    [parentId, studentId]
  );
  if (linkRows.length === 0) return { ok: false, status: 403, message: "You don't have access to this student's records." };

  return { ok: true, parentId };
}

exports.getPetState = async (req, res) => {
  const { studentId } = req.params;
  const parentUserId = req.user?.userId;

  if (!parentUserId) return res.status(401).json({ message: "Unauthorized." });
  if (!studentId) return res.status(400).json({ message: "studentId is required." });

  try {
    const access = await verifyParentAccess(parentUserId, studentId);
    if (!access.ok) return res.status(access.status).json({ message: access.message });

    const [progressRows] = await connection.query(
      `SELECT level, food_points, total_quizzes_completed FROM pet_progress WHERE student_id = ?`,
      [studentId]
    );

    const progress = progressRows[0] || { level: 1, food_points: 0, total_quizzes_completed: 0 };
    const lowTopics = await getLowGradeTopicsForStudent(studentId);

    return res.status(200).json({
      level: progress.level,
      foodPoints: progress.food_points,
      isHungry: lowTopics.length > 0,
      hungryTopics: lowTopics.map((t) => ({ topicId: t.topic_id, topicName: t.topic_name })),
    });
  } catch (error) {
    console.error("Error fetching pet state:", error);
    return res.status(500).json({ message: "Failed to fetch pet state." });
  }
};

exports.verifyParentAccess = verifyParentAccess;
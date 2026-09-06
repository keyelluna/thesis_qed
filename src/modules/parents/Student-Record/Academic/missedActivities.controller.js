const connection = require("../../../../../config/db");

exports.getMissedActivities = async (req, res) => {
  const { studentId } = req.params;

  if (!studentId) {
    return res.status(400).json({ message: "studentId is required." });
  }

  try {
    const [rows] = await connection.query(
      `SELECT 
         gi.id AS item_id,
         gi.item_date,
         gi.topic,
         gi.activity_name,
         gi.tab,
         gi.max_items,
         es.subject_name,
         gs.score
       FROM grade_items gi
       JOIN \`subject-section\` ss ON gi.subject_section_id = ss.id
       JOIN elem_subjects es ON ss.subject_id = es.id
       JOIN elem_students st ON st.section_id = ss.section_id
       LEFT JOIN grade_scores gs 
         ON gs.item_id = gi.id AND gs.student_id = st.id
       WHERE st.id = ?
         AND ss.status = 'Active'
         AND gs.score IS NULL
       ORDER BY gi.item_date DESC`,
      [studentId]
    );

    return res.status(200).json({ missedActivities: rows });
  } catch (error) {
    console.error("Error fetching missed activities:", error);
    return res.status(500).json({ message: "Failed to fetch missed activities." });
  }
};
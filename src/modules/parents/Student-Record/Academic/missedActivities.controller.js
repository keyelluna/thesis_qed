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
   JOIN elem_students st
     ON (ss.section_id = st.section_id
         OR (ss.section_id IS NULL AND es.grade_level_id = st.grade_level_id))
   JOIN grading_periods gp ON gp.id = gi.grading_period_id
   JOIN school_year sy
     ON sy.id = gp.school_year_id
    AND sy.id = ss.school_year_id
    AND sy.is_active = 1
   LEFT JOIN grade_scores gs 
     ON gs.item_id = gi.id AND gs.student_id = st.id
   WHERE st.id = ?
     AND st.is_deleted = 0
     AND ss.status = 'Active'
     AND gs.score IS NULL
   ORDER BY gi.item_date DESC`,
      [studentId],
    );

    return res.status(200).json({ missedActivities: rows });
  } catch (error) {
    console.error("Error fetching missed activities:", error);
    return res
      .status(500)
      .json({ message: "Failed to fetch missed activities." });
  }
};

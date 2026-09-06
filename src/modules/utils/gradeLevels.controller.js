const connection = require("../../../config/db");

exports.getGradeLevels = async (req, res) => {
  try {
    const [rows] = await connection.query(
      "SELECT * FROM grade_level ORDER BY grade_level ASC;"
    );
    res.json(rows);
  } catch (error) {
    console.error("Error fetching grade levels:", error);
    res.status(500).json({ message: "Database error occurred." });
  }
};

exports.getSectionByGrade = async (req, res) => {
  const { gradeLevelId } = req.query; // Palitan natin ng id para malinaw

  if (!gradeLevelId) {
    return res
      .status(400)
      .json({ message: "Grade level ID parameter is required" });
  }

  // Gagamit tayo ng JOIN para ma-filter gamit ang ID ng grade level
  const query = `
  SELECT 
    grade_level_sections.id AS id,
    grade_level_sections.section_name AS section_name,
    grade_level_sections.grade_level_id AS grade_level_id,
    grade_level.grade_level AS grade_level
  FROM grade_level_sections
  INNER JOIN grade_level ON grade_level_sections.grade_level_id = grade_level.id 
  WHERE grade_level.id = ? 
  ORDER BY grade_level_sections.section_name ASC;
`;

  try {
    const [rows] = await connection.query(query, [gradeLevelId]);
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database query failed" });
  }
};
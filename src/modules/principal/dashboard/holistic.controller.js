const connection = require("../../../../config/db");

exports.getHolisticOverview = async (req, res) => {
  try {
    const [rows] = await connection.query(`
      SELECT hr.axis, AVG(hr.rating) AS avgRating
      FROM holistic_ratings hr
      JOIN \`subject-section\` ss ON hr.subject_section_id = ss.id
      JOIN school_year sy ON ss.school_year_id = sy.id
      JOIN elem_students st ON hr.student_id = st.id
      WHERE sy.is_active = 1
        AND st.status <> 'graduated'
        AND st.is_deleted = 0
      GROUP BY hr.axis
    `);

    const axisToDomain = {
      cognitive: "Cognitive",
      emotional: "Emotional",
      behavioral: "Behavioral",
      social: "Social",
    };

    // default lahat sa 0 kung wala pang data para consistent parin ang shape
    const domainScores = {
      Cognitive: 0,
      Emotional: 0,
      Behavioral: 0,
      Social: 0,
    };

    rows.forEach((row) => {
      const domain = axisToDomain[row.axis];
      if (domain && row.avgRating !== null) {
        domainScores[domain] = parseFloat(Number(row.avgRating).toFixed(1));
      }
    });

    const holisticDomains = Object.keys(domainScores).map((domain) => ({
      domain,
      score: domainScores[domain],
    }));

    return res.status(200).json({
      success: true,
      data: holisticDomains,
    });
  } catch (error) {
    console.error("Error fetching holistic overview:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch holistic overview",
    });
  }
};
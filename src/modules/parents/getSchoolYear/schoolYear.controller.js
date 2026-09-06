const connection = require("../../../../config/db");

// Kunin ang start ng Term 1 at end ng huling term ng active school year,
// tapos generate-in ang listahan ng months (month, year) sa pagitan nila.
exports.getStartEndTerm = async (req, res) => {
  try {
    // 1. Kunin muna ang currently active school year
    const [syRows] = await connection.query(
      `SELECT id FROM school_year WHERE is_active = 1 LIMIT 1`
    );

    if (!syRows.length) {
      return res.status(404).json({
        success: false,
        message: "No active school year found.",
      });
    }

    const schoolYearId = syRows[0].id;

    // 2. Kunin ang start_date ng Term 1 at end_date ng pinakamataas na term_number
    const [termRows] = await connection.query(
      `SELECT
         MIN(CASE WHEN term_number = 1 THEN start_date END) AS term1_start,
         MAX(end_date) AS last_term_end
       FROM grading_periods
       WHERE school_year_id = ?`,
      [schoolYearId]
    );

    const { term1_start, last_term_end } = termRows[0] || {};

    if (!term1_start || !last_term_end) {
      return res.status(404).json({
        success: false,
        message: "Grading periods are not yet configured for this school year.",
      });
    }

    const months = getMonthsBetween(term1_start, last_term_end);

    return res.status(200).json({
      success: true,
      data: {
        school_year_id: schoolYearId,
        term1_start,
        last_term_end,
        months, // [{ month: 6, year: 2026 }, { month: 7, year: 2026 }, ...]
      },
    });
  } catch (error) {
    console.error("getStartEndTerm error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch school year term range.",
    });
  }
};

/**
 * Bumuo ng listahan ng { month, year } mula start date hanggang end date, inclusive.
 * Halimbawa: 2026-06-20 hanggang 2027-04-15 -> June 2026 ... April 2027 (11 entries)
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {{month:number, year:number}[]}
 */
function getMonthsBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  const months = [];
  let year = start.getFullYear();
  let month = start.getMonth(); // 0-based

  const endYear = end.getFullYear();
  const endMonth = end.getMonth();

  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ month: month + 1, year }); // ibalik as 1-based month
    month++;
    if (month > 11) {
      month = 0;
      year++;
    }
  }

  return months;
}
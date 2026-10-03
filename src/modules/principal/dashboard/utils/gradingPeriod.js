// utils/gradingPeriod.js
const connection = require("../../../../../config/db"); 
async function getCurrentGradingPeriod() {
  const cols = `gp.id, gp.school_year_id, gp.term_number, gp.term_label, gp.start_date, gp.end_date, sy.school_year`;

  // 1. Term na pasok ngayon
  const [current] = await connection.query(
    `SELECT ${cols}
     FROM grading_periods gp
     JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1
       AND CURDATE() BETWEEN gp.start_date AND gp.end_date
     ORDER BY gp.term_number ASC
     LIMIT 1`
  );
  if (current.length) return current[0];

  // 2. Fallback: pinakahuling natapos na term
  const [lastCompleted] = await connection.query(
    `SELECT ${cols}
     FROM grading_periods gp
     JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1
       AND gp.end_date < CURDATE()
     ORDER BY gp.end_date DESC, gp.term_number DESC
     LIMIT 1`
  );
  if (lastCompleted.length) return lastCompleted[0];

  // 3. Fallback: pinakamalapit na upcoming
  const [upcoming] = await connection.query(
    `SELECT ${cols}
     FROM grading_periods gp
     JOIN school_year sy ON gp.school_year_id = sy.id
     WHERE sy.is_active = 1
       AND gp.start_date > CURDATE()
     ORDER BY gp.start_date ASC, gp.term_number ASC
     LIMIT 1`
  );
  return upcoming.length ? upcoming[0] : null;
}
module.exports = { getCurrentGradingPeriod };

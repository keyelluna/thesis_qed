const connection = require("../../../../config/db");

function deriveTermStatus(startDate, endDate) {
  const today = new Date().toISOString().slice(0, 10);
  if (today < startDate) return "Upcoming";
  if (today > endDate) return "Completed";
  return "Active";
}

async function fetchAcademicYearById(conn, id) {
  const [rows] = await conn.query(
    `SELECT sy.id, sy.school_year, sy.is_active,
            MIN(gp.start_date) AS start_date,
            MAX(gp.end_date) AS end_date
     FROM school_year sy
     LEFT JOIN grading_periods gp ON gp.school_year_id = sy.id
     WHERE sy.id = ?
     GROUP BY sy.id
     LIMIT 1`,
    [id]
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    label: row.school_year,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.is_active ? "Active" : "Inactive",
  };
}

exports.getActiveAcademicYear = async (_req, res) => {
  try {
    const [rows] = await connection.query(
      `SELECT sy.id, sy.school_year, sy.is_active,
              MIN(gp.start_date) AS start_date,
              MAX(gp.end_date) AS end_date
       FROM school_year sy
       LEFT JOIN grading_periods gp ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       GROUP BY sy.id
       LIMIT 1`
    );

    const row = rows[0];
    if (!row) {
      return res.status(404).json({
        status: "fail",
        message: "No active academic year found.",
      });
    }

    res.status(200).json({
      status: "success",
      message: "Active academic year fetched successfully.",
      data: {
        id: row.id,
        label: row.school_year,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.is_active ? "Active" : "Inactive",
      },
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({
      status: "error",
      message: "Database error occurred.",
    });
  }
};

exports.updateAcademicYear = async (req, res) => {
  const { id } = req.params;
  const { label, status } = req.body;

  if (!label || typeof label !== "string") {
    return res.status(400).json({ status: "fail", message: "'label' is required." });
  }
  if (status !== "Active" && status !== "Inactive") {
    return res.status(400).json({
      status: "fail",
      message: "'status' must be 'Active' or 'Inactive'.",
    });
  }

  const isActive = status === "Active" ? 1 : 0;
  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    if (isActive) {
      await conn.query(`UPDATE school_year SET is_active = 0 WHERE id != ?`, [id]);
    }

    const [result] = await conn.query(
      `UPDATE school_year SET school_year = ?, is_active = ? WHERE id = ?`,
      [label, isActive, id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({
        status: "fail",
        message: `No school_year row found with id ${id}.`,
      });
    }

    const updated = await fetchAcademicYearById(conn, id);
    await conn.commit();

    res.status(200).json({
      status: "success",
      message: "Academic year updated successfully.",
      data: updated,
    });
  } catch (error) {
    await conn.rollback();
    console.error("Database Error:", error);
    res.status(500).json({ status: "error", message: "Database error occurred." });
  } finally {
    conn.release();
  }
};

exports.getTermsForSchoolYear = async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await connection.query(
      `SELECT id, school_year_id, term_number, term_label, start_date, end_date, is_active
       FROM grading_periods
       WHERE school_year_id = ?
       ORDER BY term_number ASC`,
      [id]
    );

    const terms = rows.map((row) => ({
      id: row.id,
      termNumber: row.term_number,
      name: row.term_label,
      startDate: row.start_date,
      endDate: row.end_date,
      status: deriveTermStatus(row.start_date, row.end_date),
    }));

    res.status(200).json({
      status: "success",
      message: "Terms fetched successfully.",
      data: terms,
    });
  } catch (error) {
    console.error("Database Error:", error);
    res.status(500).json({ status: "error", message: "Database error occurred." });
  }
};

exports.saveTermsForSchoolYear = async (req, res) => {
  const { id } = req.params;
  const { terms } = req.body;

  if (!Array.isArray(terms) || terms.length === 0) {
    return res.status(400).json({ status: "fail", message: "'terms' must be a non-empty array." });
  }
  const invalid = terms.find(
    (t) => typeof t.termNumber !== "number" || !t.name || !t.startDate || !t.endDate
  );
  if (invalid) {
    return res.status(400).json({
      status: "fail",
      message: "Each term needs termNumber, name, startDate, and endDate.",
    });
  }

  const conn = await connection.getConnection();

  try {
    await conn.beginTransaction();

    for (const term of terms) {
      const isActive = deriveTermStatus(term.startDate, term.endDate) === "Active" ? 1 : 0;

      await conn.query(
        `INSERT INTO grading_periods
           (school_year_id, term_number, term_label, start_date, end_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           term_label = VALUES(term_label),
           start_date = VALUES(start_date),
           end_date = VALUES(end_date),
           is_active = VALUES(is_active)`,
        [id, term.termNumber, term.name, term.startDate, term.endDate, isActive]
      );
    }

    const [rows] = await conn.query(
      `SELECT id, term_number, term_label, start_date, end_date
       FROM grading_periods
       WHERE school_year_id = ?
       ORDER BY term_number ASC`,
      [id]
    );

    await conn.commit();

    const saved = rows.map((row) => ({
      id: row.id,
      termNumber: row.term_number,
      name: row.term_label,
      startDate: row.start_date,
      endDate: row.end_date,
      status: deriveTermStatus(row.start_date, row.end_date),
    }));

    res.status(200).json({
      status: "success",
      message: "Terms saved successfully.",
      data: saved,
    });
  } catch (error) {
    await conn.rollback();
    console.error("Database Error:", error);
    res.status(500).json({ status: "error", message: "Database error occurred." });
  } finally {
    conn.release();
  }
};
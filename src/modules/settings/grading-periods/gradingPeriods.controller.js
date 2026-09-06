const connection = require('../../../../config/db');

// ---------------------------------------------------------------------------
// GET /api/gradingPeriods
// Lists grading periods for the active school year.
// ---------------------------------------------------------------------------
const getGradingPeriods = async (req, res) => {
  try {
    const [rows] = await connection.execute(
      `SELECT gp.id, gp.term_number AS termNumber, gp.term_label AS termLabel,
              DATE_FORMAT(gp.start_date, '%Y-%m-%d') AS startDate,
              DATE_FORMAT(gp.end_date, '%Y-%m-%d') AS endDate,
              gp.is_active AS isActive, gp.school_year_id AS schoolYearId
       FROM grading_periods gp
       INNER JOIN school_year sy ON gp.school_year_id = sy.id
       WHERE sy.is_active = 1
       ORDER BY gp.term_number ASC`
    );

    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        ...r,
        id: String(r.id),
        schoolYearId: String(r.schoolYearId),
        isActive: !!r.isActive,
      })),
    });
  } catch (error) {
    console.error("Error fetching grading periods:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------
// POST /api/gradingPeriods
// Body: { schoolYearId, termNumber, termLabel, startDate, endDate }
// ---------------------------------------------------------------------------
const createGradingPeriod = async (req, res) => {
  try {
    const { schoolYearId, termNumber, termLabel, startDate, endDate } = req.body;

    if (!schoolYearId || !termNumber || !termLabel || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "schoolYearId, termNumber, termLabel, startDate, and endDate are required.",
      });
    }

    const [result] = await connection.execute(
      `INSERT INTO grading_periods (school_year_id, term_number, term_label, start_date, end_date, is_active)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [schoolYearId, termNumber, termLabel, startDate, endDate]
    );

    return res.status(201).json({ success: true, id: String(result.insertId) });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ success: false, message: "This term number already exists for that school year." });
    }
    console.error("Error creating grading period:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/gradingPeriods/:id
// Body: { termLabel?, startDate?, endDate? }
// ---------------------------------------------------------------------------
const updateGradingPeriod = async (req, res) => {
  try {
    const { id } = req.params;
    const { termLabel, startDate, endDate } = req.body;

    const fields = [];
    const params = [];
    if (termLabel) { fields.push("term_label = ?"); params.push(termLabel); }
    if (startDate) { fields.push("start_date = ?"); params.push(startDate); }
    if (endDate) { fields.push("end_date = ?"); params.push(endDate); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    params.push(id);
    const [result] = await connection.execute(
      `UPDATE grading_periods SET ${fields.join(", ")} WHERE id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Grading period not found." });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error updating grading period:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/gradingPeriods/:id/activate
// Sets this grading period active and deactivates the others in the same
// school year (so only one term is "current" at a time).
// ---------------------------------------------------------------------------
const activateGradingPeriod = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await connection.execute(
      `SELECT school_year_id AS schoolYearId FROM grading_periods WHERE id = ?`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Grading period not found." });
    }
    const { schoolYearId } = rows[0];

    await connection.execute(
      `UPDATE grading_periods SET is_active = 0 WHERE school_year_id = ?`,
      [schoolYearId]
    );
    await connection.execute(
      `UPDATE grading_periods SET is_active = 1 WHERE id = ?`,
      [id]
    );

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error activating grading period:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api/gradingPeriods/:id
// grade_items.grading_period_id is ON DELETE SET NULL, so this won't be
// blocked by existing grade items — they'll just lose their term tag.
// ---------------------------------------------------------------------------
const deleteGradingPeriod = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await connection.execute(
      `DELETE FROM grading_periods WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Grading period not found." });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error deleting grading period:", error);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = {
  getGradingPeriods,
  createGradingPeriod,
  updateGradingPeriod,
  activateGradingPeriod,
  deleteGradingPeriod,
};
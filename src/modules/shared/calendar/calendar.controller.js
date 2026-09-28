const connection = require("../../../../config/db");

const HOLIDAY_TYPE_MAP = {
  regular: "regular holiday",
  "regular holiday": "regular holiday",
  special_non_working: "special non-working day",
  "special non-working day": "special non-working day",
  special_working: "special working day",
  "special working day": "special working day",
};

function resolveHolidayType(input) {
  return HOLIDAY_TYPE_MAP[input] || null;
}

async function getActiveSchoolYearId() {
  const [rows] = await connection.query(
    "SELECT id FROM school_year WHERE is_active = 1 LIMIT 1"
  );
  return rows.length > 0 ? rows[0].id : null;
}

// GET /activities
exports.getAllActivities = async (req, res) => {
  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(400).json({
        success: false,
        message: "No active school year found",
      });
    }

    const [rows] = await connection.query(
      "SELECT id, title, date FROM school_calendar WHERE type = 'activity' AND school_year_id = ? ORDER BY date ASC",
      [schoolYearId]
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: row.date,
      createdBy: null,
      createdAt: null,
    }));

    return res.status(200).json({
      success: true,
      message: "Activities fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching activities:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch activities" });
  }
};

exports.getActivities = async (req, res) => {
  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(400).json({
        success: false,
        message: "No active school year found",
      });
    }

    const [rows] = await connection.query(
      "SELECT id, title, date FROM school_calendar WHERE type = 'activity' AND school_year_id = ? AND date >= CURRENT_DATE ORDER BY date ASC",
      [schoolYearId]
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: row.date,
      createdBy: null,
      createdAt: null,
    }));

    return res.status(200).json({
      success: true,
      message: "Activities fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching activities:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch activities" });
  }
};

exports.addActivities = async (req, res) => {
  try {
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "entries must be a non-empty array" });
    }

    for (const [index, item] of entries.entries()) {
      if (!item.title || !item.date) {
        return res.status(400).json({
          success: false,
          message: `Entry ${index + 1}: title and date are required`,
        });
      }
    }

    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(400).json({
        success: false,
        message: "No active school year found",
      });
    }

    const placeholders = entries.map(() => "(?, 'activity', ?, ?)").join(", ");
    const params = entries.flatMap((item) => [item.title, item.date, schoolYearId]);

    const [result] = await connection.query(
      `INSERT INTO school_calendar (title, type, date, school_year_id) VALUES ${placeholders}`,
      params
    );

    const data = entries.map((item, index) => ({
      id: result.insertId + index,
      title: item.title,
      date: item.date,
      createdBy: item.createdBy ?? null,
      createdAt: null,
    }));

    return res.status(201).json({
      success: true,
      message: "Activities added successfully",
      data,
    });
  } catch (error) {
    console.error("Error adding activities:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to add activities" });
  }
};

exports.updateActivity = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, date } = req.body;

    if (!title || !date) {
      return res
        .status(400)
        .json({ success: false, message: "Title and date are required" });
    }

    const [result] = await connection.query(
      "UPDATE school_calendar SET title = ?, date = ? WHERE id = ? AND type = 'activity'",
      [title, date, id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Activity not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Activity updated successfully" });
  } catch (error) {
    console.error("Error updating activity:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update activity" });
  }
};

exports.deleteActivity = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await connection.query(
      "DELETE FROM school_calendar WHERE id = ? AND type = 'activity'",
      [id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Activity not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Activity deleted successfully" });
  } catch (error) {
    console.error("Error deleting activity:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete activity" });
  }
};

// =======================
// HOLIDAYS
// =======================

exports.getHolidays = async (req, res) => {
  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(400).json({
        success: false,
        message: "No active school year found",
      });
    }

    const [rows] = await connection.query(
      "SELECT id, title, date, holiday_type FROM school_calendar WHERE type = 'holiday' AND school_year_id = ? AND date >= CURRENT_DATE ORDER BY date ASC",
      [schoolYearId]
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: row.date,
      type: row.holiday_type ?? null,
      createdBy: null,
      createdAt: null,
    }));

    return res.status(200).json({
      success: true,
      message: "Holidays fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching holidays:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch holidays" });
  }
};

exports.getAllHolidays = async (req, res) => {
  try {
    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(400).json({
        success: false,
        message: "No active school year found",
      });
    }

    const [rows] = await connection.query(
      "SELECT id, title, date, holiday_type FROM school_calendar WHERE type = 'holiday' AND school_year_id = ? ORDER BY date ASC",
      [schoolYearId]
    );

    const data = rows.map((row) => ({
      id: row.id,
      title: row.title,
      date: row.date,
      type: row.holiday_type ?? null,
      createdBy: null,
      createdAt: null,
    }));

    return res.status(200).json({
      success: true,
      message: "Holidays fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching holidays:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch holidays" });
  }
};

exports.addHolidays = async (req, res) => {
  try {
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "entries must be a non-empty array" });
    }

    for (const [index, item] of entries.entries()) {
      if (!item.title || !item.date || !item.holidayType) {
        return res.status(400).json({
          success: false,
          message: `Entry ${index + 1}: title, date, and holidayType are required`,
        });
      }
      if (!resolveHolidayType(item.holidayType)) {
        return res.status(400).json({
          success: false,
          message: `Entry ${index + 1}: invalid holidayType`,
        });
      }
    }

    const schoolYearId = await getActiveSchoolYearId();
    if (!schoolYearId) {
      return res.status(400).json({
        success: false,
        message: "No active school year found",
      });
    }

    const placeholders = entries.map(() => "(?, 'holiday', ?, ?, ?)").join(", ");
    const params = entries.flatMap((item) => [
      item.title,
      item.date,
      resolveHolidayType(item.holidayType),
      schoolYearId,
    ]);

    const [result] = await connection.query(
      `INSERT INTO school_calendar (title, type, date, holiday_type, school_year_id) VALUES ${placeholders}`,
      params
    );

    const data = entries.map((item, index) => ({
      id: result.insertId + index,
      title: item.title,
      date: item.date,
      type: resolveHolidayType(item.holidayType),
      createdBy: item.createdBy ?? null,
      createdAt: null,
    }));

    return res.status(201).json({
      success: true,
      message: "Holidays added successfully",
      data,
    });
  } catch (error) {
    console.error("Error adding holidays:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to add holidays" });
  }
};

exports.updateHoliday = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, date, holidayType } = req.body;

    if (!title || !date || !holidayType) {
      return res.status(400).json({
        success: false,
        message: "Title, date, and holidayType are required",
      });
    }

    const resolvedType = resolveHolidayType(holidayType);
    if (!resolvedType) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid holidayType" });
    }

    const [result] = await connection.query(
      "UPDATE school_calendar SET title = ?, date = ?, holiday_type = ? WHERE id = ? AND type = 'holiday'",
      [title, date, resolvedType, id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Holiday not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Holiday updated successfully" });
  } catch (error) {
    console.error("Error updating holiday:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update holiday" });
  }
};

exports.deleteHoliday = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await connection.query(
      "DELETE FROM school_calendar WHERE id = ? AND type = 'holiday'",
      [id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Holiday not found" });
    }

    return res
      .status(200)
      .json({ success: true, message: "Holiday deleted successfully" });
  } catch (error) {
    console.error("Error deleting holiday:", error);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete holiday" });
  }
};
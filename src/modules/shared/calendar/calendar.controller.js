const connection = require("../../../../config/db");

// ==========================================================
// Holiday type mapping
// ==========================================================
// AKTWAL na ENUM values sa `holiday_type` column ng DB:
//   'regular holiday' | 'special non-working day' | 'special working day'
//
// Ang frontend (calendar.service.ts) ay pwedeng magpadala ng SHORT codes
// (hal. "regular" bilang default), kaya nag-mamap tayo papunta sa
// tamang DB string bago mag-INSERT/UPDATE.
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

// Walang created_by / created_at column sa table, kaya null na lang
// palagi ang ibabalik natin para dito sa response (para tugma pa rin
// sa DTO shape na inaasahan ng frontend).

// =======================
// ACTIVITIES
// =======================

// GET /activities
exports.getActivities = async (req, res) => {
  try {
    const [rows] = await connection.query(
      "SELECT id, title, date FROM school_calendar WHERE type = 'activity' ORDER BY date ASC"
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

// POST /activities/add
// Body: { entries: [{ title, date, createdBy }, ...] }
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

    // Manual placeholder build (hindi natin ginagamit ang "VALUES ?" bulk
    // syntax dahil hindi ito supported sa prepared statements / execute())
    const placeholders = entries.map(() => "(?, 'activity', ?)").join(", ");
    const params = entries.flatMap((item) => [item.title, item.date]);

    const [result] = await connection.query(
      `INSERT INTO school_calendar (title, type, date) VALUES ${placeholders}`,
      params
    );

    // Ang mga bagong ID ay sunod-sunod simula sa insertId (gumagana ito
    // dahil iisang INSERT statement lang ang ginamit para sa lahat ng rows)
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

// PUT /activities/:id
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

// DELETE /activities/:id
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

// GET /holidays
exports.getHolidays = async (req, res) => {
  try {
    const [rows] = await connection.query(
      "SELECT id, title, date, holiday_type FROM school_calendar WHERE type = 'holiday' ORDER BY date ASC"
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

// POST /holidays/add
// Body: { entries: [{ title, date, holidayType, createdBy }, ...] }
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

    // Manual placeholder build (hindi natin ginagamit ang "VALUES ?" bulk
    // syntax dahil hindi ito supported sa prepared statements / execute())
    const placeholders = entries.map(() => "(?, 'holiday', ?, ?)").join(", ");
    const params = entries.flatMap((item) => [
      item.title,
      item.date,
      resolveHolidayType(item.holidayType),
    ]);

    const [result] = await connection.query(
      `INSERT INTO school_calendar (title, type, date, holiday_type) VALUES ${placeholders}`,
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

// PUT /holidays/:id
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

// DELETE /holidays/:id
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
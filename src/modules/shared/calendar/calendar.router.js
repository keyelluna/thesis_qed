const express = require("express");
const router = express.Router();
const calendarController = require("./calendar.controller");
const verifyToken = require("../../authentication/authentication.middleware");

function requireCalendarManager(req, res, next) {
  const role = typeof req.user?.role === "string" ? req.user.role.toUpperCase() : "";
  if (role !== "ADMIN" && role !== "PRINCIPAL") {
    return res.status(403).json({ success: false, message: "Calendar management requires Admin or Principal access." });
  }
  next();
}

// Activities
router.get("/activities", calendarController.getActivities);
router.get("/all-activities", calendarController.getAllActivities);
router.post("/activities", verifyToken, requireCalendarManager, calendarController.addActivities);
router.put("/activities/:id", verifyToken, requireCalendarManager, calendarController.updateActivity);
router.delete("/activities/:id", verifyToken, requireCalendarManager, calendarController.deleteActivity);

// Holidays
router.get("/holidays", calendarController.getHolidays);
router.get("/all-holidays", calendarController.getAllHolidays);
router.post("/holidays", verifyToken, requireCalendarManager, calendarController.addHolidays);
router.put("/holidays/:id", verifyToken, requireCalendarManager, calendarController.updateHoliday);
router.delete("/holidays/:id", verifyToken, requireCalendarManager, calendarController.deleteHoliday);

module.exports = router;

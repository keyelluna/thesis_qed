const express = require("express");
const router = express.Router();
const calendarController = require("./calendar.controller");

// Activities
router.get("/activities", calendarController.getActivities);
router.post("/activities", calendarController.addActivities);
router.put("/activities/:id", calendarController.updateActivity);
router.delete("/activities/:id", calendarController.deleteActivity);

// Holidays
router.get("/holidays", calendarController.getHolidays);
router.post("/holidays", calendarController.addHolidays);
router.put("/holidays/:id", calendarController.updateHoliday);
router.delete("/holidays/:id", calendarController.deleteHoliday);

module.exports = router;
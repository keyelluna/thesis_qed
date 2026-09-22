const express = require("express");
const router = express.Router();

const {
  getDashboardSummary,
  getDashboardStats,
  getAttendanceSummary,
  getUpcomingEvents,
} = require("./teacherDashboard.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/summary", verifyToken, getDashboardSummary);
router.get("/stats", verifyToken, getDashboardStats);
router.get("/attendance", verifyToken, getAttendanceSummary);
router.get("/upcoming", verifyToken, getUpcomingEvents);

module.exports = router;

// attendance.router.js
const express = require("express");
const router = express.Router();

const AttendanceController = require("./attendance.controller");
const verifyToken = require("../../../authentication/optionalAuth.middleware");

router.get("/my-children", verifyToken, AttendanceController.getMyChildren);
router.get(
  "/summary/:studentId",
  verifyToken,
  AttendanceController.getAttendanceSummary,
);

module.exports = router;

const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const attendanceController = require("./attendance.controller");

router.get("/", verifyToken, attendanceController.getMonthlyAttendance);

module.exports = router;

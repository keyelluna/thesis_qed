const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const principaldashboardController = require("./dashboard.controller");

router.get("/getTodaysAttendance", principaldashboardController.getTodaysAttendance);
router.get("/getAttendanceByGrade", principaldashboardController.getAttendanceByGrade);

module.exports = router;
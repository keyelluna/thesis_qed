// attendance.router.js
const express = require("express");
const router = express.Router();

const AttendanceController = require("./attendance.controller");
const verifyToken = require("../../../authentication/authentication.middleware");
const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get("/my-children", AttendanceController.getMyChildren);
router.get(
  "/summary/:studentId",
  AttendanceController.getAttendanceSummary,
);

module.exports = router;

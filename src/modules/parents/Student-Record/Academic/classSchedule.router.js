const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/optionalAuth.middleware");
const classScheduleController = require("./classSchedule.controller");

router.get(
  "/:studentId",
  verifyToken,
  classScheduleController.getClassSchedule,
);

module.exports = router;

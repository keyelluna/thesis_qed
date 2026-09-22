const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const weeklyHolisticController = require("./weeklyHolistic.controller");

router.get(
  "/students/:studentId",
  verifyToken,
  weeklyHolisticController.loadParentStudent,
);
router.get(
  "/students/:studentId",
  verifyToken,
  weeklyHolisticController.getStudentWeeklyEvaluation,
);

module.exports = router;

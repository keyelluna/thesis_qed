const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const weeklyHolisticController = require("./weeklyHolistic.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/students/:studentId",
  weeklyHolisticController.loadParentStudent,
);
router.get(
  "/students/:studentId",
  weeklyHolisticController.getStudentWeeklyEvaluation,
);

module.exports = router;

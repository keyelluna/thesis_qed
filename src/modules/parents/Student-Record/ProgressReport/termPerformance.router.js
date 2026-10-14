const express = require("express");
const router = express.Router();
// const verifyToken = require("../../../authentication/authentication.middleware");
const verifyToken = require("../../../authentication/authentication.middleware");
const termPerformanceController = require("./termPerformance.controller");
const progressVisibilityController = require("./progressVisibility.controller");
const { requireStudentIdentity } = require('../../../admin/student-record/studentRecord.authorization');
router.use(verifyToken, requireStudentIdentity);

router.get(
  "/:studentId/term-performance",
  termPerformanceController.verifyStudentAccess,
);
router.get(
  "/:studentId/term-performance",
  termPerformanceController.getTermPerformance,
);

router.get(
  "/:studentId/term-performance",
  progressVisibilityController.getStudentTermPerformance,
);
router.get(
  "/:studentId/visibility",
  termPerformanceController.verifyStudentAccess,
  progressVisibilityController.getVisibilityStatus,
);

module.exports = router;

// router is in termPerformace.js

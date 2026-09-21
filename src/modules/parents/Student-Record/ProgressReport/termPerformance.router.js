const express = require("express");
const router = express.Router();
// const verifyToken = require("../../../authentication/authentication.middleware");
const verifyToken = require("../../../authentication/optionalAuth.middleware");
const termPerformanceController = require("./termPerformance.controller");
const progressVisibilityController = require("./progressVisibility.controller");

router.get(
  "/:studentId/term-performance",
  verifyToken,
  termPerformanceController.verifyStudentAccess,
);
router.get(
  "/:studentId/term-performance",
  verifyToken,
  termPerformanceController.getTermPerformance,
);

router.get(
  "/:studentId/term-performance",
  verifyToken,
  progressVisibilityController.getStudentTermPerformance,
);
router.get(
  "/:studentId/visibility",
  verifyToken,
  progressVisibilityController.getVisibilityStatus,
);

module.exports = router;

// router is in termPerformace.js

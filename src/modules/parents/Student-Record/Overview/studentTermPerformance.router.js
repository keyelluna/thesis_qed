const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const studentTermPerformanceController = require("./studentTermPerformance.controller");

router.get(
  "/students/:studentId/term-performance",
  verifyToken,
  studentTermPerformanceController.loadParentStudent,
);

router.get(
  "/students/:studentId/term-performance",
  verifyToken,
  studentTermPerformanceController.getStudentTermPerformance,
);

module.exports = router;

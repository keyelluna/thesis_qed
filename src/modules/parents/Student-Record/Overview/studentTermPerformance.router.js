const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const studentTermPerformanceController = require("./studentTermPerformance.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/students/:studentId/term-performance",
  studentTermPerformanceController.loadParentStudent,
);

router.get(
  "/students/:studentId/term-performance",
  studentTermPerformanceController.getStudentTermPerformance,
);

module.exports = router;

const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const gradesheetController = require("./gradesheet.controller");

router.get("/section-grade", verifyToken, gradesheetController.getSectionGrade);
router.get("/", verifyToken, gradesheetController.getPrincipalSectionGradebook);
router.get("/grading-period", verifyToken, gradesheetController.getGradingPeriods);

module.exports = router;

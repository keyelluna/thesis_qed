const express = require("express");
const router = express.Router();
const gradesheetController = require("./gradesheet.controller");

router.get("/section-grade", gradesheetController.getSectionGrade);
router.get("/", gradesheetController.getPrincipalSectionGradebook);
router.get("/grading-period", gradesheetController.getGradingPeriods);

module.exports = router;

const express = require("express");
const router = express.Router();
// const verifyToken = require("../../authentication/authentication.middleware");
const overviewController = require("./overviewCard.controller");
const attendanceController = require("./attendance.controller");
const subjectPerformanceController = require("./subjectPerformance.controller");
const holisticOverviewController = require("./holistic.controller");
const academicPerformanceController = require("./academicPerformance.controller");

router.get("/attendanceRate", overviewController.getOverviewAttendance);
router.get("/getTodaysAttendance", attendanceController.getTodaysAttendance);
router.get("/getAttendanceByGrade", attendanceController.getAttendanceByGrade);
router.get(
  "/topSubjectPerGrade",
  subjectPerformanceController.getTopSubjectPerGrade,
);
router.get(
  "/subjectRankingByTerm",
  subjectPerformanceController.getSubjectRankingByTerm,
);
router.get(
  "/academicPerformance",
  overviewController.getSchoolWideAcademicPerformance,
);
router.get("/holisticDomain", holisticOverviewController.getHolisticOverview);
router.get(
  "/performanceByGrade",
  academicPerformanceController.getPerformanceByGrade,
);
router.get(
  "/performanceTrend",
  academicPerformanceController.getPerformanceTrend,
);

router.get("/active-term", academicPerformanceController.getActiveTerm);
module.exports = router;

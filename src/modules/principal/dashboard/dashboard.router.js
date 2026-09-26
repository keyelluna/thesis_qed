const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const overviewController = require("./overviewCard.controller");
const attendanceController = require("./attendance.controller");
const subjectPerformanceController = require("./subjectPerformance.controller");
const holisticOverviewController = require("./holistic.controller");
const academicPerformanceController = require("./academicPerformance.controller");

router.get("/attendanceRate", overviewController.getOverviewAttendance);
router.get("/getTodaysAttendance", attendanceController.getTodaysAttendance);
router.get("/getAttendanceByGrade", attendanceController.getAttendanceByGrade);
router.get(
  "/topSubjectPerGrade", verifyToken,
  subjectPerformanceController.getTopSubjectPerGrade,
);
router.get(
  "/subjectRankingByTerm", verifyToken,
  subjectPerformanceController.getSubjectRankingByTerm,
);
router.get(
  "/academicPerformance", verifyToken,
  overviewController.getSchoolWideAcademicPerformance,
);
router.get("/holisticDomain", verifyToken, holisticOverviewController.getHolisticOverview);
router.get(
  "/performanceByGrade", verifyToken,
  academicPerformanceController.getPerformanceByGrade,
);
router.get(
  "/performanceTrend", verifyToken,
  academicPerformanceController.getPerformanceTrend,
);

router.get("/active-term", verifyToken, academicPerformanceController.getActiveTerm);
module.exports = router;

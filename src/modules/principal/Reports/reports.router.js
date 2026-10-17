const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const reportsController = require("./reports.controller");
const requireSchoolRead = require("../requireSchoolRead.middleware");

router.use(verifyToken, requireSchoolRead);
router.get('/examination-performance', require('./examinationAnalytics.controller').getExaminationAnalytics);

router.get("/term-options", reportsController.getTermOptions);
router.get(
  "/subject-ranking",
  reportsController.getSubjectRanking,
);
router.get("/grade-options", reportsController.getGradeOptions);
router.get("/holistic", reportsController.getHolisticRows);
router.get("/view-options", reportsController.getViewOptions);

module.exports = router;

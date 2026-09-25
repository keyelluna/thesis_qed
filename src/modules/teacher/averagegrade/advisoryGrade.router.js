const express = require("express");
const router = express.Router();

const {
  loadAdvisorySections,
  getAdvisorySections,
  getAdvisoryGradebook,
  getSubmissionStatus,
  submitAdvisoryGrades,
  getGradeVisibility,
  setGradeVisibility,
} = require("./advisoryGrade.controller");

const verifyToken = require("../../authentication/authentication.middleware");

router.get("/sections", verifyToken, loadAdvisorySections, getAdvisorySections);
router.get("/gradebook", verifyToken, loadAdvisorySections, getAdvisoryGradebook);
router.get("/submission", verifyToken, loadAdvisorySections, getSubmissionStatus);
router.post("/submission", verifyToken, loadAdvisorySections, submitAdvisoryGrades);
router.get("/visibility", verifyToken, loadAdvisorySections, getGradeVisibility);
router.post("/visibility", verifyToken, loadAdvisorySections, setGradeVisibility);

module.exports = router;
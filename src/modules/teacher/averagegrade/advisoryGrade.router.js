const express = require("express");
const router = express.Router();

const {
  loadAdvisorySection,
  getAdvisoryGradebook,
  getSubmissionStatus,
  submitAdvisoryGrades,
  getGradeVisibility,
  setGradeVisibility,
} = require("./advisoryGrade.controller.js");
const verifyToken = require("../../authentication/authentication.middleware.js");

router.get(
  "/gradebook",
  verifyToken,
  loadAdvisorySection,
  getAdvisoryGradebook,
);
router.get(
  "/submission",
  verifyToken,
  loadAdvisorySection,
  getSubmissionStatus,
);
router.post(
  "/submission",
  verifyToken,
  loadAdvisorySection,
  submitAdvisoryGrades,
);

router.get("/visibility", verifyToken, loadAdvisorySection, getGradeVisibility);
router.post(
  "/visibility",
  verifyToken,
  loadAdvisorySection,
  setGradeVisibility,
);

module.exports = router;

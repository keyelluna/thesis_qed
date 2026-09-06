const express = require("express");
const router = express.Router();

const {
  loadAdvisorySection,
  getAdvisoryGradebook,
  getSubmissionStatus,
  submitAdvisoryGrades,
} = require("./advisoryGrade.controller.js");
const verifyToken = require("../../authentication/authentication.middleware");

router.get('/gradebook', verifyToken, loadAdvisorySection, getAdvisoryGradebook);
router.get('/submission', verifyToken, loadAdvisorySection, getSubmissionStatus);
router.post('/submission', verifyToken, loadAdvisorySection, submitAdvisoryGrades);

module.exports = router;
const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/optionalAuth.middleware");
const reportsController = require("./reports.controller");

router.get("/term-options", verifyToken, reportsController.getTermOptions);
router.get(
  "/subject-ranking",
  verifyToken,
  reportsController.getSubjectRanking,
);
router.get("/grade-options", verifyToken, reportsController.getGradeOptions);
router.get("/holistic", verifyToken, reportsController.getHolisticRows);
router.get("/view-options", verifyToken, reportsController.getViewOptions);

module.exports = router;

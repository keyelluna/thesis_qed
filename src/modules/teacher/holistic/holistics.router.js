const express = require("express");
const router = express.Router();

const controller = require("./holistics.controller");
const verifyToken = require("../../authentication/authentication.middleware");
const { requireTeacherStudentIdentity } = require('../../admin/student-record/studentRecord.authorization');

router.get("/overview", verifyToken, controller.getHolisticOverview);
router.get("/domain-trends", verifyToken, controller.getDomainTrends); // new
router.get(
  "/profile/:studentId",
  verifyToken,
  requireTeacherStudentIdentity,
  controller.getStudentHolisticProfile,
);

router.get(
  "/:subjectSectionId",
  verifyToken,
  controller.loadSubjectSection,
  controller.getHolistic,
);
router.put(
  "/:subjectSectionId",
  verifyToken,
  controller.loadSubjectSection,
  controller.upsertHolistic,
);

module.exports = router;

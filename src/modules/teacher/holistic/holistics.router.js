const express = require("express");
const router = express.Router();

const controller = require("./holistics.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/overview", verifyToken, controller.getHolisticOverview);
router.get("/profile/:studentId", verifyToken, controller.getStudentHolisticProfile);

router.get("/:subjectSectionId", verifyToken, controller.loadSubjectSection, controller.getHolistic);
router.put("/:subjectSectionId", verifyToken, controller.loadSubjectSection, controller.upsertHolistic);

module.exports = router;
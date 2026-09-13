const express = require("express");
const router = express.Router();

const controller = require("./advisoryAttendance.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/advisory-section", verifyToken, controller.loadAdvisorySection, controller.getAdvisorySectionInfo);
router.get("/:classId", verifyToken, controller.loadAdvisorySection, controller.getAdvisoryAttendance);
router.post("/:classId", verifyToken, controller.loadAdvisorySection, controller.upsertAdvisoryAttendance);

module.exports = router;
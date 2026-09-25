const express = require("express");
const router = express.Router();

const controller = require("./advisoryAttendance.controller");
const verifyToken = require("../../authentication/authentication.middleware");

// Must come before "/:classId" or Express will match this path as a classId.
router.get(
  "/advisory-sections",
  verifyToken,
  controller.loadAdvisoryClasses,
  controller.getAdvisorySectionsList,
);

router.get(
  "/:classId",
  verifyToken,
  controller.loadAdvisoryClasses,
  controller.requireOwnedClass,
  controller.getAdvisoryAttendance,
);

router.post(
  "/:classId",
  verifyToken,
  controller.loadAdvisoryClasses,
  controller.requireOwnedClass,
  controller.upsertAdvisoryAttendance,
);

module.exports = router;
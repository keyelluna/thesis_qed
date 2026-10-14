const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const classScheduleController = require("./classSchedule.controller");
const { requireLinkedChild } = require('../../parentAccess.middleware');

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/:studentId",
  requireLinkedChild,
  classScheduleController.getClassSchedule,
);

module.exports = router;

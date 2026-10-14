const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const { requireLinkedChild } = require('../../parentAccess.middleware');
const missedActivitiesController = require("./missedActivities.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/:studentId",
  requireLinkedChild,
  missedActivitiesController.getMissedActivities,
);

module.exports = router;

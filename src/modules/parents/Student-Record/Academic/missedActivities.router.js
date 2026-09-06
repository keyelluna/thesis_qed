const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const missedActivitiesController = require("./missedActivities.controller");

router.get("/:studentId", verifyToken, missedActivitiesController.getMissedActivities);


module.exports = router;


const express = require("express");
const router = express.Router();
// const verifyToken = require("../../authentication/authentication.middleware");
const verifyToken = require("../../authentication/optionalAuth.middleware");
const dailyUpdateController = require("./dailyUpdate.controller");

router.get("/parent", verifyToken, dailyUpdateController.getDailyUpdatesForParent);
router.get("/:studentId", verifyToken, dailyUpdateController.getDailyUpdate);

module.exports = router;
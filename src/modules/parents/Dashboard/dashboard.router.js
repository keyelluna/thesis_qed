const express = require("express");
const router = express.Router();
// const verifyToken = require("../../authentication/authentication.middleware");
const verifyToken = require("../../authentication/authentication.middleware");
const dailyUpdateController = require("./dailyUpdate.controller");

const { requireParent } = require('../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/parent",
  dailyUpdateController.getDailyUpdatesForParent,
);
router.get("/:studentId", dailyUpdateController.getDailyUpdate);

module.exports = router;

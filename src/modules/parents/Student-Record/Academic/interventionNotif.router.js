const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const lowGradeTopicsController = require("./interventionNotif.controller");

router.get(
  "/:studentId",
  verifyToken,
  lowGradeTopicsController.getLowGradeTopics,
);

module.exports = router;

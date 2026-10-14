const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const lowGradeTopicsController = require("./interventionNotif.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/:studentId",
  lowGradeTopicsController.getLowGradeTopics,
);

module.exports = router;

const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const holisticController = require("./holisticPerformance.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/:studentId",
  holisticController.loadParentStudent,
  holisticController.getStudentTermAverages,
);

module.exports = router;

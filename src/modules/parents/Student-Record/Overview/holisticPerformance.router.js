const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/optionalAuth.middleware");
const holisticController = require("./holisticPerformance.controller");

router.get(
  "/:studentId",
  verifyToken,
  holisticController.loadParentStudent,
  holisticController.getStudentTermAverages,
);

module.exports = router;

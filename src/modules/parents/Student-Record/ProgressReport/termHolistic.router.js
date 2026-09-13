const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/optionalAuth.middleware");
const termHolisticController = require("./termHolistic.controller");

router.get(
  "/:studentId",
  verifyToken,
  termHolisticController.loadParentStudent,
  termHolisticController.getStudentTermAverages,
);

module.exports = router;

const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const termHolisticController = require("./termHolistic.controller");

const { requireParent } = require('../../parentAccess.middleware');
router.use(verifyToken, requireParent);

router.get(
  "/:studentId",
  termHolisticController.loadParentStudent,
  termHolisticController.getStudentTermAverages,
);

module.exports = router;

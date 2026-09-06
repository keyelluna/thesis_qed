
const express = require("express");
const router = express.Router();
const verifyToken = require("../../../authentication/authentication.middleware");
const studentProfilesController = require("./studentProfiles.controller");

router.get("/:studentId", verifyToken, studentProfilesController.getStudentProfile);
router.put("/:studentId", verifyToken, studentProfilesController.updateStudentProfile);

module.exports = router;
const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const studentController = require("./students.controller");


router.get("/grade-levels", verifyToken, studentController.getGradeLevels);
router.get("/class-list/:classId", verifyToken, studentController.getClassList);
router.get("/grade/:gradeId/unassigned", verifyToken, studentController.getUnassignedClassList);

module.exports = router;


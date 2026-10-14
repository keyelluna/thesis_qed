const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const studentController = require("./students.controller");
const requireSchoolRead = require("../requireSchoolRead.middleware");

router.use(verifyToken, requireSchoolRead);


router.get("/grade-levels", studentController.getGradeLevels);
router.get("/total-student", studentController.getTotalStudents);
router.get("/class-list/:classId", studentController.getClassList);
router.get("/grade/:gradeId/unassigned", studentController.getUnassignedClassList);

module.exports = router;


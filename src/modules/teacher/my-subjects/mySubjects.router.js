const express = require("express");
const router = express.Router();
const mySubjectsController = require("./mySubjects.controller");
const verifyToken = require("../../authentication/authentication.middleware");

router.get("/subjects", verifyToken, mySubjectsController.getAssignedSubjects);
router.get('/subjects/:subjectSectionId/students', verifyToken, mySubjectsController.getSubjectClassList);

module.exports = router;
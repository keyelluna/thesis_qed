const express = require("express");
const router = express.Router();
const verifyToken = require("../../authentication/authentication.middleware");
const teacherController = require("./teachers.controller");
const requireSchoolRead = require("../requireSchoolRead.middleware");

router.use(verifyToken, requireSchoolRead);


router.get("/", teacherController.getTeachersDirectory);
router.get("/:id", teacherController.getTeacherProfile);

module.exports = router;


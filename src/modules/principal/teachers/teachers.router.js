const express = require("express");
const router = express.Router();
// const verifyToken = require("../../authentication/authentication.middleware");
const teacherController = require("./teachers.controller");


router.get("/", teacherController.getTeachersDirectory);
router.get("/:id", teacherController.getTeacherProfile);

module.exports = router;


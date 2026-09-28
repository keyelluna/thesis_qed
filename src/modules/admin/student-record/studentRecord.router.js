const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const studentRecord = require("./studentRecord.controller");

router.post("/addNewStudent", verifyToken, studentRecord.addNewStudent);
router.put("/updateStudent/:id", verifyToken, studentRecord.updateStudent);
router.get("/viewStudent/:id", verifyToken, studentRecord.getStudentById);
router.get('/totalStudents', verifyToken, studentRecord.getTotalStudents);
router.get('/allStudents', verifyToken, studentRecord.getAllStudents);
router.get('/allGrade', verifyToken, studentRecord.getAllGrade);
router.put("/deleteStudent/:id", verifyToken, studentRecord.softDeleteStudent);

module.exports = router;

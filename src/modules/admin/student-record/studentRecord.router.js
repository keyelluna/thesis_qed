const express = require("express");
const router = express.Router();
const verifyToken = require('../../authentication/authentication.middleware');
const studentRecord = require("./studentRecord.controller");
const requireAdmin = require('../../authentication/requireAdmin.middleware');
const { requireStudentIdentity } = require('./studentRecord.authorization');

router.use(verifyToken, requireStudentIdentity);

router.post("/addNewStudent", requireAdmin, studentRecord.addNewStudent);
router.put("/updateStudent/:id", requireAdmin, studentRecord.updateStudent);
router.get("/viewStudent/:id", studentRecord.getStudentById);
router.get('/totalStudents', studentRecord.getTotalStudents);
router.get('/allStudents', studentRecord.getAllStudents);
router.get('/allGrade', studentRecord.getAllGrade);
router.put("/deleteStudent/:id", requireAdmin, studentRecord.softDeleteStudent);

module.exports = router;
